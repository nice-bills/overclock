# Overclock: handoff

Written 14 Nov 2026 for moving the work from the cloud project into a local Claude Code session.
Everything below was checked against `main` and the live services on that date.

## What Overclock is

Optimistic execution for TapeOut circuits on X Layer. TapeOut runs NAND/LATCH circuits gate by gate
inside one transaction (about 2.5K gas per gate, so nothing much over 80K gates fits in a 210M-gas
block). Overclock lets an operator run a much bigger job off-chain and post the result with a bond.
Anyone can re-run it; a challenger bisects a wrong claim down to one step, the contract re-checks that
single NAND, LATCH or REF wire against the circuit's on-chain netlist, and the liar loses the bond.

It's our entry for **X Layer Build X: TapeOut Accelerate**. Deadline **7 Dec 2026, 23:59 UTC**
(the event page calls it provisional). Submit through the event's
[Google Form](https://forms.gle/EoDNbxQ65dev1wFd9). Judging: user value and commercial potential,
innovation, ecosystem integration, product readiness and UX, and a demo video of 3 minutes or less.

Headline results, all on mainnet with a cheat caught on-chain in each run:

- 8×8 Game of Life, 40 generations: 441M gas directly vs 182K gas through Overclock ([docs/mainnet-run.md](docs/mainnet-run.md)).
- 4-bit CPU for 10,000 beats: 34.3B gas directly vs 816K, **42,003× less** ([docs/headline-demos.md](docs/headline-demos.md)).
- AlephTape's 161K-gate digit net: 388M gas vs 2.24M, 173× less.
- Our TAP-02 evaluator matches TapeOut's live `eval`/`step` on 86 mainnet circuits, 688/688 samples ([docs/live-check.json](docs/live-check.json)).

## Architecture and key files

| Path | What it is |
|---|---|
| `contracts/Overclock.sol` | Jobs, bonded claims, parallel bisection games, the one-step check, result disputes, timeouts, protocol fee |
| `contracts/World.sol` | Overclock World: Red vs Blue Life on a 16×16 torus, one epoch per Overclock job, seasons with a pot |
| `contracts/Machine.sol` | A circuit that keeps running on-chain, advanced by Overclock result callbacks |
| `contracts/TapeOutLocal.sol`, `MockProcessor.sol`, `DirectEval.sol`, `GasProbe.sol` | Local stand-ins for TapeOut and gas baselines (testnet playground uses `TapeOutLocal`) |
| `src/tap02.js` | TAP-02 netlist decoder and evaluator (passes TapeOutProtocol/TAPs vectors in `vendor-tap02/`) |
| `src/trace.js`, `src/game.js` | Job trace + Merkle tree; challenger proofs |
| `src/agents.js` | Operator, watcher and World keeper bots (poll-driven state machines) |
| `src/hdl.js`, `src/life.js`, `src/cpu4.js`, `src/digits.js`, `src/world.js` | Netlist builder and the machines |
| `src/tapeout.js`, `src/chain.js` | TapeOut client (createCPU, mint, tapeout, circuit accounts); mainnet addresses |
| `src/mcp.js`, `bin/overclock-mcp.js`, `src/wallet.js` | MCP server (stdio + HTTP) with wallet approval pages; no private key needed |
| `bin/overclock.js` | CLI: `operator`, `watch`, `post`, `trace`, `job`, `life` |
| `web/index.html` + `board.js`, `run.js`, `try.js`, `world.js` | Site sources. `scripts/build-web.js` inlines them into the single-file `web/overclock.html` that is served |
| `scripts/` | `deploy.js` (Overclock), `deploy-stack.js` (testnet playground), `deploy-world.js`, `publish-deweb.js`, `demo.js`, `headline.js`, `rehearse-world.js`, `verify-live.js`, `census.js`, `snapshot-board.js` |
| `.claude-plugin/`, `.mcp.json`, `skills/overclock/` | Claude Code plugin |
| `docs/` | Submission write-up (EN + 中文), film script, launch thread, mainnet tx records, security audit, census |
| `test/` | 74 tests on node:test with local ganache |

## Deployed addresses and URLs

**X Layer mainnet (chain 196)**

| What | Address |
|---|---|
| Overclock (old build, predates audit fixes; holds 0 OKB) | `0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710` |
| Treasury | `0xA9B480C2694aa3F16cd109FCD2C91aCbf3BC689F` |
| TapeOut factory (proxy) | `0x1f09daefa827f02cbb40967cc91b259763760761` |
| TapeOut opener (circuit accounts) | `0x536add8f30f03b69f6fbf29d425a816a0dc50106` |
| Our processor | `0xb00f10bb4b2f32c561bf90e205e543d0a2395971`: #4 Life cell, #5 8×8 board, #6 4-bit CPU |
| AlephTape's processor | `0xb00e17789f905234f1890c22e6c01015c10d2f54`: #11 digit net |
| Overclock World | not launched |

**X Layer testnet (chain 1952)**: playground from `deploy-stack.js`, see [deployments/1952.json](deployments/1952.json).
Overclock `0x3e53BC7a00c2A9f0f92040e126b4415bAF702E18`, TapeOutLocal factory
`0x79CD28853Ef2a0782c5a9e7170f5868eD597F55a`, processor `0x3a728a107daf1c7ec65f40426dd9b88e411722fa`
(life #2, cpu #3). It was deployed on 19 Oct, so it has the two critical payout fixes but not the
later parallel-challenge and on-time-move fixes.

**Render (all auto-deploy on every push to `main`)**

| Service | URL | Notes |
|---|---|---|
| overclock-board (static) | https://overclock-board.onrender.com | Serves `web/overclock.html`. Live copy matched the repo byte for byte on 14 Nov |
| overclock-mcp-mainnet | https://overclock-mcp-mainnet.onrender.com/mcp | 17 tools (no `world_*` until World launches) |
| overclock-mcp-testnet | https://overclock-mcp-testnet.onrender.com/mcp | Same, plus a built-in operator that settles jobs in about 2.5 min |
| overclock-mcp | (old) | Stale first server, only returns 308 redirects, paid plan. Safe to delete from its [dashboard page](https://dashboard.render.com/web/srv-dbb36ojbc2fs73dc42b0) |

## Run, test and deploy locally

```sh
npm ci                 # works on Linux and macOS (lockfile fixed 14 Nov)
npm test               # compiles, then 74 tests, about 4 minutes
npm run demo           # 16×16 Life, 100 generations, local EVM; writes web/demo-run.json
npm run cpu            # CPU headline run; npm run digits for the digit net
node scripts/build-web.js     # rebuild web/overclock.html after editing web/ sources
npm run web            # snapshot the mainnet board (needs RPC) then build
npm run mcp            # MCP server over stdio; add --http --port 3333 for HTTP
npm run fork           # hardhat fork of chain 196, then: npm run demo:fork
node scripts/rehearse-world.js   # full World launch + season on a mainnet fork
```

Deploy commands (each needs `RPC_URL` and `PRIVATE_KEY` in the shell):

```sh
node scripts/deploy.js --bond 0.01 --window 3600        # Overclock; writes deployments/<chainId>.json
node scripts/deploy-world.js --adopt 0x536add8f30f03b69f6fbf29d425a816a0dc50106   # World on mainnet
node scripts/deploy-stack.js --bond 0.001 --window 120  # testnet playground (RPC_URL=https://testrpc.xlayer.tech)
node scripts/publish-deweb.js --dry-run                  # then --open to pay the 0.08 OKB container fee
```

## Env vars and secrets (names only)

| Name | Used by | What |
|---|---|---|
| `RPC_URL` | everything | Chain RPC (mainnet `https://rpc.xlayer.tech`, testnet `https://testrpc.xlayer.tech`) |
| `PRIVATE_KEY` | `scripts/*`, `bin/overclock.js` | Deployer / CLI signer. The MCP server deliberately ignores it |
| `OVERCLOCK` | CLI, MCP | Overclock address; defaults to the mainnet one |
| `OVERCLOCK_PRIVATE_KEY` | MCP | Opt-in unattended signing (dedicated wallet only) |
| `OVERCLOCK_OPERATOR_KEY` | MCP (testnet Render service) | Runs the built-in operator and World keeper |
| `FACTORY` | MCP | Non-default TapeOut factory |
| `PUBLIC_URL` | MCP over HTTP | Public base URL for approval pages (set on Render) |
| `MOVED_TO` | MCP over HTTP | Redirect a retired server to its replacement |
| `PORT`, `WALLET_PORT` | MCP | Ports |
| `WORLD_DEPLOYMENT`, `WORLD_RPC` | `build-web.js` | Which World deployment the site shows |

The Render services hold their own copies of these; the testnet operator key lives only there.

## Current status

Done: contracts, audit fixes with proof-of-concept tests, mainnet Life demo, CPU and digit-net
headline runs, live job board and replay, "your circuit" page with a census of every mainnet circuit,
run-a-job page with OKX Wallet (testnet), Overclock World (rehearsed on a mainnet fork), MCP server and
Claude Code plugin with wallet approval, hosted connectors, submission write-up in English and
Chinese, film script and launch thread, landing redesign.

Fixed in this handoff pass: `npm ci` failed on Linux because of an extraneous `fsevents` entry in
the lockfile (bundled under ganache); the lockfile is cleaned and `npm ci` now installs. README test
count updated to 74. All 74 tests pass.

## What's left, and what only Will can do

In rough priority order. Steps 1, 2, 4 and 5 spend real OKB from Will's wallet.

1. **Redeploy the fixed Overclock on mainnet** (needs Will's funded key). `node scripts/deploy.js --bond <bigger> --window <longer>`
   (audit L-2). Then point at the new address: `deployments/196.json` (keep the old address noted as retired),
   `src/tapeout.js:13`, `web/board.js:9`, `skills/overclock/SKILL.md`, README and both submission docs; mark
   `0xe29F…E710` retired; `node scripts/build-web.js`; push. The board and replay keep showing the old run
   from `docs/mainnet-run.md`, so decide whether the board lists both contracts.
2. **Re-run at least one mainnet job on the new contract** so the README's live claims point at the fixed
   build, and switch `#run` (web/run.js) from testnet to mainnet.
3. **Redeploy the testnet playground** (`deploy-stack.js`) so it runs the same contract as mainnet. It rewrites
   `deployments/1952.json`, the one place the testnet v2 address lives (`src/config.js` reads it; `OVERCLOCK` in the
   environment overrides; the server logs a warning while the file is still v1, i.e. has no `bondBps`). Then update
   the testnet Render service's env if the operator wallet changes. Needs the testnet operator key or a new funded testnet key.
4. **Launch Overclock World on mainnet**: about 0.087 OKB plus about 0.03 OKB of fuel per season. Do it after
   step 1 so it sits on the fixed contract. The `world_*` MCP tools and the site's World page switch on once
   `deployments/196.json` has a `world` entry.
5. **Publish the site to DeWEB** with `scripts/publish-deweb.js --open` (0.08 OKB container fee plus gas).
   Then add the `tape://` link to the README and submission.
6. **Record the demo film** from `docs/demo-script.md` (2:55, every on-chain clip from mainnet), upload it,
   and fill in "Demo video: to be added" in `docs/submission.md` and `docs/submission.zh.md`.
7. **Outside users**: post the launch thread (`docs/launch-thread.md`), tag @XLayerOfficial, Chinese
   community channels. The X Layer pop-up at DevConnect Buenos Aires is 18 Nov.
8. **Submit the form** before 7 Dec, using `docs/submission.md` field by field.
9. **Delete the stale `overclock-mcp` Render service** (dashboard link above). Optional cleanup.

The shared project folder's `overclock/` copy is a snapshot from mid-October and is out of date; use the
repo.

## Kickoff prompt for the local session

Paste this into Claude Code in your local checkout of `nice-bills/overclock`:

```
You're picking up Overclock, my X Layer "TapeOut Accelerate" hackathon entry (deadline 7 Dec 2026,
23:59 UTC). Read HANDOFF.md first, then README.md, docs/security-audit.md and docs/submission.md.

Rules: push straight to main, no pull requests. Every push redeploys three Render services, so run
`npm test` (74 tests, ~4 min) before pushing anything that touches src/, contracts/ or web/, and run
`node scripts/build-web.js` after editing web/ sources. Never print or commit a private key. Ask me
before any transaction that spends mainnet OKB, and tell me the expected cost first.

First task: redeploy the audited Overclock contract on X Layer mainnet (HANDOFF.md, "What's left",
step 1). Propose bond and window values, show me the exact command, and once I've run it with my key,
update every place that hard-codes the old address, rebuild the site, run the tests and push. Then
walk me through steps 2 to 6 in order.
```
