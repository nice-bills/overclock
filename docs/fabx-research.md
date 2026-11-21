# FabX Gate Challenges and FAB-Genisis miners: what is published, what is verified

Research for Overclock workstream D, 17 Nov 2026. Every number below is reproducible from X Layer
mainnet with `node scripts/miner-shapes.js --verify`. Chain reads are free `eth_call`s against
`https://rpc.xlayer.tech`; no keys, transactions or signatures were used.

**Short answer.** FabX publishes 100 Gate Challenges (`GC-001` … `GC-100`) as an on-chain task record,
256 official input/output vectors, and one official reference circuit per task. It does not publish a
prose specification for any challenge: the task name is the only description, and the design skill says
to "infer the function from the task name and the vectors". A miner is "verified" when it passes a
**sample** of those vectors at claim time, not all of them; the sample is 3–32 vectors, chosen by circuit
size. Of 6,866 task claims on the live FAB-Genisis processor, 63.4% are byte-identical copies of the
official reference. We also found three (challenge, netlist) pairs that are marked verified on-chain but
fail the official vectors, including a one-gate constant-zero stub claiming an 8-bit equality comparator.

## 1. Where the challenges are published

| Source | What it gives |
|---|---|
| [`fabx.tech/en/pod/tasks`](https://fabx.tech/en/pod/tasks) | The task board: 100 challenges, grouped, with reference gate counts, costs and the tape-out/verify UI |
| [`fabx.tech/en/pod/algo`](https://fabx.tech/en/pod/algo) | Mining mechanics: eligibility, claim, sample check, best-design seat, 99/1 reward split |
| [`fabx.tech/en/pod/formula`](https://fabx.tech/en/pod/formula) | Cost `C`, quality `q`, hashrate `H` and the bonus formula |
| `GET https://api.fabx.tech/v1/pod/tasks?chainId=196` | Machine-readable task list: `taskId`, `name`, `kind` (0 combinational, 1 sequential), `nIn`, `nOut`, `cycles`, `refGates`, `refDepth`, `cRef`, `vectorCount` (256) |
| `GET https://api.fabx.tech/v1/pod/tasks/{id}/vectors?chainId=196` | 256 vectors `{index, input, expectedOut, proof}`, with the task's `root` and leaf encoding |
| `GET https://api.fabx.tech/v1/pod/taskbank?chainId=196` | Group names, totals (54 combinational, 46 sequential, 7,591 NAND + 380 LATCH across the 100 references) |
| `GET https://api.fabx.tech/v1/pod/skill.md` | The agent-facing design guide: netlist format, bit order, cost, verify API |
| [`@Fabx_global`](https://x.com/Fabx_global) | Announcements; no per-challenge specification thread found |
| `0x265E2580cB9c3FC059f2AA3cf20ad30F3F0A653C` | The reference processor. `refCircuits` for every task, `refCircuitId == taskId`, multiplier 0 (reference only, cannot mine) |

`GET https://api.fabx.tech/v1/pod/state?chainId=196` reports the live parameters: PodMining at
`0x4F6A2312D80753BdAFd35DDB1Bf4BB14C43F8265`, 100 tasks, 6,978 miners, 6,862 in the verified pool,
`UNVERIFIED_BPS=100` (the 1% unverified pool), and multipliers of 6 for `0x87BF…F9a6` and 0 for
`0x265E…653C`.

There is no public protocol/spec repository. The `Name` field is a short Chinese label such as
`GC-098 四路4位数三段流水排序网络` ("four-way 4-bit three-stage pipelined sorting network"); the vector set
and the reference circuit are the actual definition.

## 2. What "verified" means

FabX's own mechanics page describes the claim step:

> Submit official test vectors. The contract runs the circuit and compares the results bit by bit.
> Circuit size determines the sample count.

The public getters on PodMining confirm the sampling:

```
MIN_SAMPLES()        = 3
sampleGasBudget()    = 8,000,000
maxRunGas()          = 60,000,000
sampleCountFor(gates, state) = 32 at <= 66 gates, 14 at 162, 5 at 463, floor 3
```

So "verified" is an **optimistic, sampled** claim: a circuit becomes a verified miner (`status = 1`,
`verifWeight > 0`) after passing a handful of Merkle-proved vectors. It enters the verified pool, which
receives 99% of output by hashrate; the unverified pool (circuits without a task claim) receives 1% by
burn. A wrong claim is removed when someone registers a counterexample against it; the contract does not
re-run the full vector set by itself.

The off-chain verify API is stricter than the chain: `POST /v1/pod/verify` runs all 256 vectors and
reports `firstFailure`, but it only checks a design and never sends a transaction. The user then tapes
out and claims on-chain, where the sampled check happens.

This gap matters. For a challenge whose 256 vectors are mostly zeros, a constant-zero circuit passes a
3-sample check with high probability. Our scan found exactly that:

| Circuit | Challenge | Netlist | Declared | On-chain status | Fails |
|---|---|---|---|---|---|
| [#4890](https://www.oklink.com/x-layer/address/0x87BFCa3494Aa228fF589ab9B642143A5e8c8F9a6) | GC-013 four-bit equality comparator | `0x00000001000001` (`NAND(1,1)` = constant 0), 1 gate | 8 in / 1 out / 0 state | status 1, `verifWeight` 600 | vector 0: input `0x00` expects `0x01`, gets `0`; 240/256 vectors expect 0 |
| #2346 | GC-094 8-bit UART receiver | 16 gates | 2 in / 11 out / 2 state, 5 cycles | status 1, `verifWeight` 9,600 | vector 17, cycle 4: expected output bit 1, gets 0; 221/256 pass |
| #4897, #4898 | GC-014 four-bit all-zero detector | same constant-zero netlist, 1 gate | 4 in / 1 out | status 1 | all-zeros input expects 1, gets 0 |

The GC-013 stub is not a freak accident: 240 of its 256 vectors expect output 0, so three independent
samples all land on zero with probability `(240/256)^3 ≈ 0.82`. On-chain `step(4890, …, 0x00)` and
`step(4890, …, 0xff)` both return `0x00`; the first official vector expects `0x01`. Nine circuits share
this stub (seven on GC-013, two on GC-014), and all are counted in the verified pool.

This is the exact failure mode Overclock's certificate removes: run every input, not a sample.

## 3. The two FAB-Genisis processors

From `docs/census.json` (`heldBack` entries with processor name `FAB-Genisis`):

| Processor | `nextId` | Circuits read | Multiplier | Miners | Reference copies |
|---|---:|---:|---:|---:|---:|
| `0x87BFCa3494Aa228fF589ab9B642143A5e8c8F9a6` | 7,018 | 7,017 | 6 | 6,993 | 4,354 |
| `0x00586A4C37039aCbFC6aC135cAdd49367ABf390A` | 34 | 33 | 0 | 0 | 0 |

The old processor `0x0058…390A` holds 33 circuits in 12 distinct netlists, all unclaimed; with multiplier
0 it is not a mining target. The live processor carries effectively the whole challenge. Totals across
both: 7,050 circuits, 6,866 claims (`taskId > 0`), 184 unclaimed, 1,360 distinct netlists, 991
`nIn/nOut/nState/gates` families.

The only two circuits whose decoded element count differs from `circuitInfo.gateCount` are unclaimed REF
circuits (#6053, #6147): `gateCount` flattens referenced subcircuits, the netlist itself holds one REF.
Every claimed miner decodes to exactly its declared gate count.

## 4. Method

1. Enumerate `circuitInfo(id)` and `netlist(id)` for every id below `nextId()` on both processors, in
   Multicall3 batches.
2. Decode with the local TAP-02 decoder (`src/tap02.js`), the same one `tap02.test.js` checks against the
   vendor vectors.
3. Group by `(nIn, nOut, nState, gateCount)` and by `keccak256(netlist bytes)`. A second hash canonicalises
   signal numbering; on this data the two hashes group identically except where the same byte string is
   reused with a different `nIn`, so the byte hash is the shape key.
4. Map each circuit to its claim with `minerKey` + `getMiner` (not the API, which drifts by a few ids).
5. Read `getTask` for all 100 tasks and `getTask → refCircuits/refCircuitId` for the official references.
6. Download the 256 official vectors per claimed task and run them through `load`/`beat`. Sequential tasks
   are run for `cycles` frames from all-zero state.
7. Deduplicate by `(taskId, netlistHash)` so a netlist reused across two challenges is checked against both.

## 5. Structural shapes on the live processor

Top 30 of 1,361 shapes, ordered by circuit count. `refCopies` is the number of copies byte-identical to
that challenge's official reference. `vectors` is the result of running all official vectors; `n/a` means
unclaimed.

| copies | refCopies | shape `nIn/nOut/nState/gates` | structHash | tasks | verdict | vectors |
|---:|---:|---|---|---|---|---|
| 1491 | 1490 | `4/4/0/20` | `0x41ffe37e` | GC-048 ×1490 | YES-vectors | pass |
| 403 | 403 | `9/5/0/66` | `0x404d0f14` | GC-031 ×403 | YES-ref | pass |
| 286 | 284 | `1/1/0/3` | `0xada89efb` | GC-001 ×284 | YES-vectors | pass |
| 212 | 212 | `18/17/51/463` | `0xaea4d6ce` | GC-098 ×212 | NO-degenerate | pass (vacuous) |
| 207 | 0 | `18/17/50/50` | `0x79ea0600` | GC-098 ×207 | NO-degenerate | pass (vacuous) |
| 182 | 171 | `2/1/0/3` | `0xc738359c` | GC-002 ×171 | YES-vectors | pass |
| 155 | 154 | `1/1/1/3` | `0xde036cec` | GC-027 ×154 | YES-ref | pass |
| 139 | 139 | `10/8/8/162` | `0x0c9ac1aa` | GC-086 ×139 | YES-ref | pass |
| 137 | 136 | `7/6/10/84` | `0x43285d03` | GC-100 ×136 | YES-ref | pass |
| 121 | 0 | `9/5/0/72` | `0x93176d06` | GC-031 ×119 | YES-ref | pass |
| 110 | 110 | `11/8/0/248` | `0x7befa3ac` | GC-081 ×110 | YES-ref | pass |
| 101 | 0 | `1/1/1/1` | `0xb55a4602` | GC-027 ×100 | YES-ref | pass |
| 96 | 0 | `8/4/0/115` | `0x610dd2a2` | GC-046 ×96 | YES-vectors | pass |
| 77 | 76 | `2/11/24/242` | `0x3d7a1fdc` | GC-094 ×76 | YES-ref | pass |
| 68 | 0 | `1/1/0/1` | `0x30df9b0a` | GC-001 ×65 | YES-vectors | pass |
| 66 | 66 | `2/1/0/6` | `0x12e42b9a` | GC-005 ×66 | YES-vectors | pass |
| 66 | 66 | `7/10/13/151` | `0xe0b5272c` | GC-095 ×66 | YES-ref | pass |
| 56 | 56 | `10/4/16/195` | `0xbf2bd56c` | GC-079 ×56 | YES-ref | pass |
| 51 | 0 | `18/17/182/200` | `0xc7751299` | GC-098 ×51 | NO-degenerate | pass (vacuous) |
| 47 | 0 | `17/9/0/140` | `0x6c21b829` | — | NO-unclaimed | n/a |
| 38 | 38 | `7/5/5/83` | `0x88cd152e` | GC-070 ×38 | YES-ref | pass |
| 38 | 38 | `12/7/6/84` | `0xb77edc0f` | GC-090 ×38 | YES-ref | pass |
| 36 | 36 | `6/7/15/172` | `0xb3892f49` | GC-097 ×36 | YES-ref | pass |
| 36 | 36 | `2/1/3/35` | `0xff3e6dc8` | GC-064 ×36 | YES-ref | pass |
| 35 | 35 | `8/17/0/176` | `0x531b17db` | GC-088 ×35 | YES-vectors | pass |
| 33 | 33 | `9/5/0/119` | `0x590a5f8f` | GC-032 ×33 | YES-ref | pass |
| 31 | 0 | `1/1/0/500` | `0xa190fe77` | GC-001 ×31 | YES-vectors | pass |
| 29 | 29 | `13/8/20/329` | `0x2f6de0aa` | GC-099 ×29 | YES-ref | pass |
| 28 | 27 | `2/1/0/4` | `0xdb92c1cd` | GC-003 ×27 | YES-vectors | pass |
| 27 | 27 | `8/8/0/104` | `0x9ebf44df` | GC-051 ×27 | YES-vectors | pass |

Verdict legend:

- **YES-vectors** — the 256 official vectors cover every input combination (all `2^nIn` inputs, `cycles = 1`).
  A truth-table certificate is complete: no reference equivalence argument is needed.
- **YES-ref** — the vectors sample the input space (sequential tasks, or combinational tasks with `nIn > 8`).
  Certify equivalence against the official on-chain reference, which exists for all 100 tasks.
- **NO-degenerate** — the official vectors are constant, so passing them proves nothing. Needs an
  independently reconstructed spec.
- **NO-unclaimed** — no challenge is claimed by this netlist.

Verdicts by shape: 449 shapes / 3,500 circuits are YES-vectors; 829 / 2,855 are YES-ref; 34 / 558 are
NO-degenerate (all GC-098); 49 / 137 are unclaimed.

### What the shapes say about "templates"

- 4,354 of 6,866 claims (63.4%) are **byte-identical** to the official reference. The largest shape,
  `4/4/0/20` on GC-048, is 1,490 reference copies out of 1,491 circuits.
- Of 1,314 distinct `(challenge, netlist)` pairs, 100 are the reference itself, 39 are **derived** from it
  (a one- or two-gate edit: 29 have at most two changed gates, the rest a larger suffix change), and
  1,175 are independent redesigns. So there is template reuse, but most distinct non-reference netlists
  are genuine alternative designs rather than trivial mutations.
- The five largest families hold 2,624 circuits (37% of the processor). The top 30 shapes hold 4,402
  circuits (62.4%); the remaining 1,331 shapes hold 2,648.

## 6. The GC-098 finding: a challenge whose vectors are all zero

`GC-098 四路4位数三段流水排序网络` is a four-way, 4-bit, three-stage pipelined sorting network:
18 inputs, 17 outputs, 51 state bits, 2 cycles, reference 463 gates.

- The official reference (circuit 98 on `0x265E…653C`) outputs **all zeros on all 256 vectors**.
- All 256 vectors have `expectedOut = 0x0000000000000000000000000000000000` (17 zero bytes).
- The reference itself is claimed 212 times on the live processor; those copies all "pass" the vectors
  because they match the reference's zero output.
- A second shape, `18/17/50/50`, is a 50-LATCH zero-output stub with no logic at all. All 207 of its
  circuits are marked `status = 1` (verified pool) and claim GC-098. It has zero reference copies.

We checked the chain directly: `step` on a reference copy (#310) returns `0x000000` for
`0x000000`, `0xffffff` and `0x010203`, while its state changes. A brute-force search over all `2^18`
first-frame inputs and 20,000 random two-frame pairs produced no non-zero output. The circuit is not a
sorter; the challenge as published cannot distinguish a sorter from a constant zero.

Consequence for Overclock: GC-098 is the one challenge where neither a truth-table certificate nor
reference equivalence proves the advertised function. The only honest certificate is a spec-based one:
reconstruct the pipelined sorter in `src/hdl.js`, then prove the miner equivalent to that reference. Until
then, any "GC-098 certified" claim should carry the explicit caveat "equivalent to the published
reference, which is constant zero".

The other 99 challenges are not vacuous, but 53 of them are only sampled by the 256 vectors (sequential
tasks and the eight combinational tasks with more than 8 inputs); for those the certificate has to be an
equivalence proof against the official reference, not a truth table.

## 7. Which challenges can be certified how

| Certificate source | Challenges | Notes |
|---|---|---|
| Exhaustive official vectors (`YES-vectors`) | 46 | All combinational with `nIn <= 8`: 1–25, 34–40, 43–51, 53–55, 87–88. `2^nIn <= 256`, so the 256 vectors are the whole input space. |
| Official reference equivalence (`YES-ref`) | 53 | The 46 sequential tasks plus combinational 26, 31, 32, 33, 41, 42, 52, 81 (`nIn` 9–18). The reference exists on `0x265E…` with `id == taskId` for every task. |
| No sound certificate from published data (`NO-degenerate`) | 1 | GC-098, above. Needs an independent spec. |

For a miner derived from the template but not byte-identical, the same certificate applies to the pair
(miner, official reference). Overclock can also certify equivalence to the *family template* when a shape
has no official reference in its family, but on this processor every claimed shape's task does have one,
so the official reference is always the better anchor.

`npm test` and the scanner output below are the evidence. `scripts/miner-shapes.js` reproduces the
shape table, the reference-copy count and the vector verification from chain.

## 8. Reproducing

```sh
npm ci --include=dev
node scripts/miner-shapes.js --verify --top 30 --json /tmp/miner-shapes.json
npm test
```

Observed on 17 Nov 2026, block 76,147,453 (chain 196):

```
chain 196, block 76147453
processors: 0x87BFCa3494Aa228fF589ab9B642143A5e8c8F9a6, 0x00586A4C37039aCbFC6aC135cAdd49367ABf390A
tasks: 100; on-chain references: 100
  0x87BFCa3494Aa228fF589ab9B642143A5e8c8F9a6: nextId 7018, read 7017, multiplier 6, miners 6993, reference copies 4354, decode mismatches 2
  0x00586A4C37039aCbFC6aC135cAdd49367ABf390A: nextId 34, read 33, multiplier 0, miners 0, reference copies 0, decode mismatches 0

verification: 1311/1314 distinct (challenge, netlist) pairs pass all official vectors; 3 fail; 0 skipped; 3 shapes contain a failure
  FAIL 0x87BFCa3494Aa228fF589ab9B642143A5e8c8F9a6 #2346 GC-094: 221/256 {"index":17,"cycle":4,"input":"0x0302000200","expected":"0x00000000000001000004","got":"10000000000"}
  FAIL 0x87BFCa3494Aa228fF589ab9B642143A5e8c8F9a6 #4890 GC-013: 240/256 {"index":0,"cycle":0,"input":"0x00","expected":"0x01","got":"0"}
  FAIL 0x87BFCa3494Aa228fF589ab9B642143A5e8c8F9a6 #4897 GC-014: 240/256 {"index":0,"cycle":0,"input":"0x00","expected":"0x01","got":"0"}
```

`npm test` passes 203/203 tests (21 Nov), including the nine in `test/miner-shapes.test.js`.

The test file `test/miner-shapes.test.js` covers the grouping/hash logic and the vector runner on the
local TAP-02 vectors (`vendor-tap02/vectors.json`): `describeNetlist` gate counts and hashes, shape and
family keys, identical/derived/independent diffs, exhaustive coverage detection, degenerate detection,
and the verdict rules including GC-098. `npm test` runs it with the rest of the suite.

## 9. Limits of this research

- The scanner reads the chain at one block; the task count and miner set move. Re-run for current numbers.
- The 256-vector API sets are trusted as the official sets because their Merkle roots match
  `getTask(id).vectorsRoot` on-chain for the tasks we checked (13, 94, 98); the scanner does not verify
  every proof leaf.
- We did not exercise the counterexample/challenge path of PodMining. We observed its public parameters
  (`MIN_SAMPLES`, `sampleGasBudget`, `maxRunGas`) and the verified/unverified pool split.
- API metadata drifts from the contract (`taskbank.maxRunGas` 12,000,000 vs on-chain 60,000,000; task
  and miner counts differ by a few). The scanner therefore reads tasks, claims and netlists from the
  contract, not the API, except for the vector payloads.
