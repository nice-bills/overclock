# Overclock: submission for X Layer Build X, TapeOut Accelerate

Answers to every field the submission form asks for, in the order the event page lists them. Short
enough to paste field by field; every number links to a mainnet transaction or a file in this repo.

## Project

**Name:** Overclock

**One line:** Run TapeOut circuits too big for a block, including CPUs and games with memory. Anyone who
lies about the result is caught by a one-gate check on X Layer and loses their bond.

**Links**

| | |
|---|---|
| Repository | https://github.com/nice-bills/overclock |
| Overclock contract (X Layer, chain 196) | [`0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710`](https://www.oklink.com/x-layer/address/0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710) |
| Processor address | [`0xb00f10bb4b2f32c561bf90e205e543d0a2395971`](https://www.oklink.com/x-layer/address/0xb00f10bb4b2f32c561bf90e205e543d0a2395971) |
| Circuit IDs | #4, Game of Life cell rule (57 gates) · #5, 8×8 board (64 REFs to #4, 3,712 gates per generation) |
| Every mainnet transaction | [docs/mainnet-run.md](mainnet-run.md) |
| Access link (replay page) | `web/overclock.html` in the repo; DeWEB address to be added once uploaded |
| Agent access | `/plugin install overclock --marketplace nice-bills/overclock` (Claude Code), or the MCP server over stdio or HTTP |
| Demo video | to be added |

## The product

TapeOut's `eval` and `step` run a circuit gate by gate inside one transaction. At about 2.5K gas per
gate and a 210M-gas block, nothing much bigger than 80,000 gates can run on-chain, and a machine that
needs many beats runs out of room long before that. Our 8×8 Game of Life board, 40 generations, would
take **441,085,640 gas** through TapeOut's own `step()`: more than two full blocks, so it can't be sent.

Overclock runs it anyway, the way optimistic rollups run transactions:

1. Anyone **posts a job**: a taped-out circuit, its inputs and starting state, the number of beats,
   and a fee.
2. An operator runs it off-chain with a bit-exact TAP-02 evaluator and **claims** the result with a
   bond, committing a Merkle root over every wire value in the run.
3. Anyone can re-run it for free. If the claim is wrong, a watcher **bisects** the trace down to the
   first wrong wire.
4. The contract **checks that one gate**: it reads the gate from TapeOut's on-chain netlist, its inputs
   from Merkle proofs, and computes one NAND (or a LATCH read or write, or a REF input or output).
   The liar's bond goes to the watcher.
5. Unchallenged results **finalize**, and any contract can read them or take a callback.

**On mainnet**, all with real TapeOut contracts:

| | Gas | Transaction |
|---|---:|---|
| Run the board directly with `step()` | 441,085,640 | can't be sent |
| Overclock, nobody cheats: claim + finalize | 182,011 | [claim](https://www.oklink.com/x-layer/tx/0x75779e7f684c3fbe11cd3b68142e726149da990d283c438fb528e784abcd66c9), [finalize](https://www.oklink.com/x-layer/tx/0x2c45bc0c13bf1a3c2234c98d1fa1665482c6ece5cb55e8b2bc57e50035a863c6) |
| A cheat corrupts one NAND out of 181,840 steps: the whole dispute, 38 transactions | 2,433,720 | [challenge](https://www.oklink.com/x-layer/tx/0x942b7927db797ff55d6d67dbc2a57b2a3fbe99616123c0bb704df9abac8550b5) onward |
| The one-step check that proves the lie | 347,509 | [resolveLeaf](https://www.oklink.com/x-layer/tx/0xa4fbe532791e6220310618304ce7f4f908a80411a887986984e0c7819a2a0bff) |

The final board read back from `Overclock.result(0)` matches an independent simulation. Our evaluator
also matches TapeOut's live `eval`/`step` on 86 mainnet circuits, 688 of 688 samples
([docs/live-check.json](live-check.json)).

**Why it needs TapeOut.** A fraud proof needs a single step a contract can re-execute. For the EVM that
meant years of work by Arbitrum and Optimism. A TapeOut circuit is NAND gates with byte-exact,
published semantics, stored on-chain and never changed, so one gate *is* the step. Every circuit ever
taped out can run at any size the moment it exists, with no ceremony or recompiling. REF turns nested
circuits into nested disputes, and LATCH state chains beats together, which is the stateful case the
ZK route can't handle today.

**Why it needs a chain.** The point is that strangers trust a result they didn't compute, and bonds and
slashing on X Layer are what make that safe.

## Target users and how we reach them

1. **Machine builders**: teams whose circuits outgrew a block, such as on-chain CPUs, games with
   memory and circuit-AI with state. They get any number of beats for two transactions, using the
   circuit they've already taped out.
2. **Contracts and apps that use circuit results**, such as games, scoring and settlement. They read
   `result(jobId)` or take an `onOverclockResult` callback (`contracts/Machine.sol` is a working
   example of a machine that advances one job at a time).
3. **Operators and watchers**: miners and node runners with idle machines. They earn job fees for honest
   claims and a liar's bond for catching one. Both bots ship in the CLI.
4. **AI agents**, through the MCP server and Claude Code plugin: they can verify a result before relying
   on it, buy computation, or run as a bonded operator or watcher.

**Reaching them.** The TapeOut ecosystem is small and concentrated, so the first users can be contacted
by name: the teams with designs too big for a block (Cerebr, AlephTape's 161K-gate digit net, the
on-chain CPU builders), FabX's Gate Challenge community, and the TapeOut and X Layer builder Telegram
groups. Then Demo Day, the X Layer pop-up at DevConnect on Nov 18, and the Claude Code plugin
marketplace for agent users. Every job we run for a team is a public mainnet example for the next one.

## Revenue model

**Live now:** a protocol fee on every job. When a result finalizes, `feeBps` of the job fee goes to the
treasury and the rest to the operator. The mainnet deployment takes 2%, and the contract caps it at 10%.
Nothing is taken from a job that doesn't finalize, so the protocol earns only when a user gets a correct
result.

**Why users pay.** The alternative isn't a more expensive transaction; for a machine this size there is
no alternative. Against running it directly, the honest path cost about 2,400 times less gas (182K
against 441M), and it stays at two transactions however many beats a job runs. The fee only has to
cover an operator's two transactions, the bond it locks for the challenge window, and a margin.

**Why they keep paying.** Stateful machines don't run once. A game advances every turn and a CPU every
program, and each run is a new job; `continueJob` starts the next one from the last final state. Usage
repeats for as long as the machine is in use.

**Next revenue on the same contract:** a hosted operator and watcher service for teams that don't want
to run bots, paid access to a verified-result API for agents, and bonds that scale with the job fee so
large jobs carry large security.

## TapeOut features used

- **Processor factory and transistors.** The demo mints NAND and LATCH transistors and tapes out both
  circuits through TapeOut's own contracts. Overclock only accepts jobs on circuits of registered
  TapeOut processors (`isCPU`), because a dispute relies on TapeOut never changing a netlist.
- **Netlists on-chain.** The one-step check reads gate records straight from the processor's netlist.
- **`REF`.** The board REFs the cell 64 times; disputes reach into the referenced circuit.
- **LATCH and `step`.** Multi-beat jobs carry state; LATCH reads and writes are disputable steps.
- **ERC-6551 circuit accounts.** In the fork rehearsal the board circuit's own account pays for its next
  run with `continueJob`, so the machine keeps itself running.
- **DeWEB.** The replay page is a single self-contained file built to be served from DeWEB.

## What was built during the event

All of it. The first commit is from Oct 17, 2026: the TAP-02 evaluator (passing every official TAP-02
vector), the trace commitment, the dispute contract with its one-gate check, multi-beat LATCH disputes,
the operator and watcher bots, the CLI, the Game of Life circuits, the MCP server and Claude Code
plugin, a fork rehearsal against the real TapeOut contracts, the mainnet deployment and live run, and a
security review with a proof-of-concept test for every finding ([docs/security-audit.md](security-audit.md)).

## Honest limits

- The mainnet contract predates two critical fixes from our own audit (dispute payouts). It has no
  owner or upgrade path and held 0 OKB when checked; a redeploy of the fixed contract is the next step.
- Bond (0.001 OKB) and challenge window (10 minutes) are demo parameters. Real value needs a bigger bond
  and a longer window.
- One challenger at a time per claim: a griefer can delay a job, though never make a wrong result
  final. Multi-party games are the planned fix.
- Results wait for the challenge window, which suits games, batch jobs and verdicts, not instant trades.
