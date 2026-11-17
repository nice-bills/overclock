# Telegram message: hackathon support channel (H2 draft)

Draft only — nothing has been sent. Written 17 Nov 2026 for the TapeOut Accelerate Telegram support
channel. Post as one message; the Chinese version below is for the same channel's 中文 room (or as a
second message where both languages are welcome). Claims are limited to what is live today; planned
work is marked as such. The grant ask: **about 0.5 OKB**.

---

## English

Hi! We're Overclock — optimistic execution for TapeOut circuits on X Layer. It's live on mainnet
today: we've run 3 jobs and 3 full dispute games there, including a 4-bit CPU that ran a Fibonacci
program for 10,000 beats at 816K gas where running it through TapeOut directly costs 34.3B (163
blocks) — 42,000× less — and a 161K-gate AlephTape digit net. In every run a planted cheat
corrupted one gate, a watcher caught it on-chain, and the contract checked that single NAND.

We've also counted the whole chain: of 11,074 circuits, 1,014 machines can't run 1,000 beats in a
block. They belong to 213 wallets — 996 FabX miners among them — plus 7 AlephTape nets too big for
a single block.

What we're doing this week: running those machines past what the chain allows, one free job each,
with a public page per circuit; proving FabX miner designs against their Gate Challenges over their
entire input space as certificates anyone can read; and submitting the design as a TAP standard.
(Site: https://overclock-board.onrender.com — open source: https://github.com/nice-bills/overclock)

**The ask: about 0.5 OKB** from the event's support, which covers:
- 0.08 OKB to open the ERC-6551 container (needed for DeWEB publishing and TapeSend),
- a mainnet run of every miner, with the results public,
- months of the runner service that keeps the machines going.

Small ask, public result: every machine on X Layer, running, with a page its owner can point to.

## 简体中文

大家好！我们是 Overclock —— TapeOut 电路在 X Layer 上的乐观执行协议，主网已上线：我们已经在主网
跑了 3 个任务和 3 场完整的争议对局，其中包括一台 4 位 CPU 跑了 10,000 拍的斐波那契程序，只花了
816K gas，而直接用 TapeOut 跑要 34.3B gas（163 个区块）——便宜 42,000 倍；还有 AlephTape 的
161K 门数字识别网络。每一次运行里我们都故意植入了一个作弊者，它篡改了唯一一个门，watcher 在链上
抓到了它，合约只重新核验了那一个 NAND。

我们也统计了整条链：11,074 个电路中，有 1,014 台机器在一个区块里跑不完 1,000 拍，它们属于
213 个钱包——其中 996 台是 FabX 矿机——另外还有 7 个 AlephTape 网络大到单个区块根本跑不完一次。

我们这周要做的事：把这些机器全部跑一遍（每台一次免费任务），每个电路一个公开页面；把 FabX 矿机
设计对它们各自的 Gate Challenge 在**全部输入空间**上做验证，生成人人可读的证书；并把整套设计提交
为 TAP 标准。（网站：https://overclock-board.onrender.com —— 全部开源：
https://github.com/nice-bills/overclock）

**请求：约 0.5 OKB** 的活动支持，用于：
- 0.08 OKB 开通 ERC-6551 容器（DeWEB 发布和 TapeSend 都需要），
- 在主网上把每一台矿机跑一遍，结果全部公开，
- 维持 runner 服务数个月的运转。

小小的请求，公开的结果：X Layer 上的每一台机器都跑起来，每个电路都有一个持有者可以指给别人看的
页面。
