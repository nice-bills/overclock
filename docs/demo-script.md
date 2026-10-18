# Overclock demo film: script and shot list

Target length 2:55, just under the recommended 3 minutes. About 420 words of voiceover at a brisk pace.
Every on-chain clip comes from the mainnet run in [mainnet-run.md](mainnet-run.md), so nothing in the
film is a simulation except the one shot that says so.

## Before recording

- Browser at 1920×1080, 125% zoom, dark theme. OKLink tabs open for the transactions below, in order.
- The site has three views: the landing page at https://overclock-board.onrender.com (an animated chip that loops
  through a job, a claim, a challenge and the halving), the live job board at `/#board`, and the
  replay at `/#replay`. Open the board once before recording so the hosted page is awake and has
  loaded every job.
- **The hosted replay is the local 16×16 run** (lie in generation 61, 1,817,800 steps), which doesn't
  match the narration. For the replay shots, build a copy from the mainnet run and record from that:
  `node scripts/build-web.js web/live-run.json film.html`, then open `film.html#replay`. It shows the
  8×8 board, the lie in generation 25 and 181,840 steps halved in 18 rounds (checked in headless Chromium).
- A terminal with a large font (20pt+) in the repo, and Claude Code with the Overclock plugin
  installed, pointed at `https://rpc.xlayer.tech`.
- Record each shot separately; the voiceover is recorded last against the cut.

## Script

| # | Time | On screen | Voiceover |
|---|---|---|---|
| 1 | 0:00–0:12 | Black, then the 8×8 Life board playing in the mainnet replay (`film.html#replay`). Caption: **441,085,640 gas**. | "This is Game of Life, taped out on TapeOut as 3,712 NAND gates. Running 40 generations on-chain takes four hundred and forty million gas. That's more than two full X Layer blocks. It can't be sent." |
| 2 | 0:12–0:22 | Terminal: `eth_estimateGas` for one `step()` call, 11.0M per generation, then the 210M block limit. | "Every big TapeOut machine hits this wall: CPUs, games with memory, circuit-AI. ZK proofs help for stateless circuits, but they can't handle LATCH." |
| 3 | 0:22–0:32 | Landing page (overclock-board.onrender.com): the headline "Run circuits too big for the chain." and the chip animating one loop: beats, claim, challenge, halving to one gate. | "Overclock runs them anyway. Off-chain, with a bond, and a one-gate check if anyone lies." |
| 4 | 0:32–0:47 | Job board (`/#board`): job 0 in the Jobs list, status final. Then OKLink: [postJob](https://www.oklink.com/x-layer/tx/0x8c75adfb5da685237bc456ccdeba59ae207c365434b73ba1130aaa4a0971bf2c). Highlight circuit #5 and processor `0xb00f…5971`. | "Here's the job on X Layer mainnet: circuit number five, forty generations, a small fee. An operator runs it off-chain with a bit-exact TapeOut evaluator and claims the result with a bond." |
| 5 | 0:47–1:00 | Mainnet replay (`film.html#replay`), "The lie, in generation 25": the cheat's board next to the honest one; the one wrong cell at generation 25 flashes red. Then OKLink: [the cheat's claim](https://www.oklink.com/x-layer/tx/0xb959394b47e6523f6877da8b00395410cf6c19ab5ef74ac75967b6b867659677). | "This operator is a cheat. It flipped one NAND gate, in generation twenty-five, cell three-two. One step out of a hundred and eighty-one thousand." |
| 6 | 1:00–1:20 | Job board (`/#board`): game 0 in the Disputes list with its moves. Then the mainnet replay's "Halving 181,840 steps down to one" ladder, 18 rows down to the wrong step. Cut between it and a fast scroll through the 36 reveal and pick transactions in mainnet-run.md. | "A watcher re-runs the job for free and challenges. The cheat reveals its trace in halves; the watcher picks the half that's wrong. Eighteen rounds take a hundred and eighty-one thousand steps down to one." |
| 7 | 1:20–1:35 | OKLink: [resolveLeaf](https://www.oklink.com/x-layer/tx/0xa4fbe532791e6220310618304ce7f4f908a80411a887986984e0c7819a2a0bff), gas used 347,509, then its internal transfer of the bond to the watcher. | "The contract reads that gate from TapeOut's on-chain netlist, takes its inputs from Merkle proofs, and computes one NAND. The cheat loses its bond." |
| 8 | 1:35–1:47 | OKLink: [honest claim](https://www.oklink.com/x-layer/tx/0x75779e7f684c3fbe11cd3b68142e726149da990d283c438fb528e784abcd66c9) and [finalize](https://www.oklink.com/x-layer/tx/0x2c45bc0c13bf1a3c2234c98d1fa1665482c6ece5cb55e8b2bc57e50035a863c6). Caption: **441M → 182K gas**. | "An honest operator claims, nobody challenges, and it finalizes. A hundred and eighty-two thousand gas instead of four hundred and forty million." |
| 9 | 1:47–2:05 | Job board (`/#board`): job 2. The Fibonacci program listing, then OKLink: [CPU finalize](https://www.oklink.com/x-layer/tx/0xf9e3738e5cc9ce905197526b755579d2da0d416b6ba07d5cdbe0a717bfd2ea6d). Caption: **34.3B gas, 163 blocks → 816K gas**. Then `result(2)`: a = 161, b = 225. | "Now a real computer. A 4-bit CPU, taped out on mainnet, running a Fibonacci program for ten thousand beats. Directly, that's a hundred and sixty-three blocks. With Overclock, eight hundred thousand gas, forty-two thousand times less. And a cheat was caught here too." |
| 10 | 2:05–2:20 | The 8×8 drawing of a 7, then the ten scores with 7 highlighted. OKLink: [digit-net finalize](https://www.oklink.com/x-layer/tx/0xcf992d6a5af2c575b2efa5c205bcae232413121a6e1ecc02230025a2d4021848). Caption: **161,080 gates, circuit #11 by AlephTape**. | "And someone else's circuit: AlephTape's hundred-and-sixty-one-thousand-gate digit net, run exactly as they taped it out. It reads a seven. The cheat said nine, and lost its bond." |
| 11 | 2:20–2:30 | Claude Code: "Is job 2 on Overclock correct?" The agent calls `get_job` and `verify_claim` and answers. | "Agents can use it too: verify a result before trusting it, buy computation, or run as a watcher and earn." |
| 12 | 2:30–2:45 | Card: who pays and why. *Machine builders · apps that read results · operators and watchers.* Then: *2% protocol fee on every job that finalizes.* | "Machine builders pay to run what they can't run any other way, every turn their machine takes. Operators and watchers earn fees and bonds. The protocol takes two percent of every job that finalizes." |
| 13 | 2:45–2:55 | End card: Overclock, the contract address, github.com/nice-bills/overclock, overclock-board.onrender.com. | "Every circuit ever taped out can now run at any size. Overclock, live on X Layer." |

## Shot list

| Shot | Source | How to capture | Notes |
|---|---|---|---|
| A. Board animation | `film.html#replay` (mainnet run) | Screen capture, 8 s | Crop to the board; no browser chrome |
| B. Gas wall | Terminal | `cast estimate` or the line from `scripts/demo.js --live` that printed 11.0M per generation | Keep the 210M block limit on screen |
| C. Landing | Hosted landing page | Screen capture of one full chip loop | Wait for the gas figures to finish counting up |
| D. Job board, then postJob | `/#board`, then OKLink | Screen capture of job 0 in the Jobs list, then a slow scroll to the tx input data | Zoom on circuit ID and processor |
| E. Cheat vs honest board | `film.html#replay` | Screen capture | The single red cell is the money shot; hold it 2 s |
| F. Cheat's claim | OKLink | Screen capture | |
| G. Bisection | `/#board` Disputes, `film.html#replay` ladder, mainnet-run.md | Screen capture, then a 3 s scroll of the tx table | Speed the scroll up 4×, no audio |
| H. resolveLeaf | OKLink | Screen capture of gas used and internal transactions | Circle 347,509 and the bond transfer |
| I. Honest claim and finalize | OKLink | Screen capture | |
| J. CPU | `/#board`, OKLink, terminal | Job 2 on the board; the program listing from docs/headline-demos.md; decode `result(2)` | Hold the 34.3B → 816K caption 2 s |
| J2. Digit net | Editor, OKLink | The drawing and score row from docs/headline-demos.md; the finalize tx | Credit AlephTape on screen |
| K. Agent | Claude Code | Screen capture of one real prompt and answer | Read-only tools, no wallet configured |
| L. Who pays card | Editor | Static, three short lines | Same font as the site |
| M. End card | Editor, or the landing page | Static | Contract address in monospace |

## Edit notes

- Captions on every number; many judges will watch muted.
- No music under shots 7 and 8, so the one-gate moment lands.
- Export 1080p, H.264, under 100 MB. Upload unlisted to YouTube and link it in the README and the form.
- A 简体中文 subtitle track is worth the hour: the TapeOut community is largely Chinese-speaking.
