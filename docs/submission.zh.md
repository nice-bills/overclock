# Overclock：X Layer Build X · TapeOut Accelerate 参赛说明

英文原版见 [submission.md](submission.md)。本文按报名表的字段顺序作答，每个数字都链接到主网交易或本仓库中的文件。

## 项目

**名称：** Overclock

**一句话介绍：** 运行一个区块装不下的 TapeOut 电路，包括带内存的 CPU 和游戏。谁在结果上作假，都会被 X Layer 上的单门检查抓住，并失去保证金。

**链接**

| | |
|---|---|
| 代码仓库 | https://github.com/nice-bills/overclock |
| Overclock 合约（X Layer，链 ID 196） | [`0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710`](https://www.oklink.com/x-layer/address/0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710) |
| Processor 地址 | [`0xb00f10bb4b2f32c561bf90e205e543d0a2395971`](https://www.oklink.com/x-layer/address/0xb00f10bb4b2f32c561bf90e205e543d0a2395971) |
| 电路 ID | 上述 processor 上：#4，生命游戏单元规则（57 个门）· #5，8×8 棋盘（64 个指向 #4 的 REF，每代 3,712 个门）· #6，4 位 CPU（1,437 个门，205 个 LATCH 位）。AlephTape 的 processor [`0xb00e17789f905234f1890c22e6c01015c10d2f54`](https://www.oklink.com/x-layer/address/0xb00e17789f905234f1890c22e6c01015c10d2f54) 上：#11，他们的手写数字识别网络（161,080 个门） |
| 全部主网交易 | [docs/mainnet-run.md](mainnet-run.md)（生命游戏），[docs/headline-demos.md](headline-demos.md)（CPU 与数字识别网络） |
| 访问链接 | https://overclock-board.onrender.com（首页） |
| 实时任务看板 | https://overclock-board.onrender.com/#board：直接从合约读取主网上的每个任务、声明和争议 |
| 用你自己的电路试试 | https://overclock-board.onrender.com/#try：载入主网上任意一个电路，在浏览器里运行，用 TapeOut 自己的 `eval`/`step` 核对第 1 拍，并对比直接上链和通过 Overclock 的成本。无需钱包 |
| 主网回放 | https://overclock-board.onrender.com/#replay：逐步回放 0 号任务，从第 25 代的作假一直到证明它的那一个门 |
| AI 智能体接入 | `/plugin install overclock --marketplace nice-bills/overclock`（Claude Code），或通过 stdio / HTTP 使用 MCP 服务器 |
| 演示视频 | 待补充 |

## 产品

TapeOut 的 `eval` 和 `step` 在一笔交易内逐门运行电路。每个门约 2.5K gas，一个区块上限 2.1 亿 gas，所以链上能直接运行的电路大约不超过 80,000 个门；需要运行很多拍的机器，远没到这个规模就已经放不下了。我们的 8×8 生命游戏棋盘跑 40 代，用 TapeOut 自己的 `step()` 需要 **441,085,640 gas**，超过两个满区块，根本发不出去。

Overclock 照样能跑，方式和 Optimistic Rollup 运行交易一样：

1. 任何人都可以**发布任务**：指定一个已流片的电路、输入和初始状态、运行拍数，并附上费用。
2. 运营者用逐位精确的 TAP-02 求值器在链下运行，然后附上保证金**声明**结果，同时提交一个覆盖本次运行中每根导线取值的 Merkle 根。
3. 任何人都可以免费重跑。如果声明有误，监督者通过**二分**把执行轨迹缩小到第一根出错的导线。
4. 合约**只检查那一个门**：从 TapeOut 链上的网表读取该门，用 Merkle 证明读取它的输入，计算一次 NAND（或一次 LATCH 读写、一次 REF 输入输出）。作假者的保证金归监督者。
5. 无人挑战的结果会**最终确认**，任何合约都可以读取结果或接收回调。

**主网实测**，全部使用真实的 TapeOut 合约：

| | Gas | 交易 |
|---|---:|---|
| 用 `step()` 直接运行棋盘 | 441,085,640 | 无法发送 |
| Overclock，无人作假：声明 + 确认 | 182,011 | [声明](https://www.oklink.com/x-layer/tx/0x75779e7f684c3fbe11cd3b68142e726149da990d283c438fb528e784abcd66c9)，[确认](https://www.oklink.com/x-layer/tx/0x2c45bc0c13bf1a3c2234c98d1fa1665482c6ece5cb55e8b2bc57e50035a863c6) |
| 作假者在 181,840 步中篡改一个 NAND：整场争议共 38 笔交易 | 2,433,720 | 从[挑战](https://www.oklink.com/x-layer/tx/0x942b7927db797ff55d6d67dbc2a57b2a3fbe99616123c0bb704df9abac8550b5)开始 |
| 证明作假的单步检查 | 347,509 | [resolveLeaf](https://www.oklink.com/x-layer/tx/0xa4fbe532791e6220310618304ce7f4f908a80411a887986984e0c7819a2a0bff) |

从 `Overclock.result(0)` 读回的最终棋盘与独立模拟的结果一致。

**两台主打机器也以同样方式在主网运行过**，每台都有一次作假在单个 NAND 上被抓住，并有一个诚实结果被确认（[docs/headline-demos.md](headline-demos.md)）：

| | 直接通过 TapeOut | Overclock，诚实路径 | 结果 |
|---|---:|---:|---|
| 4 位 CPU 运行 8 位斐波那契程序 10,000 拍（2 号任务） | 343 亿 gas，163 个区块 | [816,083 gas](https://www.oklink.com/x-layer/tx/0xf9e3738e5cc9ce905197526b755579d2da0d416b6ba07d5cdbe0a717bfd2ea6d)，少 42,003 倍 | F(625) mod 256 = 161，F(626) mod 256 = 225，与参考模拟器一致 |
| AlephTape 的 16.1 万门手写数字识别网络，上届获奖电路原样运行（1 号任务） | 3.88 亿 gas，1.85 个区块 | [2,244,073 gas](https://www.oklink.com/x-layer/tx/0xcf992d6a5af2c575b2efa5c205bcae232413121a6e1ecc02230025a2d4021848)，少 173 倍 | 识别为 7（作假者声称是 9） |

CPU 把程序存放在 LATCH 状态里，所以换一段代码只是一个新任务，不需要重新流片。对于数字识别网络，AlephTape 的零知识验证更便宜（297K gas），因为他们已经为它做过可信设置仪式。Overclock 对任何电路都不需要仪式，而且能处理像 CPU 这样有状态的机器，这正是零知识路线目前不支持的。我们的求值器还与 TapeOut 线上的 `eval`/`step` 在 86 个主网电路上逐一比对，688 个样本全部一致（[docs/live-check.json](live-check.json)）。

**为什么必须是 TapeOut。** 欺诈证明需要一个合约能重新执行的"单步"。对 EVM 来说，这花了 Arbitrum 和 Optimism 多年时间。TapeOut 电路由 NAND 门构成，语义逐字节公开、存储在链上且永不改变，所以一个门*就是*那一步。任何流片过的电路，一出现就能以任意规模运行，不需要仪式或重新编译。REF 让嵌套电路变成嵌套争议，LATCH 状态把一拍拍串起来，这正是零知识路线目前处理不了的有状态场景。

**为什么必须上链。** 核心是让陌生人信任一个不是自己算出来的结果，而 X Layer 上的保证金和罚没机制让这件事变得安全。

## 目标用户与触达方式

1. **机器构建者**：电路已经超出一个区块的团队，比如链上 CPU、带内存的游戏、有状态的电路 AI。他们用已经流片的电路，两笔交易就能运行任意拍数。
2. **使用电路结果的合约和应用**，比如游戏、评分和结算。它们读取 `result(jobId)` 或接收 `onOverclockResult` 回调（`contracts/Machine.sol` 是一个每次推进一个任务的可运行示例）。
3. **运营者和监督者**：手上有闲置机器的矿工和节点运营者。诚实声明赚任务费，抓到作假者赚对方的保证金。两个机器人都内置在命令行工具里。
4. **AI 智能体**，通过 MCP 服务器和 Claude Code 插件：在依赖某个结果之前先验证它、购买算力，或作为有保证金的运营者或监督者运行。

**有多少这样的用户。** 我们读取了主网上全部 397 个处理器的每一个电路（[docs/census.md](census.md)，`scripts/census.js`）：共 11,074 个电路。其中 7 个大到一个区块连一次都跑不完（都属于 AlephTape），1,754 台状态机里有 1,014 台在一个区块内跑不满 1,000 拍。这些电路由 213 个钱包持有，其中 996 个在两个 FAB-Genisis 处理器上，另有 LoteGate（每区块 17 拍）、Covenant（44 拍）等。

**如何触达。** 普查列出了处理器和持有者，所以第一批用户可以点名联系，并附上一个在我们网站上运行他们自己电路、显示成本的链接：AlephTape（我们已经在主网上运行了他们的数字识别网络）、FAB-Genisis 与 FabX 的 Gate Challenge 社区、LoteGate 和 Covenant，以及 TapeOut 和 X Layer 的开发者 Telegram 群。之后是 Demo Day、11 月 18 日 DevConnect 期间的 X Layer 快闪活动，以及面向智能体用户的 Claude Code 插件市场。我们为每个团队跑的每个任务，都是给下一个团队看的公开主网案例。

## 收入模式

**已上线：** 每个任务收取协议费。结果最终确认时，任务费的 `feeBps` 部分进入金库，其余归运营者。主网部署收取 2%，合约上限为 10%。没有最终确认的任务不收费，所以协议只在用户拿到正确结果时才有收入。

**用户为什么付费。** 替代方案不是一笔更贵的交易；对这种规模的机器来说，根本没有替代方案。与直接运行相比，诚实路径在生命游戏棋盘上省了 2,400 倍 gas，在 CPU 的 10,000 拍上省了 42,000 倍，而且无论任务跑多少拍，都只需要几笔交易。费用只需覆盖运营者的两笔交易、挑战期内锁定的保证金，外加一点利润。

**用户为什么持续付费。** 有状态的机器不会只跑一次。游戏每回合推进一次，CPU 每个程序跑一次，每次运行都是一个新任务；`continueJob` 从上一次的最终状态开始下一个任务。只要机器还在使用，就会持续产生使用量。

**同一合约上的下一步收入：** 为不想自己运行机器人的团队提供托管的运营者和监督者服务，面向智能体的付费验证结果 API，以及随任务费增长的保证金，让大任务拥有对应的安全性。

## 使用的 TapeOut 功能

- **Processor 工厂与晶体管。** 演示通过 TapeOut 自己的合约铸造 NAND 和 LATCH 晶体管，并流片两个电路。Overclock 只接受已注册 TapeOut processor（`isCPU`）上的电路任务，因为争议依赖于 TapeOut 永远不会更改网表。
- **链上网表。** 单步检查直接从 processor 的网表读取门记录。
- **`REF`。** 棋盘 64 次 REF 单元电路；争议可以深入到被引用的电路内部。
- **LATCH 与 `step`。** 多拍任务携带状态；LATCH 的读和写都是可争议的单步。
- **ERC-6551 电路账户。** 在主网分叉演练中，棋盘电路自己的账户用 `continueJob` 为下一次运行付费，让机器自己持续运行。
- **DeWEB。** 任务看板是一个不依赖外部字体或脚本的独立文件，`scripts/publish-deweb.js` 会把它存进棋盘电路自己的容器（已在主网分叉上演练）。在上传费用到位之前，同一页面托管在 https://overclock-board.onrender.com。

## 活动期间完成的工作

全部。第一次提交是 2026 年 10 月 17 日：TAP-02 求值器（通过所有官方 TAP-02 测试向量）、执行轨迹承诺、带单门检查的争议合约、多拍 LATCH 争议、运营者和监督者机器人、命令行工具、生命游戏电路、4 位 CPU、CPU 和 AlephTape 数字识别网络的主网运行、MCP 服务器和 Claude Code 插件、针对真实 TapeOut 合约的分叉演练、主网部署和实时运行，以及一份为每个发现都附带概念验证测试的安全审查（[docs/security-audit.md](security-audit.md)）。

## 坦诚说明的局限

- 主网合约早于我们自己审计中的修复（两个争议赔付方面的严重漏洞，以及一次只能有一个挑战者）。它没有所有者，也无法升级；检查时余额为 0 OKB。下一步是重新部署修复后的合约。
- 保证金（0.001 OKB）和挑战期（10 分钟）是演示参数。承载真实价值需要更大的保证金和更长的挑战期。
- 现在任意数量的监督者都可以并行挑战同一个声明，每人一场独立的争议，所以作假者的同伙无法拦住诚实的监督者。捣乱者仍然可以重置挑战期，但每次都要输掉一笔保证金。
- 结果需要等挑战期结束，适合游戏、批量任务和裁决，不适合即时交易。
