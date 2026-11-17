# Launch thread v2 (H6 draft)

Draft only — nothing has been posted. Written 17 Nov 2026. Rewritten around "every machine running"
(replaces [launch-thread.md](../launch-thread.md)). Eight posts, each under 280 characters for X;
attach the film to post 1 and the resolveLeaf OKLink screenshot to post 4 when posting. Tag
@XLayerOfficial, @TapeOutWorld and @Fabx_global in the last post only. 简体中文 version below.

**Before posting:** posts 5 and 6 describe the runner and certificates — only post those once the
runner has actually finalized jobs and a certificate exists; until then they stay drafted. Posts
1–4 and 7–8 are true today.

---

## English

**1/**
There are 1,014 TapeOut machines on X Layer that a block can't run for 1,000 beats. 996 of them are FabX miners. 7 AlephTape nets are too big for a block outright.

They've never run at the size that makes them worth using. That changes now: every machine, running.

🧵

**2/**
Overclock is optimistic execution for TapeOut circuits. An operator runs a job off-chain — any beats, any size — and claims the result with a bond. Anyone re-runs it free. A disagreement narrows to one gate, and the contract checks that NAND against the on-chain netlist.

**3/**
Proven on mainnet, not in a demo: a 4-bit CPU taped out on TapeOut ran a Fibonacci program for 10,000 beats at 816K gas. Run directly: 34.3B gas, 163 blocks. 42,000× less.

A 161K-gate digit net ran as taped out, 173× less. No ceremony, no recompiling.

**4/**
We sent a cheat into every run. It corrupted one gate out of 181,840 steps. A watcher re-ran the job, bisected the trace down to that gate, and the contract re-checked one NAND: 347,509 gas. The cheat lost the bond. The honest result finalized.

**5/** [once the runner is live]
Now the census becomes a queue. We counted all 11,074 circuits of all 397 processors. Every machine a block can't run gets one free job, finalizing on mainnet, with a public page per circuit.

Nobody has to ask. Your machine's page exists because it's your machine.

**6/** [once a certificate exists]
FabX miners get something better than a run: a certificate. We check a miner design against its Gate Challenge on the entire input space — far beyond any block — and settle it on X Layer for anyone to read. Proof of Design, at a size nothing else in the ecosystem can check.

**7/**
The protocol is open: disputes, one-step semantics, trace layout, test vectors — all specified and all open source. AI agents post jobs and verify claims through an MCP server and a Claude Code plugin. Any contract can build on `result(jobId)`.

**8/**
Live: https://overclock-board.onrender.com
Job board with every job, claim and dispute: overclock-board.onrender.com/#board
Code: github.com/nice-bills/overclock

Every machine on X Layer, running. @XLayerOfficial @TapeOutWorld @Fabx_global

---

## 简体中文

**1/**
X Layer 上有 1,014 台 TapeOut 机器，一个区块跑不完它们的 1,000 拍；其中 996 台是 FabX 矿机。另有 7 个 AlephTape 网络大到区块根本跑不完一次。

它们从未以"值得使用"的规模运行过。现在开始改变：每一台机器，都跑起来。

🧵

**2/**
Overclock 是 TapeOut 电路的乐观执行：operator 在链下运行任务——任意拍数、任意规模——带保证金提交结果。任何人免费复算。分歧会收窄到唯一一个门，合约对照链上网表只重新核验那一个 NAND。

**3/**
主网实测，不是 demo：TapeOut 上 tape out 的一台 4 位 CPU 跑了 10,000 拍斐波那契程序，816K gas；直接链上跑要 34.3B gas、163 个区块。便宜 42,000 倍。

161K 门的数字识别网络按原样运行，便宜 173 倍。无需仪式，无需重新编译。

**4/**
每次运行我们都放入一个作弊者：它在 181,840 步里篡改了一个门。watcher 复算任务、把轨迹二分到那个门，合约只核验一个 NAND：347,509 gas。作弊者输掉保证金，诚实结果最终确认。

**5/** [runner 上线后发布]
现在普查清单变成了队列。我们统计了全部 397 台处理器的 11,074 个电路。每台区块跑不动的机器都会获得一次免费任务，在主网最终确认，每个电路一个公开页面。

不需要任何人来申请。你的机器有页面，只因为它是你的机器。

**6/** [有证书后发布]
FabX 矿机会得到比"跑一遍"更好的东西：证书。我们把矿机设计对照它的 Gate Challenge 在全部输入空间上验证——远超任何区块的规模——并把结果沉淀在 X Layer 上，人人可读。设计证明，规模是生态里其他方案都核验不了的。

**7/**
协议完全开放：争议流程、单步语义、轨迹布局、测试向量——全部有规范、全部开源。AI agent 通过 MCP 服务器和 Claude Code 插件发任务、验证声明。任何合约都能基于 `result(jobId)` 构建。

**8/**
线上：https://overclock-board.onrender.com
任务板，每个任务、每次认领、每场争议：overclock-board.onrender.com/#board
代码：github.com/nice-bills/overclock

X Layer 上的每一台机器，都跑起来。@XLayerOfficial @TapeOutWorld @Fabx_global
