# Overclock

**Every machine on X Layer, running. Every design, proven.**

Overclock is optimistic execution for TapeOut circuits. TapeOut runs a circuit gate by gate inside one transaction, so anything much past 80,000 gates, or anything that needs many beats, can't run on-chain at all. Overclock runs it off-chain, posts the result with a bond, and lets anyone catch a lie with a one-gate check on X Layer.

> **Status.** The contract on X Layer mainnet, [`0xe29F…E710`](https://www.oklink.com/x-layer/address/0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710), is **v1, to be retired when v2 is live**. It predates our audit fixes, holds nothing, and carries the three mainnet runs recorded below. Everything described in this README as v2 is in this repository and passes its tests; **v2 is not deployed on mainnet yet.**

## The goal

Stop being a tool that waits for someone to post a job. Become the place where TapeOut's machines actually run, and the place that proves a circuit does what it claims.

1. **Every stuck machine on X Layer, running.** [We counted](docs/census.md): 11,074 circuits on 397 processors; 7 too big to run even once in a block; 1,014 of the 1,754 machines can't run 1,000 beats in a block, held by 213 wallets. Overclock runs each of them past what the chain allows, with a page per circuit, and nobody has to ask.
2. **FabX miners checked on every input.** A FabX miner is a design that solves a Gate Challenge. FabX verifies a miner by a *sample* of three to 32 test vectors. Overclock checks it against the challenge on its whole input space, far too big for a block, and settles the result on X Layer as a certificate anyone can read.
3. **A protocol people can build on.** Disputes in a handful of rounds, bonds that scale with the job, watchers paid even when nobody cheats, an evaluator checked against TapeOut on every circuit it can, and the whole design written up as a TAP draft ([docs/tap-optimistic-execution.md](docs/tap-optimistic-execution.md)).

## The Floor

The Floor is a live grid of every stuck machine and FabX miner shape, coloured by status: queued, running, final, certified. Each cell links to a page for that circuit (`#c/<processor>/<id>`): what it is, who owns it, how many beats it has run, what that costs directly and through Overclock, every transaction, and a share link. The owner lookup (`#owner`) takes any address and lists that wallet's circuits.

Built and in the site sources ([`web/floor.js`](web/floor.js), [`web/index.html`](web/index.html)), fed by [`docs/census.json`](docs/census.json) and a runs index ([`web/runs.json`](web/runs.json), schema in [docs/runs-schema.md](docs/runs-schema.md)). Today the index holds the three mainnet runs below; a circuit with no run is shown as queued. The **runner** that fills it (`scripts/runner.js`: mirror a circuit, post a job, claim, wait out the window, finalize, record) is built, resumable and tested, and has not yet run at volume: that needs a funded wallet.

**Try any circuit now: [overclock-board.onrender.com/#try](https://overclock-board.onrender.com/#try).** Paste a processor and circuit ID. The page reads the netlist from mainnet, runs it in the browser with the same TAP-02 evaluator our operators use, checks beat 1 against TapeOut's own `eval`/`step` when it fits a call, and shows what the run costs directly and through Overclock. No wallet needed.

## Certificates

A **certificate** says: *this design matches its reference on every input.* It is a finalized Overclock job, so it can be challenged like any other.

- `src/bench.js` builds a **test bench** circuit that REFs the design and a reference and steps a counter through every input (for designs with state, it replays FabX's official per-cycle vectors and an LFSR sequence from reset). It compares outputs and latches a sticky mismatch flag plus the first failing input. The job needs no inputs: one bench, 2^n beats.
- The reference is FabX's own: every Gate Challenge has an official reference circuit on-chain and 256 official vectors ([docs/fabx-research.md](docs/fabx-research.md)). For the 46 challenges with 8 or fewer inputs the 256 vectors are already every input, so the sweep is a truth-table certificate. For the other 53 sound ones, the certificate is equivalence to the official reference.
- A certificate document records the verdict (`certified`, `failed`, or `unsound-reference`), the inputs covered, the exact failing input if there is one, and the job's transactions. The 8 we have are in [`docs/certificates/`](docs/certificates/).

So far these are **issued on a local chain** (`scripts/certify.js` uses a throwaway in-process node, no keys, no network), not yet on X Layer. They show what the product says:

| Miner | Challenge | Verdict | What the sweep found |
|---|---|---|---|
| #54, #1648, #325 | GC-001, GC-048, GC-031 | certified | 0 mismatches over all 2, 16 and 512 inputs |
| #2346 | GC-094 UART receiver | **failed** | official vector 17, cycle 4 |
| #4890 | GC-013 4-bit comparator | **failed** | input `0x00` expects 1; the design is a one-gate constant-zero stub |
| #4897 | GC-014 all-zero detector | **failed** | the same stub |
| #310, #4832 | GC-098 sorting network | **unsound reference** | swept 262,655 inputs, but the official reference and all 256 official vectors are constant zero, so passing proves nothing |

All three failing miners are marked *verified* by FabX's own on-chain check. See [docs/fabx-research.md](docs/fabx-research.md) for how that happens and how to reproduce it from mainnet reads (`node scripts/miner-shapes.js --verify`).

## The protocol

1. **Post a job.** `postJob(cpu, id, inputs, state, beats, perBeat)` names a taped-out circuit, its starting state and inputs, how many beats to run, and a fee. `postJob` refuses a circuit whose worst-case one-step check would cost more than a block can hold (`leafGasBound`).
2. **Claim.** An operator runs the job with a bit-exact TAP-02 evaluator and calls `claim(jobId, traceRoot, outputs, newState)` with a bond.
   - `traceRoot` is a Merkle root over every wire value in execution order: one leaf per signal, REF sub-calls inlined, the new state after each beat.
   - In this order every leaf depends only on earlier leaves, so the first leaf where two traces differ is a single checkable step.
3. **Challenge.** Anyone re-runs the job for free. Any number of watchers can open a game against the same claim; each is decided on its own.
   - **Bisection.** The claimant reveals the two children of the disputed node and the challenger picks the one that disagrees, down to a single leaf.
   - **16-way dissection (v2).** A move covers four levels of the tree: the claimant reveals 16 nodes (`reveal16`), the contract hashes them up and checks the parent, and the challenger picks one of 16 (`pick16`). Same tree, a quarter of the rounds: 181,840 steps settle in 5 rounds instead of 18, and 10 billion steps in 9 instead of 34.
   - **A right root with a wrong result** is disproved in one call, `disputeOutput`.
4. **Check one step.** `resolveLeaf` reads the gate's record from the circuit's on-chain netlist, takes the leaves it depends on (with Merkle proofs against the claimant's root) and recomputes it: NAND, LATCH read or write, constant, input, REF wire. The challenger builds every proof from its own trace plus the nodes the claimant revealed, so nobody has to publish the trace.
5. **Settle, and the bond split.** Whoever loses a game loses half its bond to the winner; the other half goes to the protocol treasury. A watcher who proves a claim wrong gets its own bond back plus half the claimant's, and the job reopens. A cheat who settles its own claim through a second account used to net zero; now the pair loses half a bond every time. A false challenge loses half its bond to the claimant and half to the treasury and restarts the window, so other watchers still get their chance. A party that stops responding loses on `timeout`. Unchallenged claims `finalize`, and then any contract can read the result.
6. **Scaled bonds.** A job's bond is `bondFor(job) = minBond + fee × bondBps / 10,000`. Small jobs stay cheap; big jobs carry big security, so a lie on a job with a large fee always risks more than the job pays.
7. **Forced errors (Truebit's fix for the verifier's dilemma).** If nobody ever cheats, nobody is paid to watch, and then someone cheats. So Overclock's runner deliberately posts a wrong claim now and then, committed in advance. The first watcher to catch it earns a jackpot from the treasury's slashed pool, and the runner gets its bond back. An uncaught forced error is revealed after the window, voided and refunded. Watchers earn even when nobody cheats, so they keep watching.

**Why this needs TapeOut.** A fraud proof needs a "one step" a contract can re-execute. For EVM rollups that meant years of work building an EVM inside the EVM. TapeOut circuits are NAND gates with exact, published semantics (TAP-02), stored on-chain and never changed. So a single gate is the step, and every circuit ever taped out can run at any size with no ceremony, recompiling or per-circuit setup. **REF** gives nested calls for free: a dispute walks down into the sub-circuit where the mismatch is. **LATCH** state chains beats together, so stateful, multi-beat machines work too. That is the case ZK proving can't handle today.

The full specification is a TAP draft: [docs/tap-optimistic-execution.md](docs/tap-optimistic-execution.md). The audit, with a proof-of-concept test for every finding, is [docs/security-audit.md](docs/security-audit.md).

## The numbers

Measured on the v2 contract in the local demo (`npm run demo`): Conway's Game of Life on a 16×16 board built from TapeOut circuits, 100 generations, 1,817,800 trace steps. A cheat corrupts one NAND; a watcher proves it; an honest result finalizes and matches an independent simulation.

| Path | Gas |
|---|---:|
| Running it directly on-chain (our TAP-02 evaluator, `DirectEval`) | 4,340,286,700 |
| Overclock, nobody cheats: claim + finalize | 241,840 |
| Overclock, a cheat corrupts one NAND: the whole dispute, 14 transactions | 2,551,174 |
| The one-step check that proves the lie | 911,340 (the contract's bound for this circuit: 1,721,630) |

The honest path is **17,947× cheaper** than running it directly. The dispute narrows 1.8M steps to one gate in 6 rounds.

| Proof | Result |
|---|---|
| **A 1-billion-step job on one machine** (`scripts/bigjob.js`: a 4-bit CPU, every party streaming the trace) | 136.8 s at 776 MB, with the cheat caught (reference run; timing varies with the machine: a re-run of `--scenario lie` on a busy 12-core box took 133.2 s at 728 MB) |
| **Conformance** ([docs/conformance.json](docs/conformance.json)): our TAP-02 evaluator vs TapeOut's live `eval`/`step`, every X Layer circuit that fits a call | bit-exact on **11,552 of 11,552** circuits (46,208 samples) |
| **FabX miners** ([docs/fabx-research.md](docs/fabx-research.md)) | 3 miners listed as verified fail FabX's own official vectors: #2346 (GC-094, vector 17 cycle 4), #4890 (GC-013) and #4897 (GC-014). The GC-098 reference is unsound: it outputs zero on all 256 vectors |

### On mainnet today (v1)

The first contract ran three jobs on X Layer, a cheat caught on-chain in each. Every transaction is in [docs/mainnet-run.md](docs/mainnet-run.md) and [docs/headline-demos.md](docs/headline-demos.md).

| Job on X Layer mainnet | Running it directly through TapeOut | Overclock v1, honest path |
|---|---:|---:|
| 8×8 Game of Life, 40 generations (181,840 steps) | 441,085,640 gas, more than two full blocks (can't be sent) | 182,011 gas: [claim](https://www.oklink.com/x-layer/tx/0x75779e7f684c3fbe11cd3b68142e726149da990d283c438fb528e784abcd66c9) + [finalize](https://www.oklink.com/x-layer/tx/0x2c45bc0c13bf1a3c2234c98d1fa1665482c6ece5cb55e8b2bc57e50035a863c6) |
| A 4-bit CPU running a program for 10,000 beats (circuit #6, 1,437 gates, 205 LATCH bits) | 34.3B gas, 163 blocks of `step()` | [816,083 gas](https://www.oklink.com/x-layer/tx/0xf9e3738e5cc9ce905197526b755579d2da0d416b6ba07d5cdbe0a717bfd2ea6d), **42,003× less** |
| AlephTape's 161K-gate digit net, run as is (circuit #11 on their processor) | 388M gas, 1.85 blocks of `eval()` | [2,244,073 gas](https://www.oklink.com/x-layer/tx/0xcf992d6a5af2c575b2efa5c205bcae232413121a6e1ecc02230025a2d4021848), 173× less |

For the digit net, AlephTape's own ZK check is cheaper still (297K gas), because someone already ran a setup ceremony for that circuit. Overclock's case is everything else: any circuit the moment it's taped out, with no ceremony, and stateful machines like the CPU, which the ZK route can't handle.

| Submission at a glance | |
|---|---|
| Overclock contract (v1, X Layer chain 196; to be retired when v2 is live) | [`0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710`](https://www.oklink.com/x-layer/address/0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710) |
| TapeOut processor | [`0xb00f10bb4b2f32c561bf90e205e543d0a2395971`](https://www.oklink.com/x-layer/address/0xb00f10bb4b2f32c561bf90e205e543d0a2395971) |
| Circuit IDs | On the processor above: #4, the Life cell rule (57 gates); #5, the 8×8 board (64 REFs to #4); #6, the 4-bit CPU (1,437 gates). On AlephTape's processor [`0xb00e17789f905234f1890c22e6c01015c10d2f54`](https://www.oklink.com/x-layer/address/0xb00e17789f905234f1890c22e6c01015c10d2f54): #11, the digit net (161,080 gates) |
| TapeOut features used | Processor factory, NAND and LATCH transistors, tapeout, `REF`, `step`, netlist reads, ERC-6551 circuit accounts |
| Live site | [overclock-board.onrender.com](https://overclock-board.onrender.com): landing, [job board](https://overclock-board.onrender.com/#board), [replay](https://overclock-board.onrender.com/#replay), [your circuit](https://overclock-board.onrender.com/#try), [run a job](https://overclock-board.onrender.com/#run) |
| Write-up (English, 中文), film script | [docs/submission.md](docs/submission.md), [docs/submission.zh.md](docs/submission.zh.md), [docs/film-script.md](docs/film-script.md) |

## Who it's for

TapeOut's own limit is the market: `step()` costs about 2.5K gas per flattened gate and a block holds 210M, so one call tops out near 80,000 gates. Anything bigger, or anything that has to run for many beats, can't be run on-chain today. ZK coprocessors (AlephTape) cover big *stateless* circuits, but their compiler rejects LATCH and each circuit needs its own setup ceremony. Overclock is the route for everything else.

The census ([`scripts/census.js`](scripts/census.js), [docs/census.md](docs/census.md)) names the holders: 996 of the stuck machines are FAB-Genisis miners on two processors, plus LoteGate (4,863 gates, 17 beats per block), Covenant (44 per block) and others. Each has a link that runs its biggest circuit.

**Run a job from the browser: [overclock-board.onrender.com/#run](https://overclock-board.onrender.com/#run).** Pick the Game of Life or the 4-bit CPU, connect OKX Wallet (or any injected wallet) and approve one `postJob`. The page follows the job as the operator claims it, the challenge window runs out and the result finalizes, and checks the final state with its own TAP-02 run. It posts to the X Layer testnet playground for now, paid with free test OKB.

| Who | What they need | What Overclock gives them |
|---|---|---|
| **Circuit owners**, FabX miners among them | To know their design is correct before burning transistors on it, and to see their machine run at a size the chain can't hold | A certificate with the exact failing input if there is one; a page per circuit with its runs |
| **Machine builders**: on-chain CPUs, games with memory, circuit-AI with state | Their circuit runs, but not at the size or number of beats that makes it worth using | Any number of beats at the cost of two transactions, with no ceremony or recompiling |
| **Contracts and apps that consume circuit results** | A result they can trust without running a 400M-gas computation | `result(jobId)` or an `onOverclockResult` callback, backed by a bond and a public challenge window (`contracts/Machine.sol`) |
| **Operators and watchers**: miners and node runners with idle machines | A way to earn from running circuits | Job fees for honest claims, a liar's bond for catching one, a forced-error jackpot for watching. Both bots ship in the CLI |
| **AI agents** | Exact, checkable computation they can buy and verify | The MCP server and Claude Code plugin: `verify_claim` before trusting a result, `post_job` to buy one |

**How we reach them.** The census names every holder, so the first users are reachable by name: each gets the page for their own circuit once it has run. Then FabX's Gate Challenge community, the teams whose designs outgrew a block (AlephTape, LoteGate, Covenant), and the TapeOut and X Layer builder Telegram groups.

## Business model

**Live in the contract: a protocol fee on every job.** The poster pays a job fee, and when the result finalizes, `feeBps` of it goes to the protocol treasury and the rest to the operator. The mainnet v1 deployment takes 2%, and the contract caps it at 10%. It's taken only on results that finalize. Half of every slashed bond also goes to the treasury, which funds the watchers' forced-error jackpot.

**Planned, untested with customers:**
- **Certificates:** a fee per certificate, priced per billion steps checked. Miners verify before burning transistors, and a certified miner may be easier to sell. Both the claim and the price are hypotheses.
- **Hosted watching:** a subscription for teams that want their jobs claimed and watched with uptime guarantees.
- **Verified-result API for agents:** paid MCP-over-HTTP access to `verify_claim` and result reads.

**Why users pay.** For a 3,712-gate board running 40 beats, the alternative was 441M gas over more than two blocks, which can't be sent at all. For 10,000 beats of the 4-bit CPU, Overclock was 42,000 times cheaper. The fee only has to cover an operator's two transactions, the bond it locks for the challenge window, and a margin. **Why they keep paying:** stateful machines don't run once. `continueJob` starts the next job from the last final state, so usage repeats for as long as the machine is in use.

## On TapeOut

The demo goes through TapeOut's own flow end to end:

1. It creates a processor through the factory.
2. It mints transistors, then tapes out the 57-gate cell rule and the board, which REFs the cell once per cell. Tapeout burns the transistors.
3. Overclock reads both netlists from TapeOut's circuits contract. It accepts jobs only on circuits of registered TapeOut processors, because a dispute relies on TapeOut never changing a netlist.
4. After the first job finalizes, the board circuit's own ERC-6551 account calls `continueJob`. That second job runs 50 more generations from the final board, and its result matches.

`contracts/Machine.sol` shows how other contracts build on this. It is a stateful circuit that anyone can pay to advance, one job at a time, through `onOverclockResult` callbacks.

**Testing against the real contracts.** TapeOut has no testnet, so the rehearsal is a local fork of X Layer mainnet with the real TapeOut contracts at their real addresses. The mainnet run then used an existing processor and skipped the circuit-account step to keep costs down. See [docs/tapeout-notes.md](docs/tapeout-notes.md).

```sh
npm run fork                                  # Hardhat fork of X Layer mainnet, chain 196
npm run demo:fork                             # same demo, real factory, transistors, circuits and opener
RPC_URL=https://rpc.xlayer.tech node scripts/verify-live.js   # our evaluator vs live eval/step
```

Without network access to X Layer, `npm run demo` runs the identical flow against `contracts/TapeOutLocal.sol`, a stand-in that follows TapeOut's documented interface and rules.

## Repository

| Path | What it is |
|---|---|
| `contracts/Overclock.sol` | Jobs, scaled bonds, bonded claims, bisection and 16-way dissection, the one-step check, the bond split, forced errors, timeouts |
| `contracts/TapeOutLocal.sol` | Local stand-in for TapeOut's factory, transistors, circuits and circuit accounts |
| `contracts/Machine.sol` | A circuit that keeps running on-chain, advanced by Overclock results |
| `contracts/MockProcessor.sol`, `contracts/DirectEval.sol` | A stand-in processor that stores netlists in SSTORE2 chunks like the deployed factory; the baseline on-chain evaluator for the gas comparison |
| `src/tap02.js` | TAP-02 decoder, well-formedness checks and evaluator. It passes every vector in TapeOutProtocol/TAPs `assets/tap-02` |
| `src/trace.js`, `src/stream-trace.js` | Job trace (multi-beat, with optional fault injection) and Merkle tree; the streaming version for billion-step jobs |
| `src/game.js` | Challenger side: which leaves a step depends on, and proofs against the claimant's tree |
| `src/agents.js` | Operator and watcher bots, written as poll-driven state machines |
| `src/bench.js`, `src/certify.js`, `scripts/bench.js`, `scripts/certify.js` | Test-bench generator and certificates for FabX miners |
| `src/runner.js`, `src/mirror.js`, `scripts/runner.js`, `scripts/mirror.js` | The runner that works through the census; mirroring a mainnet circuit into a TapeOut stand-in |
| `scripts/census.js`, `scripts/conformance.js`, `scripts/miner-shapes.js`, `scripts/bigjob.js` | The census, the conformance sweep, the FabX miner scan, the billion-step job |
| `src/hdl.js`, `src/life.js`, `src/cpu4.js`, `src/digits.js` | A small netlist builder; the Game of Life cell (57 gates) and board; the 4-bit CPU with its reference emulator; the digit net drawings |
| `src/tapeout.js` | Client for TapeOut: createCPU, mint, tapeout, circuit accounts |
| `bin/overclock.js` | CLI: `operator`, `watch`, `post`, `trace`, `job`, `life` |
| `src/mcp.js`, `bin/overclock-mcp.js` | MCP server (stdio and HTTP) for AI agents |
| `src/wallet.js` | Wallet approval page and signer: transactions approved in OKX Wallet or MetaMask, no private key |
| `.claude-plugin/`, `.mcp.json`, `skills/overclock/` | Claude Code plugin: the MCP server plus a usage skill |
| `scripts/demo.js`, `scripts/headline.js` | The end-to-end demo (writes `web/demo-run.json`); the CPU and digit-net runs |
| `web/` | The site: landing, Floor, circuit pages, job board, replay, run-a-job |

## Run it

```sh
npm ci --include=dev
npm test             # 203 tests: spec vectors, Life circuits, every-leaf dispute sweeps, TapeOut flow, MCP server, certificates, streaming trace
npm run demo         # 16x16 board, 100 generations, local EVM; --w --h --beats to change
node scripts/build-web.js   # inline the run into web/overclock.html
node scripts/bigjob.js      # the billion-step job (minutes, about 800 MB)
```

To use the CLI against a chain (local ganache or X Layer):

```sh
export RPC_URL=https://rpc.xlayer.tech PRIVATE_KEY=0x...
# OVERCLOCK defaults to the v1 mainnet deployment; to deploy your own:
node scripts/deploy.js --bond 0.001 --window 600     # prints OVERCLOCK=0x..., writes deployments/<chainId>.json
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
  "env": { "RPC_URL": "https://rpc.xlayer.tech" } } } }
```

**claude.ai connector (web, desktop and mobile, nothing to install):** in Claude, open Settings → Connectors → Add custom connector, name it Overclock and paste `https://overclock-mcp-mainnet.onrender.com/mcp`. When the agent needs to send a transaction it gives you a link to your own approval page; open it in a browser with OKX Wallet or MetaMask. Each chat gets its own page and wallet connection.

**Try it free on X Layer testnet:** add `https://overclock-mcp-testnet.onrender.com/mcp` as a second connector. It runs against a full playground on testnet (Overclock, the TapeOut stand-in, the Life board and the CPU; [deployments/1952.json](deployments/1952.json)) with an operator built in, so every job you post is claimed and finalized within about two and a half minutes. Pay with free test OKB from the [X Layer faucet](https://www.okx.com/xlayer/faucet); the approval page adds X Layer Testnet to your wallet. `node scripts/deploy-stack.js` builds the same playground on any chain.

**Remote agents and ChatGPT connectors over HTTP:** `RPC_URL=... node bin/overclock-mcp.js --http --port 3333` serves Streamable HTTP at `/mcp`, and the wallet approval pages on the same server: one per MCP session, so people sharing a hosted server never see each other's transactions. Set `PUBLIC_URL` when the server sits behind a proxy that hides its address. Add `--read-only` to serve only the read-only tools.

### Connect your wallet, never paste a key

The agent never sees a private key. Transactions are approved in your own wallet:

1. When the agent needs to send something, the tool comes back within seconds with a link to your approval page (and, in a local setup, opens it in your browser). On a phone, a second link opens the page inside the OKX Wallet app.
2. On that page you connect **OKX Wallet** or **MetaMask**. The page switches the wallet to X Layer, adding the network if it is missing.
3. The transaction opens in your wallet with its amount and target. Approve it and go back to the chat: the agent picks up the result with `transaction_status`. Reject it and nothing is sent.

Ready-made machines need no addresses or hex: ask for "a glider for 10 generations" (`machine: "life"`) or "the Fibonacci CPU for 160 beats" (`machine: "cpu"`). `run_locally` shows the result for free; `post_job` runs it on-chain for a 0.0001 OKB fee by default.

The server checks on-chain that the transaction your wallet sent is exactly the one it asked for, and the page only answers same-origin requests that carry its random token. Read-only tools need no wallet at all.

**Unattended agents.** A bonded operator or watcher has to answer dispute moves before a deadline, possibly while you sleep. For that, `OVERCLOCK_PRIVATE_KEY=0x...` makes the server sign without asking. Use a dedicated wallet that holds only the bond and gas. The server ignores a plain `PRIVATE_KEY` so a key in your shell is never picked up by accident.

What the server offers depends on its configuration:

- **Without `OVERCLOCK`:** only the TapeOut tools.
- **With `--read-only`:** only the read-only tools.

| Tool | What it does |
|---|---|
| `overclock_info`, `list_jobs`, `get_job` | Deployment parameters and wallet status; jobs with their status (open, claimed, disputed, ready to finalize, final) |
| `connect_wallet`, `transaction_status` | The approval page link and wallet status; the result of a transaction that waited for your approval |
| `describe_circuit` | Pins, state, flattened gates, REFs and estimated `step` gas for any TapeOut circuit |
| `run_locally` | Runs beats off-chain for free: outputs, final state and the trace root an honest claim commits to |
| `verify_claim` | Re-runs a claimed job and says whether to trust it |
| `post_job`, `continue_job` | Posts a job, or more beats from a finalized job's final state |
| `claim_job`, `challenge_claim`, `advance_disputes`, `finalize_job` | Operator and watcher: claim with a bond, dispute a wrong claim down to one gate and prove it, settle |
| `create_processor`, `tapeout_circuit`, `life_circuits` | TapeOut's own flow: new processor, mint transistors, tape out a netlist; example netlists |

`test/mcp.test.js` drives the server through the official MCP client over both stdio and HTTP, with no private key: a stand-in for the approval page approves each transaction from an unlocked test account. In the test, the agent:

1. is told to connect a wallet before its first transaction, gets the link, and waits for the connection;
2. has a rejected transaction and a swapped one refused;
3. creates a processor and tapes out circuits;
4. posts, claims and finalizes a job;
5. catches a cheating operator by disputing it down to the corrupted gate and takes its bond.

## Status and limits

- **v2 is not on mainnet yet.** The contract at `0xe29F…E710` is v1: pre-audit, binary disputes, one flat bond, no owner or upgrade path. It held 0 OKB when checked, so nothing is at risk, and v2 will replace it. Certificates have been issued on a local chain, not on X Layer.
- **Mainnet parameters will be small at first.** The v1 deployment's 0.001 OKB bond and 10-minute window suit a demo; a deployment for real value needs a bigger minimum bond and a longer window.
- **Gas of the one-step check** grows with the number of records in the netlist before the disputed step. Big designs are built from REFs, which keeps each netlist small. v2 refuses, at `postJob`, a circuit whose worst-case check could exceed a bound (30M gas by default); in the demo above the real check cost 911,340 gas against a bound of 1,721,630.
- **Challenges run in parallel.** Any number of watchers can open games against the same claim, each decided on its own; the first to prove a wrong step overturns the claim and the rest get their bonds back. A false challenge restarts the window, so a griefer can delay finalization but loses half a bond each time.
- **The forced-error runner is a trusted role,** held by one address that Overclock's own runner uses: a committed claim is never slashed. Its worst case is bounded by the slashed pool ([docs/security-audit.md](docs/security-audit.md), I-4).
- **Audited in-house, not independently.** [docs/security-audit.md](docs/security-audit.md) lists every finding with a proof-of-concept test and a Slither re-run.
- **Results wait for the challenge window,** which suits batch jobs, verdicts and certificates, not instant trades.

## License

[MIT](LICENSE)
