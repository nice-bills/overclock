# Overclock: submission for X Layer Build X, TapeOut Accelerate

Answers to every field the submission form asks for, in the order the event page lists them. Short
enough to paste field by field; every number links to a transaction or a file in this repo.

简体中文版：[submission.zh.md](submission.zh.md)

**Status in one paragraph.** Overclock v1 is on X Layer mainnet and has run three jobs, a cheat caught
on-chain in each. v2 (this repository: 16-way disputes, scaled bonds, the bond split, forced errors,
certificates) passes its tests and runs on a local chain; **it is not deployed on mainnet yet**, and
the v1 contract is to be retired when it is. Everything below says which one it means.

## Project

**Name:** Overclock

**One line:** Every machine on X Layer, running. Every design, proven. Overclock runs TapeOut circuits too
big for a block, and checks FabX miners on every input instead of a sample, with a one-gate check on
X Layer that catches anyone who lies.

**Links**

| | |
|---|---|
| Repository | https://github.com/nice-bills/overclock (MIT) |
| Access link | https://overclock-board.onrender.com |
| Demo video | to be added ([script and shot list](film-script.md)) |
| Write-up (this file, 中文) | [submission.md](submission.md), [submission.zh.md](submission.zh.md) |
| Protocol specification | [docs/tap-optimistic-execution.md](tap-optimistic-execution.md), written as a TAP draft |

## The product

TapeOut's `eval` and `step` run a circuit gate by gate inside one transaction. At about 2.5K gas per
gate and a 210M-gas block, nothing much bigger than 80,000 gates can run on-chain, and a machine that
needs many beats runs out of room long before that. We counted
([docs/census.md](census.md)): of 11,074 circuits on X Layer, 7 are too big to run even once in a block,
and 1,014 of the 1,754 machines can't run 1,000 beats in one. They are held by 213 wallets, 996 of them
FabX miners on two FAB-Genisis processors.

Overclock is two things on one protocol.

**1. The place where those machines run: the Floor.** Overclock runs a stuck machine the way optimistic
rollups run transactions. An operator runs it off-chain with a bit-exact TAP-02 evaluator, claims the
result with a bond, and commits a Merkle root over every wire value in the run. Anyone can re-run it for
free. If a claim is wrong, the contract narrows the disagreement to the first wrong wire and re-checks
that one NAND, LATCH or REF against the circuit's on-chain netlist. The Floor is a live grid of every
stuck machine and miner shape, coloured queued / running / final / certified, with a page per circuit
(`#c/<processor>/<id>`) showing what it is, who owns it, what a run costs directly and through
Overclock, every transaction, and a share link. An owner lookup (`#owner`) takes any address.

**2. The place that proves a design does what it claims: certificates.** A FabX miner is a circuit that
solves a Gate Challenge. FabX marks a miner *verified* after it passes a **sample** of 3 to 32 of the
challenge's 256 official vectors. A bench circuit (`src/bench.js`) REFs the miner and FabX's own
official reference, steps through every input, and latches a sticky mismatch flag and the first failing
input. That sweep runs as one Overclock job over a space no block can hold, and the finalized job is the
certificate. Eight certificates exist so far ([docs/certificates/](certificates/)), issued on a local
chain (`scripts/certify.js`; no keys, no network), not yet on X Layer:

- #54, #1648 and #325 (GC-001, GC-048, GC-031): **certified**, 0 mismatches over all 2, 16 and 512 inputs.
- #2346 (GC-094), #4890 (GC-013) and #4897 (GC-014): **failed**. All three are marked verified by FabX
  on-chain. #2346 fails official vector 17, cycle 4; #4890 and #4897 are a one-gate constant-zero stub
  that FabX's 3-sample check passes with probability about 0.82 on GC-013.
- GC-098 (#310, #4832): **unsound reference**. We swept 262,655 inputs, but FabX's official reference and
  all 256 of its vectors output zero, so passing them proves nothing; the certificate says so instead of
  claiming a pass.

**What it costs: the numbers.** Measured on the v2 contract in the local demo (`npm run demo`): Game of
Life on a 16×16 board, 100 generations, 1,817,800 trace steps, a cheat corrupting one NAND.

| Path | Gas |
|---|---:|
| Run it directly on-chain (our TAP-02 evaluator) | 4,340,286,700 |
| Overclock, nobody cheats: claim + finalize | 241,840 (**17,947× less**) |
| Overclock, a cheat corrupts one NAND: the whole dispute, 14 transactions, 6 rounds | 2,551,174 |
| The one-step check that proves the lie | 911,340 (the contract's bound: 1,721,630) |

Also: a **1-billion-step job** (a 4-bit CPU, every party streaming the trace) ran on one machine in
136.8 s at 776 MB with a cheat caught. Our TAP-02 evaluator is **bit-exact against TapeOut's live
`eval`/`step` on 11,552 of 11,552** X Layer circuits that fit a call ([docs/conformance.json](conformance.json)).

**On mainnet today (v1).** Three jobs, a cheat caught on one NAND in each and an honest result
finalized ([docs/mainnet-run.md](mainnet-run.md), [docs/headline-demos.md](headline-demos.md)):

| | Directly through TapeOut | Overclock v1, honest path |
|---|---:|---:|
| 8×8 Game of Life, 40 generations (181,840 steps) | 441,085,640 gas, can't be sent | 182,011 gas: [claim](https://www.oklink.com/x-layer/tx/0x75779e7f684c3fbe11cd3b68142e726149da990d283c438fb528e784abcd66c9) + [finalize](https://www.oklink.com/x-layer/tx/0x2c45bc0c13bf1a3c2234c98d1fa1665482c6ece5cb55e8b2bc57e50035a863c6) |
| 4-bit CPU running a Fibonacci program for 10,000 beats | 34.3B gas, 163 blocks | [816,083 gas](https://www.oklink.com/x-layer/tx/0xf9e3738e5cc9ce905197526b755579d2da0d416b6ba07d5cdbe0a717bfd2ea6d), 42,003× less |
| AlephTape's 161K-gate digit net, run as they taped it out | 388M gas, 1.85 blocks | [2,244,073 gas](https://www.oklink.com/x-layer/tx/0xcf992d6a5af2c575b2efa5c205bcae232413121a6e1ecc02230025a2d4021848), 173× less |

**How the protocol works (v2).**

1. Anyone **posts a job**: a taped-out circuit, inputs, starting state, beats, a fee. A circuit whose
   worst-case one-step check could exceed a bound is refused at posting.
2. An operator **claims** the result with a bond that scales with the fee,
   `bondFor(job) = minBond + fee × bondBps / 10,000`.
3. A watcher who disagrees **challenges**. The claimant reveals 16 nodes four levels down, the contract
   hashes them up to check the parent, and the challenger picks one of 16: 181,840 steps settle in 5
   rounds instead of 18, and 10 billion in 9 instead of 34. Any number of watchers can dispute the same
   claim in parallel.
4. The contract **checks that one gate** and settles. The loser's bond splits: half to the winner, half to
   the treasury, so a cheat who settles its own claim through an accomplice still loses half a bond.
5. **Forced errors** (Truebit's answer to the verifier's dilemma): the runner posts a deliberate wrong
   claim now and then, committed in advance. The first watcher to catch it earns a jackpot from the
   treasury's share, so watchers earn even when nobody cheats.
6. Unchallenged results **finalize**, and any contract can read them or take a callback.

**Why it needs TapeOut.** A fraud proof needs a single step a contract can re-execute. For the EVM that
meant years of work by Arbitrum and Optimism. A TapeOut circuit is NAND gates with byte-exact, published
semantics, stored on-chain and never changed, so one gate *is* the step. Every circuit ever taped out can
run at any size the moment it exists, with no ceremony or recompiling. REF turns nested circuits into
nested disputes, and LATCH state chains beats together, which is the stateful case the ZK route can't
handle. (For the digit net, AlephTape's ZK check is cheaper, 297K gas, because a setup ceremony was
already run for it. Overclock covers everything else.)

**Why it needs a chain.** The point is that strangers trust a result they didn't compute. Bonds and
slashing on X Layer are what make that safe, and the certificate is only worth anything because it is
public and challengeable.

## Target users and how we reach them

1. **Circuit owners, FabX miners first.** They want to know the design is right before they burn
   transistors on it, and to see their machine run at a size the chain can't hold. They get a page per
   circuit and a certificate with the exact failing input if there is one.
2. **Machine builders**: on-chain CPUs, games with memory, circuit-AI with state. Any number of beats for
   two transactions, using the circuit they've already taped out.
3. **Contracts and apps that use circuit results** read `result(jobId)` or take an `onOverclockResult`
   callback (`contracts/Machine.sol` is a working example).
4. **Operators and watchers**: miners and node runners with idle machines earn job fees, a liar's bond and
   forced-error jackpots. Both bots ship in the CLI.
5. **AI agents**, through the MCP server and Claude Code plugin: verify a result before relying on it,
   buy computation, or run as a bonded operator or watcher.

**How many there are.** [docs/census.md](census.md) lists each processor, its holders and a link that runs
its biggest circuit: 213 wallets hold the 1,014 machines a block can't run 1,000 beats of. FabX itself
lists 6,978 miners (its own API, 17 Nov).

**How we reach them.** The census names the holders, so we reach them one at a time, by name: each gets
a message, in Chinese and English, with the link to the page for their own circuit once it has run. We start with the seven
non-FabX processors that have stuck machines (AlephTape, LoteGate, Covenant, My hero, TAPELIQUID,
Nandverse, GateX), then the largest FAB-Genisis holders, then FabX's Gate Challenge community and the
TapeOut and X Layer builder Telegram groups. Holders ask to vote only after they have seen their own
certificate. Then Demo Day, and the Claude Code plugin marketplace for agent users. Every circuit we run
is a public example for the next owner.

## Revenue model

**Live in the contract:** a protocol fee on every job. When a result finalizes, `feeBps` of the job fee
goes to the treasury and the rest to the operator. The v1 deployment takes 2%, and the contract caps it at
10%. Nothing is taken from a job that doesn't finalize. In v2, half of every slashed bond also goes to the
treasury, which funds the watchers' jackpot.

**Planned, and not yet tested with customers:**

- **Certificates:** a fee per certificate, priced per billion steps checked. Miners verify before burning
  transistors, and a certified miner may be easier to sell on circuit markets.
- **Hosted watching:** a subscription for teams that want their jobs claimed and watched with uptime
  guarantees.
- **Verified-result API for agents:** paid MCP-over-HTTP access to `verify_claim` and result reads.

The claim that certified miners sell more easily, and every price, are hypotheses. We will test them
with the first five holders before we state them anywhere else.

**Why users pay.** For a machine this size there is no alternative to compare against: the direct route
can't be sent. Where there is a baseline, the honest path was 17,947 times cheaper in gas for the Life
board in the v2 demo, and 42,003 times cheaper for 10,000 beats of the CPU on mainnet. The fee only has to
cover an operator's two transactions, the bond it locks for the challenge window, and a margin. For a
certificate, the alternative is a sample.

**Why they keep paying.** Stateful machines don't run once: a game advances every turn and a CPU every
program, and `continueJob` starts each next job from the last final state. A miner owner re-certifies when
the design changes. A watcher keeps watching because forced errors pay even when nobody cheats.

## Processor and circuit IDs

| | |
|---|---|
| Overclock v1 (X Layer, chain 196; to be retired when v2 is live) | [`0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710`](https://www.oklink.com/x-layer/address/0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710) |
| Our processor | [`0xb00f10bb4b2f32c561bf90e205e543d0a2395971`](https://www.oklink.com/x-layer/address/0xb00f10bb4b2f32c561bf90e205e543d0a2395971): #4, Game of Life cell rule (57 gates) · #5, 8×8 board (64 REFs to #4, 3,712 gates per generation) · #6, 4-bit CPU (1,437 gates, 205 LATCH bits) |
| AlephTape's processor | [`0xb00e17789f905234f1890c22e6c01015c10d2f54`](https://www.oklink.com/x-layer/address/0xb00e17789f905234f1890c22e6c01015c10d2f54): #11, their digit net (161,080 gates) |
| FAB-Genisis processor (FabX miners) | [`0x87BFCa3494Aa228fF589ab9B642143A5e8c8F9a6`](https://www.oklink.com/x-layer/address/0x87BFCa3494Aa228fF589ab9B642143A5e8c8F9a6): certificates for #54, #1648, #325, #2346, #4890, #4897, #310, #4832 |
| FabX reference processor (official Gate Challenge references, `id == taskId`) | [`0x265E2580cB9c3FC059f2AA3cf20ad30F3F0A653C`](https://www.oklink.com/x-layer/address/0x265E2580cB9c3FC059f2AA3cf20ad30F3F0A653C) |
| X Layer testnet playground (chain 1952) | Overclock `0x3e53BC7a00c2A9f0f92040e126b4415bAF702E18`, predates v2 ([deployments/1952.json](../deployments/1952.json)) |
| Every mainnet transaction | [docs/mainnet-run.md](mainnet-run.md) (Game of Life), [docs/headline-demos.md](headline-demos.md) (CPU and digit net) |

## Access link

https://overclock-board.onrender.com. The live site today is the v1 build: the landing page, the
[job board](https://overclock-board.onrender.com/#board) (every mainnet job, claim and dispute, read from
the contract), the [mainnet replay](https://overclock-board.onrender.com/#replay) (job 0 step by step, from
the lie to the one gate that proved it), [`#try`](https://overclock-board.onrender.com/#try) (load any
circuit on mainnet, run it in the browser, check beat 1 against TapeOut's own `eval`/`step`, compare the
cost; no wallet) and [`#run`](https://overclock-board.onrender.com/#run) (approve one transaction in OKX
Wallet on X Layer testnet and watch the job claimed and finalized). The Floor, the page per circuit and the
owner lookup are in the v2 build of the same site in this repository and go live with v2. Agent access:
`/plugin install overclock --marketplace nice-bills/overclock` (Claude Code), or the MCP server over stdio
or HTTP (`https://overclock-mcp-mainnet.onrender.com/mcp`).

## Ecosystem features used

- **TapeOut processor factory and transistors.** The demo mints NAND and LATCH transistors and tapes out
  its circuits through TapeOut's own contracts. Overclock only accepts jobs on circuits of registered
  TapeOut processors (`isCPU`), because a dispute relies on TapeOut never changing a netlist.
- **Netlists on-chain.** The one-step check reads gate records straight from the processor's netlist.
- **`REF`.** The board REFs the cell 64 times, and a certificate's bench REFs the miner and its reference;
  disputes reach into the referenced circuit.
- **LATCH and `step`.** Multi-beat jobs carry state; a bench's counter is a LATCH register; LATCH reads and
  writes are disputable steps.
- **ERC-6551 circuit accounts.** In the fork rehearsal the board circuit's own account pays for its next
  run with `continueJob`, so the machine keeps itself running.
- **FabX.** Gate Challenge references, official vectors and miner claims are read from FabX's contracts and
  public API; certificates are checked against FabX's own references.
- **X Layer and OKX Wallet.** v1 on mainnet; wallet flow in the browser and in the MCP approval page.
- **DeWEB.** The site is a single self-contained file with no outside fonts or scripts, and
  `scripts/publish-deweb.js` stores it in a circuit's own container (rehearsed on a mainnet fork). Not
  published yet: it needs the container fee.
- **MCP and Claude Code.** An MCP server and plugin let an agent read jobs, verify claims and post work.

## What was built during the event

All of it. The first commit is from Oct 17, 2026.

- **Before 16 Nov (v1):** the TAP-02 evaluator (passing every official vector), the trace commitment, the
  dispute contract with its one-gate check, multi-beat LATCH disputes, the operator and watcher bots, the
  CLI, the Game of Life circuits, a 4-bit CPU, the mainnet runs of the CPU and AlephTape's digit net, the
  MCP server and Claude Code plugin, a fork rehearsal against the real TapeOut contracts, the mainnet
  deployment, and a security review with a proof-of-concept test for every finding
  ([docs/security-audit.md](security-audit.md)).
- **From 16 Nov (v2):** the bond split (the fix for a cheat rescuing its bond through an accomplice),
  scaled bonds, 16-way dissection, a gas bound for the one-step check, forced errors, an audit update with
  a Slither re-run; a streaming trace engine (a 1-billion-step job on one machine); the conformance
  sweep over every X Layer circuit; the FabX research ([docs/fabx-research.md](fabx-research.md)); the test
  bench and certificate generator; the runner and mirroring for the Floor; the Floor, circuit pages and
  owner lookup; and the TAP draft ([docs/tap-optimistic-execution.md](tap-optimistic-execution.md)).

## Honest limits

- **v2 is not on mainnet yet.** The mainnet contract is v1: it predates the fixes from our own audit, has
  no owner or upgrade path, and held 0 OKB when checked. Its bond (0.001 OKB) and window (10 minutes) are
  demo parameters.
- **Certificates are issued on a local chain so far,** not on X Layer. The mainnet deployer wallet is
  small, so volume runs go to the testnet against mirrors of mainnet circuits until it is funded.
- **The Floor is mostly queued today.** The runner that fills it is built and tested but has not run at
  volume; the runs index holds the three mainnet jobs.
- **Audited in-house, not independently.**
- **The forced-error runner is a trusted role.** One address plants forced errors; a committed claim is
  never slashed, and its worst case is bounded by the treasury pool.
- **Results wait for the challenge window,** which suits batch jobs, verdicts and certificates, not
  instant trades.
- **Revenue is a hypothesis.** The 2% fee is in the contract; certificate pricing and hosted watching
  have not been tested with customers.
