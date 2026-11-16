# Overclock: the plan to win TapeOut Accelerate

Written 16 Nov 2026. Supersedes the "What's left" section of [HANDOFF.md](HANDOFF.md); everything else in
that file (architecture, addresses, commands, env vars) still holds. Deadline **7 Dec 2026, 23:59 UTC**.
Community voting runs to **18 Dec, 22:00 UTC+8**.

## 1. The goal

**Stop being a tool that waits for someone to post a job. Become the place where TapeOut's machines
actually run, and the place that proves a circuit does what it claims.**

Today Overclock is a strong mechanism with no users: 3 mainnet jobs and 3 dispute games, all ours, and 1
job on the testnet playground. By 7 Dec, a judge who opens the site should see:

1. **Every stuck machine on X Layer already running.** The 18 out-of-reach machines that aren't FabX
   miners (17 of them other people's), plus the 7 AlephTape nets too big for a block, have each been run past what the chain allows,
   with a page per circuit. Nobody had to ask.
2. **FabX miners proven correct on every input.** A miner circuit is a design that solves a Gate
   Challenge. Overclock checks it against the challenge on its *entire* input space, far too big for a
   block, and settles the result on X Layer as a certificate anyone can read. That is Proof of Design at
   a size nothing else in the ecosystem can check.
3. **A protocol people can build on:** a fixed v2 contract, disputes in 5 rounds instead of 18, a
   10-billion-step job, watchers paid even when nobody cheats, our evaluator checked against TapeOut on
   every circuit on the chain, and the whole design submitted as a TAP standard.

No games. Overclock World is cut from the product and the pitch (section 9).

## 2. Where we stand (checked 16 Nov)

| | |
|---|---|
| Tests | 74 of 74 pass (`npm ci --include=dev && npm test`, 3.5 min) |
| Mainnet Overclock `0xe29F…E710` | Pre-audit build. 3 jobs, 3 games, 0 OKB held |
| Testnet playground `0x3e53…2E18` | 1 job. Predates parallel challenges and on-time moves |
| Site, MCP mainnet, MCP testnet (Render) | All answer 200; the MCP server initializes correctly |
| Deployer / treasury wallet `0xA9B4…689F` | **About 0.0024 OKB** on mainnet. X Layer gas is 0.02 gwei |
| Community leaderboard | 32 projects, 956 votes. Overclock is not in the visible top 10. Fourth place has 70 votes |

**Two open contract bugs,** both reproduced with tests on 16 Nov:

- **A caught cheat loses nothing.** When a watcher challenges a wrong claim, the cheat's second account
  settles it first with one `disputeOutput` call and collects both bonds. The cheat nets zero and the
  honest watcher gets only a refund.
- **World's final epoch can be sniped.** Moot once World is cut; one line in `place()` if it ever returns.

## 3. Money: what costs what

| Action | Cost | Where |
|---|---|---|
| Deploy Overclock v2 (about 4M gas) | ~0.0001 OKB | Mainnet |
| Post, claim and finalize one job on an existing circuit (~0.5M gas, estimate) | ~0.00001 OKB | Mainnet |
| Bond locked per open claim | Whatever v2 sets (see A2), returned at finalize | Mainnet |
| Tape out one circuit (a test bench) | 0.0013 OKB plus transistors | Mainnet, once |
| Open a container: needed for DeWEB and for sending TapeSend | 0.08 OKB | Needs a grant |
| Anything on testnet | Free (faucet OKB) | Testnet |

**Mainnet budget (0.0024 OKB):** redeploy, about 100 runs, and one flagship certificate. Everything at
volume (the 996 miners) runs on testnet against exact mirrors of the mainnet circuits (B4), until funded.

**Ask for funding this week,** from two places:

- the TapeOut community ecosystem fund's XLayer Builder Grants (co-run with TapeOutX);
- the event's Telegram support channel.

The ask: about 0.5 OKB covers the container (DeWEB and TapeSend), a mainnet run of every miner, and
months of the runner. Lead with the census and the mainnet runs; it is a small ask with a public result.

## 4. Workstreams

Each task has an owner: **me** (code, in this repo), **you** (anything that signs a transaction, posts
publicly, or talks to people), or **both**. Rated **Must**, **Should** or **Stretch**: if time runs
short, cut from the bottom.

### A. Contract v2 (Must, week 1)

| # | Task | Done when |
|---|---|---|
| A1 | **Slashing split.** When a claim is proven wrong, the winning challenger gets its own bond plus half the claimant's; the other half goes to the treasury, which funds A4. A cheat working with an accomplice now loses half a bond every time | A regression test reproduces the 16 Nov bond-rescue attack and shows the cheat loses |
| A2 | **Bonds that scale with the fee:** `bondFor(job) = minBond + k × fee`. Small jobs stay cheap; big jobs carry big security (closes audit L-2 in principle, not just by parameter) | Tests; mainnet `minBond` set so the runner fits the budget |
| A3 | **16-way dissection.** The claimant reveals 16 nodes four levels down; the contract hashes them up and checks the parent; the challenger picks one of 16. Compatible with today's binary trace tree | 181,840 steps settle in 5 rounds instead of 18; a 10B-step trace in 9 instead of 34; every-leaf dispute sweeps still pass |
| A4 | **Forced errors (Truebit's fix for the verifier's dilemma).** The runner deliberately posts a wrong claim at random, committed in advance; the first watcher to catch it earns a jackpot from the A1 treasury share. Watchers earn even when nobody cheats, so they keep watching | Test: a forced error is caught and paid; an uncaught one is revealed and refunded |
| A5 | **Gas bound for the one-step check** (audit I-1). `postJob` refuses circuits whose worst-case `resolveLeaf` would exceed a cap computed from netlist size and REF depth | Test with a crafted deep circuit |
| A6 | Audit update: A1–A5 written up with proof-of-concept tests, Slither re-run | `docs/security-audit.md` updated |

**Then you deploy:** testnet playground first (free), mainnet once the testnet run is clean. I give you
the exact command and expected cost before each one.

### B. Off-chain engine (Must, weeks 1–2)

| # | Task | Done when |
|---|---|---|
| B1 | Operator and watcher speak 16-way dissection | Dispute tests pass against v2 |
| B2 | **Streaming trace.** Today the whole trace sits in memory. Stream it instead: a lookup table for the bottom 4 tree levels (every 16-leaf pattern precomputed, cutting hashing 16×), worker threads across cores, and checkpointed subtree roots so a proof path is recomputed from one 65,536-leaf chunk on demand | A 1-billion-step job claims and survives a dispute on one machine |
| B3 | **The runner.** A service that walks the census, posts a job for each stuck machine, claims it, waits out the window, finalizes, and records the result for its page. Overclock pays: "we run every stuck machine once, free". Lives in the testnet Render service next to the built-in operator; a mainnet copy uses a dedicated wallet funded only with its budget, never the main key | Runs unattended for 48 hours on testnet |
| B4 | **Mirror.** Copy any mainnet circuit and everything it REFs into the testnet TapeOut stand-in, with REF addresses rewired, so any mainnet machine runs on testnet for free | The 8×8 board mirrored on testnet produces the same result as mainnet job 0 |
| B5 | Watcher plays the forced-error game (A4) | Catches a forced error on testnet and is paid |

### C. Conformance on every circuit (Must, week 1, free)

**C1.** Our claim that "our evaluator matches TapeOut" rests on 86 circuits. Run `verify-live.js` over
every circuit on X Layer that fits one `eval`/`step` call (most of the 11,074), using free mainnet reads
through Multicall3, resumable, with results in `docs/conformance.json`.

- Done when the README says "bit-exact on N of N circuits".
- If we find a mismatch, it is either our bug or TapeOut's. A TapeOut bug, reported privately to the
  TapeOut team (who are also the judges), would be the most credible thing we could show them.

### D. Certificates for FabX miners (Must, weeks 1–2)

**Day-1 research, before any code:**

- How does FabX define each Gate Challenge, and what makes a miner "verified"?
- Is there a reference circuit or spec for each of the 100 challenges?

The census shows the miners fall into a few shapes (205 identical 463-gate, 18-input circuits; 140 of
another; and so on), which suggests shared templates.

| # | Task | Done when |
|---|---|---|
| D1 | **Test-bench generator** (`src/bench.js`). Builds a circuit that REFs the design and a reference, steps a LATCH counter through every input (or, for designs with state, an LFSR sequence from reset), compares outputs, and latches a sticky mismatch flag plus the first failing input. The job needs no inputs: one bench, 2^n beats | Bench over a correct and a deliberately broken 8-input design: certifies the first, reports the exact failing input for the second |
| D2 | **Reference source,** in order of preference: FabX's own reference for that Gate Challenge → a reference we write in `src/hdl.js` from the published spec → the template circuit a miner was derived from (equivalence: "your optimized miner still matches the original on every input") | One reference per common miner shape |
| D3 | **Certificate.** A finalized Overclock job whose result says "0 mismatches over 2^n inputs", plus a page and a JSON file anyone can check. 2^18 inputs × ~1,000 gates ≈ 250M steps: in range today, and impossible on-chain directly | Certificates for the largest miner shapes on testnet |
| D4 | **One flagship certificate on mainnet:** tape out one bench on our processor (0.0013 OKB plus transistors) for the most common miner shape | A mainnet transaction link in the README |
| D5 | Offer the same bench to the other rule-chip projects in this hackathon. hardline "tests every case before it mints" off-chain today; TapeAI compiles agent rules to circuits. Overclock makes their checks on-chain and public | One partner project agrees to a joint demo |

**If D-day-1 research fails** (no spec, no template): certificates still work as equivalence between a
miner and the circuit it was derived from. The pitch narrows from "proven correct" to "proven unchanged
by optimization". Decide by 19 Nov.

### E. The site (Must, weeks 1–2)

| # | Task | Done when |
|---|---|---|
| E1 | **Landing reframed** around the goal: "Every machine on X Layer, running. Every design, proven." Live counters: machines run, certificates issued, steps settled | Hero and stats reflect live data |
| E2 | **The Floor:** a live grid of every stuck machine and miner shape, coloured by status (queued, running, final, certified), each linking to its page | Renders all of them from on-chain data plus the runner's index |
| E3 | **A page per circuit** (`#c/<processor>/<id>`): what it is, its owner, beats run, current state, certificate, direct cost vs Overclock cost, every transaction, and a share link | Every census circuit has one |
| E4 | **Owner lookup.** Paste an address or connect OKX Wallet and see your circuits, their runs and certificates. This is the page outreach links to | Works for any of the 213 holders |
| E5 | **"Run a job" and "Your circuit" point at v2**, mainnet where the budget allows, testnet mirror otherwise. Fee shown in plain OKB | Posts and finalizes on both networks |
| E6 | **简体中文** across the whole site with a toggle; the Chinese write-up updated | Native-reader check by you or a community member |
| E7 | Open Graph and Twitter preview tags, a share image, a favicon | Links preview properly in X and Telegram |
| E8 | Fixes: mobile nav clips the last tab; World tab removed | Screenshots at 390 px wide |

### F. Agents (Should, week 2)

| # | Task |
|---|---|
| F1 | MCP tools for the new product: `find_my_circuits(address)`, `run_circuit(processor, id, beats)`, `certify(processor, id)`, `get_certificate`. "Is my FabX miner correct?" becomes one sentence in Claude or ChatGPT |
| F2 | Point both hosted MCP servers at v2; plugin version bump to 0.5.0 |
| F3 | *If the container is funded:* publish the tool list as a TAP-15 service manifest in our circuit's container, so the MCP server is discoverable the TapeOut way |

### G. Ecosystem integration (Must where free; the rest on funding)

| Capability | Plan | Cost |
|---|---|---|
| TapeOut circuits, netlists, REF, LATCH | Already deep. Adds bench circuits that REF other people's circuits | Free |
| X Layer, OKX Wallet | v2 on mainnet; wallet flow on mainnet | Gas |
| FabX | Certificates for their miners (D); list the site in FabX's DeWEB directory; FabX offers hosting on a miner's container, which may avoid our 0.08 OKB | Free, ask FabX |
| DeWEB / TapeKit | Publish with `scripts/publish-deweb.js` and make the `tape://` name the primary link. Free if FabX hosts; otherwise needs the container | 0 or 0.08 OKB |
| TapeSend | When a run or certificate finalizes, send the result to the owner's container. Only reaches holders who opened one; the page is the fallback | Needs the container |
| Containers (ERC-6551) | Ours sends results (above); a circuit's own container can pay for its next run (proven on the fork) | Needs the container |
| TapeCode | `overclock-js`: a small library any app can import to post a job and read a verified result. TapeCode apps whose rules outgrow a block are the first audience. It is a library, not a game | Free |
| TAPs | Draft "TAP: Optimistic Execution of Circuits": trace layout, leaf order, one-step semantics, contract interface, test vectors. A second draft for certificates if D lands. **You** open the PR on TapeOutProtocol/TAPs; I can't push outside this repo | Free |

### H. Users and votes (Must, from day 1, mostly you)

The census already names the users. Paul Graham's rule applies: recruit by hand, and keep the fire
small until it's hot.

| # | Task | Owner |
|---|---|---|
| H1 | **Register on the leaderboard today** (the "Register project" form on the voting page, which differs from the submission form). Use the new one-line pitch | You |
| H2 | Message the hackathon Telegram: what we're running, the grant ask | You, I draft |
| H3 | **Holder outreach, one at a time.** Each of the 213 holders gets their circuit's page link, in Chinese and English, once their circuit has run. Start with the 7 non-FAB processors (LoteGate, Covenant, AlephTape, My hero, TAPELIQUID, Nandverse, GateX), then the biggest FAB holders | You send, I draft each message and produce the link list |
| H4 | FabX: ask to list the site, ask about hosting and Gate Challenge specs (D-day-1) | You |
| H5 | Voting: FAB and BEM holders vote, and FAB holders are exactly the miner owners we certify. Ask only after they've seen their own certificate | You |
| H6 | Launch thread rewritten around "every machine running", EN and 中文; tag @XLayerOfficial, @TapeOutWorld, @Fabx_global | I draft, you post |
| H7 | One partner project for a joint certificate demo (D5) | You |

### I. The story (Must, week 3)

| # | Task |
|---|---|
| I1 | **Film, under 3 minutes, shaped to the judging brief** (problem, core features, users and business model, ecosystem tools). Cold open on the Floor filling up live. One holder's circuit, run and paid for by nobody. One FabX miner certified across 262,144 inputs, then a broken copy caught on its exact failing input. The 42,003× CPU number. Agents: "is my miner correct?" Close on the TAP draft. Chinese subtitles. I write the script and shot list; you record |
| I2 | `docs/submission.md` and `.zh.md` rewritten around the new product, field by field against the form: product, users and how we reach them, revenue model, why they pay and keep using it, processor and circuit IDs, access link, ecosystem features used, what was added during the event |
| I3 | README rewritten top-down: the goal, the Floor, certificates, the protocol, then the old headline numbers as proof |
| I4 | **Submit by 5 Dec, not on the last day** (you) |

**Business model as pitched:**

- **Certificates:** a fee per certificate, priced per billion steps checked. Miners verify before burning
  transistors, and a certified miner is easier to sell on circuit markets.
- **Runs:** the job fee, with a 2% protocol cut.
- **Hosted watching:** a subscription for teams that want their jobs watched with uptime guarantees.

The "easier to sell" claim and the prices are hypotheses: test them with the first five holders before
the film states them.

### J. Housekeeping (Should, any time)

- J1: Add a LICENSE file (MIT, as `package.json` already claims).
- J2: Cut World: remove it from the site nav, the MCP defaults, the README and both write-ups. Keep the
  code in `contracts/` with a note that it is not launched.
- J3: Mark `0xe29F…E710` as retired everywhere once v2 is live. Keep `docs/mainnet-run.md` as the record.
- J4: Delete the stale `overclock-mcp` Render service (you, from its dashboard).
- J5: Test count and docs kept in step with each change.
- J6: The kickoff prompt in HANDOFF.md says to push to `main`. Cloud sessions work on a branch and open a
  pull request instead, so merge those before Render deploys.

## 5. Timeline

| When | Me | You |
|---|---|---|
| **Mon 16 – Wed 18 Nov** | A1–A3 with tests; C1 sweep started; D-day-1 research; E8, J1, J2 | H1 register, H2 Telegram and grant ask, H4 FabX questions |
| **Thu 19 – Sun 22 Nov** | A4–A6; B1, B4; D1 bench generator; E1–E3 | Deploy v2 on testnet; decide D (19 Nov); deploy v2 on mainnet |
| **Mon 23 – Sun 29 Nov** | B2 streaming, B3 runner live; D2–D4; E4–E7; F1–F2; G TAP draft and `overclock-js` | Fund the runner wallet; outreach batches (H3); open the TAP PR; partner ask (H7) |
| **Mon 30 Nov – Thu 3 Dec** | 10B-step flagship job; G DeWEB/TapeSend if funded; I1 script, I2, I3; H6 thread drafts | Record the film; post the thread |
| **Fri 4 – Sat 5 Dec** | Final pass, every link checked | **Submit** |
| **Sun 6 – Fri 18 Dec** | Keep the runner running; fixes | Votes (H5), Demo Day prep if shortlisted |

## 6. How each judging criterion is answered on 7 Dec

| Criterion | Before | After |
|---|---|---|
| User value and commercial potential | A census and zero outside users | Every stuck machine run, holders contacted with their own page, certificates for FabX miners, a paid certificate product |
| Innovation | One-gate fraud proofs | Plus exhaustive Proof of Design over input spaces no block can hold, 16-way disputes, forced errors, 10B steps |
| Ecosystem integration | Circuits deep; the rest rehearsal | Circuits, FabX, X Layer and OKX Wallet live; DeWEB and TapeSend live if funded; a TAP standard submitted; a library for TapeCode apps |
| Product readiness and UX | Testnet browser flow; old contract | v2 on mainnet; an owner finds their circuit in one step; Chinese and English |
| Demo video | Not recorded | Recorded around one owner's circuit and one certificate |

## 7. Decisions I need from you

1. **Spend the 0.0024 OKB** on the mainnet v2 deploy, about 100 runs and one flagship certificate.
   (Recommended: yes.)
2. **Send the grant ask this week.** (Recommended: yes; everything in G that costs money depends on it.)
3. **Cut World** from the product and pitch. (Recommended: yes; it is a game and it weakens the story.)
4. **`overclock-js` for TapeCode apps:** a library, no game design. (Recommended: Should, built in week 2.)
5. **The testnet operator key** lives only on Render. To redeploy the playground I need either that key
   set as a Render env var on a new deploy, or a fresh funded testnet key from you.

## 8. Risks and fallbacks

| Risk | Fallback |
|---|---|
| No Gate Challenge specs and no templates | Equivalence certificates (D2 third option); the Floor carries the user story |
| No grant by 1 Dec | DeWEB through FabX hosting; TapeSend described as designed and tested on the fork, not claimed as live |
| 10B steps too slow on one machine | Ship the largest that settles (1B is the floor) and publish the timing |
| Runner wallet runs dry mid-December | It pauses; pages show the last result |
| A conformance mismatch is our bug | Fix it before anything else; the mainnet runs depend on it |
| Holders don't reply | Their circuit still ran and the page still exists; the film shows the Floor, not replies |
| v2 has a new bug | Every change lands with a proof-of-concept test and the solvency invariant extended to it; testnet before mainnet |

## 9. What we cut, and why

- **Overclock World and any game:** you don't want a game, and a demo game dilutes the claim that
  Overclock runs other people's machines.
- **Running FabX miners for N beats:** meaningless to their owners. Certificates replace it.
- **Flagship run of TapeOut's own CPU (Behemoth) or SHA-256 miner:** neither appears among the stuck X
  Layer circuits in the census. The 10B-step job on a holder's machine is the flagship instead.
- **A standing bounty:** a wrong *finalized* result can't be judged on-chain without the claimant's trace.
  Forced errors (A4) give the same public proof that watching works.
