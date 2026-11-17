# FabX ask (H4 draft)

Draft only — nothing has been sent. Written 17 Nov 2026. Three asks for the FabX team, in order of
importance to us: Gate Challenge specs, listing the site in the DeWEB directory, and hosting on a
miner's container. English first, 简体中文 below.

---

## English

Hi FabX team — we're Overclock (https://overclock-board.onrender.com), optimistic execution for
TapeOut circuits on X Layer. We read every circuit of the factory: your two FAB-Genisis processors
hold 996 miner designs that can't run 1,000 beats in a block, and we see the shapes — 205 identical
463-gate 18-input circuits, 140 of another shape, and so on. We'd like to make your miners provably
correct, publicly. Three asks:

**1. Gate Challenge specs (research, day 1).** We want to verify a miner design against the
challenge it solves — over the miner's *entire* input space, far too big for a block — and settle
the result on X Layer as a certificate anyone can read. For that we need to know, for each of the
100 challenges:

- how FabX defines the challenge (the exact input/output contract),
- what makes a miner "verified" today,
- whether there is a reference circuit or published spec per challenge.

If a published spec or FabX reference exists, we verify against it directly. If not, a template
circuit a miner was derived from also works: then the certificate says the optimized miner still
matches the original on every input. Even with no spec and no template, equivalence certificates
("proven unchanged by optimization") still work — we'd just rather do the full proof.

**2. List the site in FabX's DeWEB directory.** The Overclock pages are one self-contained file we
publish to DeWEB (`scripts/publish-deweb.js`); the `tape://` name becomes the primary link. A
listing in your directory puts "is my miner correct?" one click away from your miners' owners.

**3. Hosting on a miner's container.** FabX offers hosting on a miner's container. If one of your
containers hosts our published page and MCP server, we skip opening our own ERC-6551 container
(0.08 OKB) and the site lives natively in your ecosystem. If that works, tell us what you need
from us.

What's live today: mainnet contract `0xe29F…E710` with 3 jobs and 3 dispute games, a watcher that
caught a planted one-gate cheat on-chain, an evaluator bit-exact with TapeOut's `eval`/`step` on 86
circuits. Certificates for your miner shapes are our next build step (in progress, not yet live);
the mainnet flagship certificate is planned. We'd start with the biggest shapes — say the
205-identical group — and show you the certificate before we scale out.

## 简体中文

FabX 团队你们好 —— 我们是 Overclock（https://overclock-board.onrender.com），做 TapeOut 电路在
X Layer 上的乐观执行。我们读取了工厂的全部电路：你们两台 FAB-Genisis 处理器上有 996 台在一个区块
里跑不完 1,000 拍的矿机设计，而且形态非常集中——205 台完全相同的 463 门 18 输入电路、140 台另一
种形态，等等。我们想让你们的矿机获得公开、可验证的"设计正确"证明。三个请求：

**1. Gate Challenge 规格（首要研究问题）。** 我们想把矿机设计与它求解的挑战做验证——在矿机的
**全部输入空间**上，大到区块根本装不下——并把结果沉淀到 X Layer，生成人人可读的证书。为此需要
了解这 100 道挑战的：

- FabX 如何定义每道挑战（精确的输入/输出约定），
- 今天"矿机通过验证"的标准是什么，
- 每道挑战有没有参考电路或公开规格。

如果有公开规格或 FabX 官方参考，我们直接对照它验证。如果没有，矿机派生自的模板电路也可以：证书
改为声明"优化后的矿机在全部输入上仍与原设计一致"。即使规格和模板都没有，等价性证书（"证明优化
没有改变设计"）依然成立——只是我们更希望做完整证明。

**2. 把网站列入 FabX 的 DeWEB 目录。** Overclock 的页面是单文件应用，我们用
`scripts/publish-deweb.js` 发布到 DeWEB，`tape://` 名称作为主链接。列入目录后，"我的矿机正确吗？"
离你们矿机的持有者只有一次点击。

**3. 用矿机的容器托管。** FabX 提供矿机容器托管。如果我们的页面和 MCP 服务器由你们的容器承载，
我们就省掉自开 ERC-6551 容器（0.08 OKB），站点也原生地活在你们的生态里。如果可行，请告诉我们
需要我们提供什么。

目前已上线的部分：主网合约 `0xe29F…E710`，3 个任务和 3 场争议对局，watcher 在链上抓到过植入的
单门作弊；求值器与 TapeOut 的 `eval`/`step` 在 86 个电路上逐位一致。针对你们矿机形态的证书是我们
下一步的开发内容（进行中，尚未上线）；主网旗舰证书在计划中。我们会先从最大的形态入手——比如那
205 台相同形态——先把证书做出来给你们看，再铺开。
