# Grant ask: XLayer Builder Grants / TapeOut ecosystem fund (draft)

Draft only — nothing has been sent. Written 17 Nov 2026. Target: the TapeOut community ecosystem
fund's XLayer Builder Grants (co-run with TapeOutX). English first, 简体中文 below. The ask:
**about 0.5 OKB**. Lead with the census and the mainnet runs: a small ask with a public result.

---

## English

**Project.** Overclock is optimistic execution for TapeOut circuits on X Layer. An operator runs a
circuit off-chain — any number of beats, however big — and posts the result with a bond. Anyone can
re-run it for free; if it's wrong, a dispute narrows the disagreement to one single gate and the
contract re-checks that NAND against the circuit's on-chain netlist. The liar loses the bond; an
honest result finalizes and any contract can read it.

**What is live today.**

- Mainnet contract at `0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710`: 3 jobs, 3 full dispute games,
  all public on the job board (https://overclock-board.onrender.com/#board).
- A 4-bit CPU taped out on TapeOut ran a Fibonacci program for 10,000 beats: 816K gas against
  34.3B gas (163 blocks) run directly — 42,003× less. A 161K-gate AlephTape digit net: 173× less.
- In every run a cheat corrupted one gate out of millions; a watcher caught it on-chain and took
  the bond, and the honest result finalized. The one-gate proof cost 347,509 gas.
- Our evaluator matches TapeOut's live `eval`/`step` bit-exactly on 86 mainnet circuits (688 of 688
  samples). 74 of 74 tests pass in CI.

**Who it's for.** We read every circuit of all 397 processors in the TapeOut factory: 11,074
circuits. 1,014 machines can't run 1,000 beats in a block; they belong to 213 wallets — 996 of them
FabX miners — and 7 AlephTape nets are too big for a block outright. These are the machines
Overclock exists to run.

**What the grant funds (this fortnight).**

1. **Every stuck machine, running.** A runner service walks the census, posts a free job for each
   stuck machine, claims it, and lets it finalize; each circuit gets a public page with its result.
   Nobody has to ask us first.
2. **Proof of Design for FabX miners.** A miner circuit solves a Gate Challenge; Overclock checks it
   against the challenge on its *entire* input space (far too big for a block) and settles the
   result on X Layer as a certificate anyone can read. Certificates for the common miner shapes are
   the first target.
3. **The fixed protocol.** A corrected v2 contract (audit findings fixed with proof-of-concept
   tests), disputes in 5 rounds instead of 18 via 16-way dissection, and the whole design submitted
   as a TAP standard draft.
4. **Ecosystem reach.** DeWEB publishing, TapeSend delivery of results to holders' containers, and
   MCP servers so AI agents can post jobs and verify claims.

**Budget: about 0.5 OKB.**

| Item | Amount | Notes |
|---|---:|---|
| ERC-6551 container | 0.08 OKB | required for DeWEB publishing and TapeSend |
| Mainnet runs of every miner | ~0.05 OKB | job fees ~0.00001 OKB each, plus gas margin |
| v2 deploy + flagship certificate | ~0.01 OKB | one taped-out bench + one flagship run |
| Runner service | ~0.05 OKB | testnet is free; this is the mainnet copy's gas for months |
| Margin for bonds in flight / retries | the remainder | bonds are returned at finalize |

Our own wallet holds 0.0024 OKB, enough for the redeploy and about 100 runs; the grant is what turns
"a strong mechanism" into "every machine on X Layer, running". Everything is open source
(https://github.com/nice-bills/overclock) and every transaction lands on the public job board.

## 简体中文

**项目。** Overclock 是 TapeOut 电路在 X Layer 上的乐观执行协议：operator 在链下运行电路——任意
大小、任意拍数——然后质押提交结果。任何人都可以免费复算；如果结果有错，争议会把分歧收窄到唯一
一个门，合约对照链上不可更改的网表重新核验那一个 NAND。撒谎者失去保证金，诚实的结果最终确认后，
任何合约都能读取。

**目前已上线的内容。**

- 主网合约 `0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710`：3 个任务、3 场完整的争议对局，全部公开在
  任务板上（https://overclock-board.onrender.com/#board）。
- 在 TapeOut 上 tape out 的一台 4 位 CPU 跑了 10,000 拍斐波那契程序：816K gas，直接跑要 34.3B
  gas（163 个区块）——便宜 42,003 倍；161K 门的 AlephTape 数字网络便宜 173 倍。
- 每次运行都植入了一个在数百万步中篡改唯一一个门的作弊者；watcher 在链上抓到它并拿走保证金，
  诚实结果最终确认。单门证明只花了 347,509 gas。
- 我们的求值器与 TapeOut 线上 `eval`/`step` 在 86 个主网电路上逐位一致（688/688 个样本）。74 项
  测试全部通过。

**面向的用户。** 我们读取了工厂全部 397 台处理器的所有电路：共 11,074 个。其中 1,014 台机器在一个
区块里跑不完 1,000 拍，属于 213 个钱包——其中 996 台是 FabX 矿机；另有 7 个 AlephTape 网络大到
区块根本跑不完一次。这些正是 Overclock 要跑起来的机器。

**资助用途（未来两周）。**

1. **每一台卡住的机器都跑起来。** runner 服务遍历普查清单，为每台机器免费发一个任务、认领并等待
   最终确认；每个电路获得一个带结果的公开页面。不需要任何人来找我们。
2. **FabX 矿机的 Proof of Design。** 矿机电路求解一道 Gate Challenge；Overclock 在它的**全部输入
   空间**上对照挑战验证设计，并把结果作为证书沉淀在 X Layer 上，人人可读。先覆盖最常见的几种
   矿机形态。
3. **修正后的协议。** v2 合约（审计问题已用概念验证测试修复）、16 路切分把争议从 18 轮降到 5 轮、
   整套设计提交为 TAP 标准草案。
4. **生态触达。** DeWEB 发布、用 TapeSend 把结果送达持有者的容器、MCP 服务器让 AI agent 能发任务、
   验证声明。

**预算：约 0.5 OKB。**

| 项目 | 金额 | 说明 |
|---|---:|---|
| ERC-6551 容器 | 0.08 OKB | DeWEB 发布和 TapeSend 的前提 |
| 主网跑完全部矿机 | ~0.05 OKB | 每次任务费约 0.00001 OKB，另加 gas 余量 |
| v2 部署 + 旗舰证书 | ~0.01 OKB | 一个 tape out 的测试台 + 一次旗舰运行 |
| runner 服务 | ~0.05 OKB | 测试网免费；这是主网副本数个月的 gas |
| 在途保证金 / 重试余量 | 其余部分 | 保证金在最终确认时返还 |

我们自己的钱包只有 0.0024 OKB，够重新部署和约 100 次运行；这笔资助才能把"一个很强的机制"变成
"X Layer 上的每一台机器都在跑"。全部开源
（https://github.com/nice-bills/overclock），每笔交易都落在公开的任务板上。
