# Overclock

Overclock is optimistic execution for TapeOut circuits on X Layer. It lets you run circuits that are far too big to evaluate on-chain.

An operator runs the job off-chain and posts the result with a bond. Anyone can re-run it. If one gate in millions is wrong, a challenger can narrow the disagreement down to that single step. The contract then re-checks just that one NAND, LATCH or REF wire against the circuit's on-chain netlist, and the liar loses the bond.

**Demo result (local EVM).** The demo runs Conway's Game of Life on a 16×16 board built from TapeOut circuits, for 100 generations. That is 14,848 gates per generation and 1,817,800 steps in all.

| Path | Gas |
|---|---|
| Running it directly on-chain (our TAP-02 evaluator) | 4,339,721,300 |
| Overclock, nobody cheats (claim + finalize) | 228,836 |
| Overclock, a cheat corrupts one NAND: the whole dispute (44 transactions) | 3,283,300 |
| The one-step check that proves the lie | 876,691 |

The final board read back from `Overclock.result()` matches an independent Life simulation.

Replay page: [`web/overclock.html`](web/overclock.html) is self-contained, so you can open it from disk or upload it as a DeWEB site.

## Why this needs TapeOut

A fraud proof needs a "one step" that a contract can re-execute. For EVM rollups that meant years of work building an EVM inside the EVM.

TapeOut circuits avoid that problem. They are NAND gates with exact, published semantics (TAP-02), stored on-chain and never changed. So a single gate is the step, and every circuit ever taped out can run at any size with no ceremony, recompiling or per-circuit setup.

- **REF** gives nested calls for free: a dispute walks down into the sub-circuit where the mismatch is.
- **LATCH** state chains beats together: stateful, multi-beat machines work too. That is the case ZK proving can't handle today.

## How it works

1. **Post a job.** `postJob(cpu, id, inputs, state, beats, perBeat)` names a taped-out circuit, its starting state and inputs, how many beats to run, and a fee.
2. **Claim.** An operator runs the job with a bit-exact TAP-02 evaluator. It then calls `claim(jobId, traceRoot, outputs, newState)` with the bond.
   - `traceRoot` is a Merkle root over every wire value in execution order: one leaf per signal, REF sub-calls inlined, and the new state after each beat.
   - In this order, every leaf depends only on earlier leaves.
3. **Challenge.** Anyone re-runs the job for free.
   - **A different root** starts a bisection. The claimant reveals the two children of the disputed node (`reveal`), and the challenger picks the one that disagrees (`pick`). This repeats down to a single leaf.
   - **The right root with a wrong result** is disproved in one call, `disputeOutput`.
4. **Check one step.** `resolveLeaf` reads the gate's record from the netlist, takes the leaves it depends on (with Merkle proofs against the claimant's root) and recomputes it.
   - It covers NAND, LATCH reads, LATCH writes, constants, inputs, REF input wires and REF output wires.
   - The challenger builds every proof from its own trace plus the nodes the claimant revealed, so nobody has to publish the trace.
5. **Settle.** The winner takes both bonds. A wrong claim reopens the job. A false challenge restarts the window, so other watchers still get their chance. A party that stops responding loses on `timeout`. Unchallenged claims `finalize`, and then any contract can read the result.

## On TapeOut

The demo goes through TapeOut's own flow end to end:

1. It creates a processor through the factory.
2. It mints transistors, then tapes out the 57-gate cell rule and the board, which REFs the cell once per cell. Tapeout burns the transistors.
3. Overclock reads both netlists from TapeOut's circuits contract. It accepts jobs only on circuits of registered TapeOut processors, because a dispute relies on TapeOut never changing a netlist.
4. After the first job finalizes, the board circuit's own ERC-6551 account calls `continueJob`. That second job runs 50 more generations from the final board, and its result matches.

`contracts/Machine.sol` shows how other contracts build on this. It is a stateful circuit that anyone can pay to advance, one job at a time. It moves forward through `onOverclockResult` callbacks and ignores stale branches.

**Testing against the real contracts.** TapeOut has no testnet, so the "testnet" is a local fork of X Layer mainnet with the real TapeOut contracts at their real addresses. Nothing is broadcast. See [docs/tapeout-notes.md](docs/tapeout-notes.md).

```sh
npm run fork                                  # Hardhat fork of X Layer mainnet, chain 196
npm run demo:fork                             # same demo, real factory, transistors, circuits and opener
RPC_URL=https://rpc.xlayer.tech node scripts/verify-live.js   # our evaluator vs live eval/step
```

Without network access to X Layer, `npm run demo` runs the identical flow against `contracts/TapeOutLocal.sol`, a stand-in that follows TapeOut's documented interface and rules.

## Repository

| Path | What it is |
|---|---|
| `contracts/Overclock.sol` | Jobs, bonded claims, bisection, the one-step check, result disputes, timeouts |
| `contracts/TapeOutLocal.sol` | Local stand-in for TapeOut's factory, transistors, circuits and circuit accounts |
| `contracts/Machine.sol` | A circuit that keeps running on-chain, advanced by Overclock results |
| `src/tapeout.js` | Client for TapeOut: createCPU, mint, tapeout, circuit accounts |
| `scripts/verify-live.js` | Compares our evaluator with live `eval`/`step` |
| `contracts/MockProcessor.sol` | Stand-in for a TapeOut processor. It serves `netlist`/`circuitInfo` and stores netlists in SSTORE2 chunks like the deployed factory |
| `contracts/DirectEval.sol` | Baseline on-chain evaluator, used for the gas comparison |
| `src/tap02.js` | TAP-02 decoder, well-formedness checks and evaluator. It passes every vector in TapeOutProtocol/TAPs `assets/tap-02` |
| `src/trace.js` | Job trace (multi-beat, with optional fault injection) and Merkle tree |
| `src/game.js` | Challenger side: which leaves a step depends on, and proofs against the claimant's tree |
| `src/agents.js` | Operator and watcher bots, written as poll-driven state machines |
| `src/hdl.js`, `src/life.js` | A small netlist builder, plus the Game of Life cell (57 gates) and board circuits |
| `bin/overclock.js` | CLI: `operator`, `watch`, `post`, `trace`, `job`, `life` |
| `src/mcp.js`, `bin/overclock-mcp.js` | MCP server (stdio and HTTP) for AI agents |
| `.claude-plugin/`, `.mcp.json`, `skills/overclock/` | Claude Code plugin: the MCP server plus a usage skill |
| `scripts/demo.js` | The end-to-end demo; writes `web/demo-run.json` |
| `web/` | Replay page |

## Run it

```sh
npm install
npm test             # 42 tests: spec vectors, Life circuits, every-leaf dispute sweeps, TapeOut flow, MCP server
npm run demo         # 16x16 board, 100 generations (about 90 s); --w --h --beats to change
node scripts/build-web.js   # inline the run into web/overclock.html
```

To use the CLI against a chain (local ganache or X Layer):

```sh
export RPC_URL=https://rpc.xlayer.tech PRIVATE_KEY=0x...
node scripts/deploy.js --bond 0.05 --window 3600     # prints OVERCLOCK=0x...
export OVERCLOCK=0x...
node bin/overclock.js post --cpu <processor> --id <circuit> --beats 1000 --state 0x... --fee 0.01
node bin/overclock.js operator           # claims jobs and defends claims
node bin/overclock.js watch              # re-runs every claim and challenges wrong ones
node bin/overclock.js operator --lie-at 91716   # demo: a cheat that corrupts one leaf on every claim
```

`node scripts/local-setup.js` deploys a mock processor and stores the Life circuits on a local chain. On X Layer, `node bin/overclock.js life --cpu <processor> --cell-id <id>` prints the netlists to tape out.

## For AI agents (MCP server and Claude Code plugin)

Most people will hand this to an agent, so Overclock ships as an MCP server. Claude, ChatGPT, Cursor or any other MCP client can use it to:

- read jobs and check claims;
- post work;
- run as a bonded operator or watcher;
- create a TapeOut processor and tape out netlists.

**Claude Code plugin** (the MCP server plus a skill that teaches the workflows and asks before spending):

```
/plugin install overclock --marketplace nice-bills/overclock
```

**Any MCP client over stdio:**

```json
{ "mcpServers": { "overclock": {
  "command": "node", "args": ["/path/to/overclock/bin/overclock-mcp.js"],
  "env": { "RPC_URL": "https://rpc.xlayer.tech", "OVERCLOCK": "0x...", "PRIVATE_KEY": "0x..." } } } }
```

**Remote agents and ChatGPT connectors over HTTP:** `RPC_URL=... OVERCLOCK=0x... node bin/overclock-mcp.js --http --port 3333` serves Streamable HTTP at `/mcp`. Leave `PRIVATE_KEY` unset when anyone else can reach the endpoint.

What the server offers depends on its configuration:

- **Without `OVERCLOCK`:** only the TapeOut tools.
- **Without `PRIVATE_KEY`:** only the read-only tools.

| Tool | What it does |
|---|---|
| `overclock_info`, `list_jobs`, `get_job` | Deployment parameters; jobs with their status (open, claimed, disputed, ready to finalize, final) |
| `describe_circuit` | Pins, state, flattened gates, REFs and estimated `step` gas for any TapeOut circuit |
| `run_locally` | Runs beats off-chain for free: outputs, final state and the trace root an honest claim commits to |
| `verify_claim` | Re-runs a claimed job and says whether to trust it |
| `post_job`, `continue_job` | Posts a job, or more beats from a finalized job's final state |
| `claim_job`, `challenge_claim`, `advance_disputes`, `finalize_job` | Operator and watcher: claim with a bond, bisect a wrong claim to one gate and prove it, settle |
| `create_processor`, `tapeout_circuit`, `life_circuits` | TapeOut's own flow: new processor, mint transistors, tape out a netlist; example netlists |

`test/mcp.test.js` drives the server through the official MCP client over both stdio and HTTP. In the test, the agent:

1. creates a processor and tapes out circuits;
2. posts, claims and finalizes a job;
3. catches a cheating operator by bisecting to the corrupted gate and takes its bond.

## Status and limits

- **Not yet tried on X Layer mainnet.** This environment can't reach `rpc.xlayer.tech`, so these are still to do:
  - deploying the contract;
  - checking the evaluator against live `eval`/`step` results;
  - measuring gas for netlist reads on the real factory.
  The real processor's netlist read path is the one assumption the gas numbers depend on. The mock copies its SSTORE2 layout.
- **Gas of the one-step check** grows with the number of records in the netlist before the disputed step. Big designs are built from REFs, which keeps each netlist small. A 512-record board costs 0.6M to 0.9M gas.
- **One challenger at a time per claim.** A false challenge restarts the window, so a griefer can delay finalization but pays a bond each time. Bond sizing and multi-party games are future work.
- **Not audited.**
