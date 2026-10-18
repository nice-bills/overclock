# Overclock demo film: script and shot list

Target length 2:40, under the recommended 3 minutes. About 380 words of voiceover at a calm pace.
Every on-chain clip comes from the mainnet run in [mainnet-run.md](mainnet-run.md), so nothing in the
film is a simulation except the one shot that says so.

## Before recording

- Browser at 1920×1080, 125% zoom, dark theme. OKLink tabs open for the transactions below, in order.
- Replay page built from the **mainnet** run (`web/live-run.json`), not the local one, and opened from
  its DeWEB address if it's live by then, otherwise from disk.
- A terminal with a large font (20pt+) in the repo, and Claude Code with the Overclock plugin
  installed, pointed at `https://rpc.xlayer.tech`.
- Record each shot separately; the voiceover is recorded last against the cut.

## Script

| # | Time | On screen | Voiceover |
|---|---|---|---|
| 1 | 0:00–0:12 | Black, then the 8×8 Life board animating on the replay page. Caption: **441,085,640 gas**. | "This is Game of Life, taped out on TapeOut as 3,712 NAND gates. Running 40 generations on-chain takes four hundred and forty million gas. That's more than two full X Layer blocks. It can't be sent." |
| 2 | 0:12–0:22 | Terminal: `eth_estimateGas` for one `step()` call, 11.0M per generation, then the 210M block limit. | "Every big TapeOut machine hits this wall: CPUs, games with memory, circuit-AI. ZK proofs help for stateless circuits, but they can't handle LATCH." |
| 3 | 0:22–0:32 | Title card: **Overclock**. Under it: *Optimistic execution for TapeOut circuits on X Layer.* | "Overclock runs them anyway. Off-chain, with a bond, and a one-gate check if anyone lies." |
| 4 | 0:32–0:47 | OKLink: [postJob](https://www.oklink.com/x-layer/tx/0x8c75adfb5da685237bc456ccdeba59ae207c365434b73ba1130aaa4a0971bf2c). Highlight circuit #5 and processor `0xb00f…5971`. | "Here's the job on X Layer mainnet: circuit number five, forty generations, a small fee. An operator runs it off-chain with a bit-exact TapeOut evaluator and claims the result with a bond." |
| 5 | 0:47–1:00 | Replay page: the cheat's board next to the honest one; the one wrong cell at generation 25 flashes red. Then OKLink: [the cheat's claim](https://www.oklink.com/x-layer/tx/0xb959394b47e6523f6877da8b00395410cf6c19ab5ef74ac75967b6b867659677). | "This operator is a cheat. It flipped one NAND gate, in generation twenty-five, cell three-two. One step out of a hundred and eighty-one thousand." |
| 6 | 1:00–1:25 | Replay page bisection view: the trace halving level by level, 18 down to 1. Cut between it and a fast scroll through the 36 reveal and pick transactions in mainnet-run.md. | "A watcher re-runs the job for free, sees a different result, and challenges. The cheat has to reveal its trace in halves; the watcher picks the half that's wrong. Eighteen rounds take a hundred and eighty-one thousand steps down to one." |
| 7 | 1:25–1:45 | OKLink: [resolveLeaf](https://www.oklink.com/x-layer/tx/0xa4fbe532791e6220310618304ce7f4f908a80411a887986984e0c7819a2a0bff), gas used 347,509, then its internal transfer of the bond to the watcher. | "Then the contract checks that one gate. It reads the gate straight from TapeOut's on-chain netlist, takes its two inputs from Merkle proofs, and computes a single NAND. The cheat loses its bond to the watcher." |
| 8 | 1:45–2:00 | OKLink: [honest claim](https://www.oklink.com/x-layer/tx/0x75779e7f684c3fbe11cd3b68142e726149da990d283c438fb528e784abcd66c9) and [finalize](https://www.oklink.com/x-layer/tx/0x2c45bc0c13bf1a3c2234c98d1fa1665482c6ece5cb55e8b2bc57e50035a863c6). Then terminal: `result(0)` decoded as a board, side by side with an independent simulation. | "An honest operator claims, nobody challenges, and it finalizes. A hundred and eighty-two thousand gas instead of four hundred and forty million. Any contract can now read the result, and it matches." |
| 9 | 2:00–2:15 | Claude Code: "Is job 0 on Overclock correct?" The agent calls `get_job` and `verify_claim` and answers. | "It's built for agents too. The Overclock MCP server lets any AI agent verify a result before trusting it, buy computation, or run as a watcher and earn." |
| 10 | 2:15–2:30 | Card: who pays and why. *Machine builders · apps that read results · operators and watchers.* Then: *2% protocol fee on every job that finalizes.* | "Machine builders pay to run what they can't run any other way, and they pay every turn their machine takes. Operators and watchers earn fees and bonds. The protocol takes two percent of every job that finalizes." |
| 11 | 2:30–2:40 | End card: Overclock, the contract address, github.com/nice-bills/overclock, DeWEB address. | "Every circuit ever taped out can now run at any size. Overclock, live on X Layer." |

## Shot list

| Shot | Source | How to capture | Notes |
|---|---|---|---|
| A. Board animation | Replay page, mainnet run | Screen capture, 8 s | Crop to the board; no browser chrome |
| B. Gas wall | Terminal | `cast estimate` or the line from `scripts/demo.js --live` that printed 11.0M per generation | Keep the 210M block limit on screen |
| C. Title card | Editor | Static | Same font as the replay page |
| D. postJob | OKLink | Screen capture, slow scroll to input data | Zoom on circuit ID and processor |
| E. Cheat vs honest board | Replay page | Screen capture | The single red cell is the money shot; hold it 2 s |
| F. Cheat's claim | OKLink | Screen capture | |
| G. Bisection | Replay page plus mainnet-run.md | Screen capture, then a 3 s scroll of the tx table | Speed the scroll up 4×, no audio |
| H. resolveLeaf | OKLink | Screen capture of gas used and internal transactions | Circle 347,509 and the bond transfer |
| I. Honest claim and finalize | OKLink | Screen capture | |
| J. Result matches | Terminal | Decode `result(0)` next to a JS Life run | Two boards side by side, identical |
| K. Agent | Claude Code | Screen capture of one real prompt and answer | Read-only tools, no wallet configured |
| L. Who pays card | Editor | Static, three short lines | |
| M. End card | Editor | Static | Contract address in monospace |

## Edit notes

- Captions on every number; many judges will watch muted.
- No music under shots 7 and 8, so the one-gate moment lands.
- Export 1080p, H.264, under 100 MB. Upload unlisted to YouTube and link it in the README and the form.
- A 简体中文 subtitle track is worth the hour: the TapeOut community is largely Chinese-speaking.
