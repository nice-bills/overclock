# Overclock film: script and shot list

Target length **2:50**, under the 3-minute limit. About 365 words of voiceover at a steady pace. Shaped to
the judging brief in this order: the problem (shots 1–2), the core features (3–9), agents (10), users and
business model (11), ecosystem tools and close (12). Every shot has a Chinese subtitle line. There is no
game in this film.

## Rules for the film

- **Say only what exists.** v2 is not on mainnet yet, so on-screen captions say *v1 mainnet* or *local EVM, v2*
  next to every number, exactly as in the table below. Do not say v2 is live. Do not call the 8 existing
  certificates "on X Layer": they were issued on a local chain.
- **No certified-miner claim at 262,144 inputs unless one exists.** The only 18-input challenge, GC-098,
  has an all-zero reference, so its sweep (262,655 inputs) is shown as a finding (shot 9), not as a
  pass. If a sound large certificate is produced before recording, use it in shot 8.
- **No prices, and no "certified miners sell more easily".** Both are hypotheses
  ([PLAN.md](../PLAN.md), section I) until five holders have been asked.
- **Muted-friendly.** A caption on every number. The Chinese subtitle track is burned in below the English
  one.

## Before recording

Things the film needs that must exist first. If one is missing on the day, use the fallback; don't fake it.

| Needs | Why | Fallback |
|---|---|---|
| The v2 site build (`node scripts/build-web.js`, open `web/overclock.html`) with the Floor and a real runs index | Shots 1 and 7 | Floor with the three mainnet runs and the rest queued; do not recolour cells by hand |
| One holder's circuit actually run by the runner (e.g. LoteGate #3, FAB-Genisis #1755), with its circuit page | Shot 7 | The `#try` page for the same circuit, showing the direct-vs-Overclock cost; say "queued" if it has not run |
| The `npm run demo` output and replay, recorded fresh | Shots 4, 5 | The numbers are in `web/demo-run.json` |
| The certificate files in `docs/certificates/` | Shots 8, 9 | None needed; they are committed |
| An MCP tool that answers "is this miner correct?" (PLAN F1: `certify`, `get_certificate`) | Shot 10 | `describe_circuit` and `verify_claim` on job 2, as in the v1 film |

Browser at 1920×1080, 125% zoom, dark theme. OKLink tabs open for the v1 mainnet transactions, in order. A
terminal with a 20pt+ font in the repo. Record each shot separately; record the voiceover last against the
cut.

## Script

| # | Time | On screen | Voiceover | 中文字幕 |
|---|---|---|---|---|
| 1 | 0:00–0:10 | Cold open on the Floor (`#floor`): a grid of grey squares, each a circuit on X Layer; the ones with a run turn green. Caption: **1,014 machines a block can't run 1,000 beats of · 213 wallets**. | "Each square is a machine on X Layer too big for the chain to run. One thousand and fourteen of them, held by two hundred and thirteen wallets." | 每个方块都是 X Layer 上链跑不动的机器：共 1,014 台，由 213 个钱包持有。 |
| 2 | 0:10–0:26 | Terminal: `npm run demo` output line **directly on-chain: 4,340,286,700 gas** next to the 210M block limit. Then FabX's task page: 256 official vectors, "sample 3–32". Caption: **local EVM, v2**. | "TapeOut runs a circuit gate by gate in one transaction. This board costs over four billion gas; a block holds two hundred and ten million. FabX calls a miner verified after three to thirty-two of two hundred and fifty-six test vectors." | TapeOut 在一笔交易里逐门运行电路。这块生命游戏棋盘要 40 多亿 gas，而一个区块只有 2.1 亿。FabX 只用 256 个测试向量中的 3 到 32 个，就把一台矿机标为"已验证"。 |
| 3 | 0:26–0:38 | The landing chip animation, one loop: claim, challenge, halving to one gate. | "Overclock runs them anyway. Off-chain, with a bond. If anyone lies, a one-gate check on X Layer catches them." | Overclock 照样能跑：在链下运行，附上保证金。谁作假，X Layer 上的单门检查就会抓住谁。 |
| 4 | 0:38–0:58 | Replay of the demo dispute (local EVM, v2): the cheat's board beside the honest one; the 6 rounds counting down 1,817,800 steps to one gate; then `resolveLeaf` **911,340 gas** and the bond split: half to the watcher, half to the treasury. | "A watcher re-runs the job for free and challenges. The cheat reveals sixteen nodes at a time; the watcher picks the wrong one. Six rounds take one point eight million steps down to one gate. The contract checks that gate. The loser's bond splits: half to the watcher, half to the treasury." | 监督者免费重跑并发起挑战。作假者每次展示 16 个节点，监督者选出错的那个。6 轮就把 180 万步缩小到一个门。合约只检查这个门；输家的保证金一半给监督者，一半进金库。 |
| 5 | 0:58–1:08 | Terminal: **241,840 gas** honest path against **4,340,286,700** directly. Caption: **17,947× less · local EVM, v2**. | "An honest result costs two hundred and forty-two thousand gas. Seventeen thousand nine hundred and forty-seven times less." | 诚实路径只需约 24.2 万 gas，比直接运行少 17,947 倍。 |
| 6 | 1:08–1:20 | OKLink: [CPU finalize](https://www.oklink.com/x-layer/tx/0xf9e3738e5cc9ce905197526b755579d2da0d416b6ba07d5cdbe0a717bfd2ea6d). Caption: **v1 mainnet: 34.3B gas, 163 blocks → 816,083 gas · 42,003× less**. | "On mainnet, a 4-bit CPU ran a program for ten thousand beats. Directly, that is a hundred and sixty-three blocks. Through Overclock, forty-two thousand times less." | 在主网上，一颗 4 位 CPU 运行了一万拍。直接运行需要 163 个区块；通过 Overclock，少 42,003 倍。 |
| 7 | 1:20–1:36 | A holder's circuit page (`#c/<processor>/<id>`): what it is, its owner, beats run, direct cost against Overclock cost, the transactions, the share link. Caption: **run for the owner · nobody asked**. | "This circuit belongs to someone who never asked. We ran it past what the chain allows. Their page shows what it is, what it cost, and every transaction." | 这个电路的主人从没开口要求过。我们替他们把它跑过了链上的极限；页面上有它是什么、花了多少，以及每一笔交易。 |
| 8 | 1:36–1:56 | Certificate for a sound miner (#325, GC-031 adder: **certified, 0 mismatches, all 512 inputs**). Then miner #4890, GC-013 comparator: marked verified by FabX, certificate **failed at input `0x00`**; the one-gate constant-zero netlist. Caption: **certificates issued on a local chain**. | "A FabX miner is a design that solves a Gate Challenge. Overclock checks it on every input, not a sample. This adder passes all five hundred and twelve. This comparator is marked verified on-chain. It is a single gate that always outputs zero, and it fails on the very first input." | FabX 矿机是解答 Gate Challenge 的设计。Overclock 检查的是每一种输入，而不是抽样。这个加法器 512 种输入全部通过；这个比较器在链上被标为已验证，其实只是一个恒输出 0 的单门电路，第一个输入就出错。 |
| 9 | 1:56–2:06 | Certificate for GC-098 (#310): **262,655 inputs swept · verdict withheld: unsound reference**. Highlight the constant-zero reference output. | "Sometimes the challenge itself is broken. GC-098's official reference outputs zero on all two hundred and fifty-six vectors, so passing it proves nothing. The certificate says so." | 有时挑战本身就有问题。GC-098 的官方参考电路在全部 256 个向量上都输出 0，通过它说明不了任何事；证书如实写明了这一点。 |
| 10 | 2:06–2:18 | Claude Code with the Overclock plugin: "Is my FabX miner correct?" The agent calls the tools and answers with the verdict. | "Agents can ask too: is my miner correct? One sentence, and a checkable answer." | AI 智能体也能直接问："我的矿机对吗？"一句话，得到一个可验证的答案。 |
| 11 | 2:18–2:36 | Card, three short lines: *Circuit owners · machine builders · apps that read results · watchers · agents.* Then *2% protocol fee on every job that finalizes · half of every slashed bond to the treasury · watchers paid by forced errors even when nobody cheats.* | "Owners get a page and a certificate. Builders run machines they could not run before. Watchers earn even when nobody cheats, because Overclock plants forced errors for them to catch. The protocol takes two percent of every job that finalizes." | 持有者得到页面和证书；构建者能运行以前跑不了的机器；监督者即使没人作假也有收入，因为 Overclock 会故意植入错误让他们去抓。协议对每个最终确认的任务收取 2%。 |
| 12 | 2:36–2:50 | The TAP draft ([docs/tap-optimistic-execution.md](tap-optimistic-execution.md)) scrolling past: trace layout, one-step semantics, contract interface. End card: Overclock · github.com/nice-bills/overclock · overclock-board.onrender.com. | "Built on TapeOut's netlists, REF and LATCH, on X Layer, against FabX's own references. And written up as a TAP, so anyone can run it. Overclock." | 基于 TapeOut 的网表、REF 和 LATCH，运行在 X Layer 上，对照 FabX 自己的参考电路；并写成了 TAP 草案，人人都能实现。Overclock。 |

## Shot list

| Shot | Source | How to capture | Notes |
|---|---|---|---|
| A. The Floor | v2 site build, `#floor` | Screen capture, 10 s, no browser chrome | Use the real runs index; hold the colour change 1 s |
| B. The wall | Terminal (`npm run demo`) and FabX task page | Terminal line for 4,340,286,700 gas; the FabX page for the sample check | Keep the 210M block limit on screen; caption "local EVM, v2" |
| C. Landing chip | Landing page, one full loop | Screen capture | Wait for the gas figures to finish counting up |
| D. The dispute | `npm run demo` output and the replay page | Screen capture, then the terminal lines for the 6 rounds and `resolveLeaf` | Hold "911,340 gas" 2 s; show the bond split in the contract log |
| E. Honest path | Terminal | The two gas lines side by side | Caption 17,947× |
| F. CPU on mainnet | OKLink (v1) | Screen capture of the finalize transaction | Hold the 34.3B → 816,083 caption 2 s; label it v1 |
| G. A holder's circuit | `#c/<processor>/<id>` in the v2 site build | Screen capture | Needs the runner to have run it; otherwise `#try` and say queued |
| H. Certificates | `docs/certificates/…-325.json`, `…-4890.json` | Editor or site page; zoom on `verdict`, `inputsCovered`, `firstFailingInput` | Caption "issued on a local chain" |
| I. GC-098 | `docs/certificates/…-310.json` | Zoom on `verdict` and the `degenerate-reference` finding | Show the constant output |
| J. Agent | Claude Code | One real prompt and answer | Read-only tools, no wallet; use a tool that exists on the day |
| K. Who pays card | Editor | Static, same font as the site | No prices |
| L. TAP draft and end card | Editor | Scroll the draft; static end card | End card shows the v1 contract only if v2 is still not live, labelled v1 |

## Edit notes

- Captions on every number; many judges will watch muted. English captions above, 简体中文 subtitles below.
- No music under shots 4 and 8, so the one-gate and the first-input moments land.
- Export 1080p, H.264, under 100 MB. Upload unlisted to YouTube and link it in the README and the form.
- Before export, check every number against [README.md](../README.md), "The numbers": 241,840 · 4,340,286,700
  · 17,947× · 911,340 · 2,551,174 · 14 transactions · 6 rounds · 42,003× · 816,083 · 11,552 of 11,552.
