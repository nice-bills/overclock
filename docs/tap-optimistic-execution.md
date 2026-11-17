# TAP draft: Optimistic Execution of Circuits

Status: **draft**. This file is the working copy in the Overclock repository. The planned next step
is to open a pull request against `TapeOutProtocol/TAPs` with this text (that step has not happened
yet). Sections marked **Planned** describe changes that are designed but **not implemented today**;
everything outside those sections describes the contract and code as they exist in this repository
on 17 Nov 2026.

| | |
|---|---|
| Standard | Optimistic execution of TapeOut circuits |
| Version | 0 (draft) |
| Depends on | [TAP-02](https://github.com/TapeOutProtocol/TAPs) (netlists, `NAND`/`LATCH`/`REF`, packed vectors §5) |
| Reference implementation | [`contracts/Overclock.sol`](../contracts/Overclock.sol), [`src/trace.js`](../src/trace.js), [`src/game.js`](../src/game.js) |
| Live deployment | X Layer mainnet, chain 196, [`0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710`](https://www.oklink.com/x-layer/address/0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710) (pre-audit build; see §7 note) |

## 1. Abstract

This standard defines how a TapeOut circuit — any circuit taped out through the TapeOut processor
factory — can be executed for an arbitrary number of beats off-chain, with the result settled
on-chain behind a bond and a challenge window. An operator runs the job with any TAP-02 evaluator,
commits a Merkle root over the execution-order trace, and claims the outputs and final state. Anyone
can re-run the job for free. A disagreement is narrowed to a **single step** — one `NAND`, one
`LATCH` read/write, one `REF` wire or one input — which the contract re-checks against the circuit's
immutable on-chain netlist. A dishonest party loses its bond; an honest result finalizes and becomes
readable by any contract.

The step is one gate because TAP-02 circuits are NAND trees with exact, published semantics stored
on-chain and never changed. No per-circuit ceremony, recompiling or trusted setup is required, and
`LATCH` state chains beats together, so stateful machines are covered — the two properties that make
this a complement to ZK proving rather than a competitor.

## 2. Definitions and notation

- **Circuit** `(cpu, id)`: a netlist recorded by a TapeOut processor contract at address `cpu`,
  circuit index `id`, with `nIn` inputs, `nOut` outputs, `nState` state bits (`circuitInfo`), and a
  record list of `NAND`, `LATCH` and `REF` elements (TAP-02 §4).
- **Beat**: one evaluation of the circuit: inputs in, outputs out, state advanced.
- **Job**: run circuit `(cpu, id)` for `beats` beats from a starting `state`, with either one input
  vector applied every beat or `perBeat` inputs (`beats × nIn` bits, beat `b`'s input `i` at bit
  `b × nIn + i`).
- **Trace**: the execution-order vector of every wire value the job produces, one bit per leaf.
- **Packed vectors**: bits packed LSB-first into bytes, as TAP-02 §5. Bit `i` of vector `v` is
  `(v[i >> 3] >> (i & 7)) & 1`; bits past the end read as 0.
- **Claimant**: the operator that has posted a claim (root, outputs, final state) with a bond.
- **Challenger**: anyone who has posted a bond against a claim.
- **Window**: the time each party has to answer a dispute move, and the challenge window of a claim.

## 3. Trace layout

The trace is a flat bit vector, one bit per wire value, in execution order. For one invocation of
circuit `C` starting at position `P` (see `src/trace.js`, header comment; mirrored by
`Overclock.flatSize` on-chain):

```
P+0            constant 0
P+1            constant 1
P+2 .. P+1+nIn the invocation's inputs (a nested invocation reads its parent's wiring signals;
               the top-level invocation reads the job's inputs)
then, in netlist record order:
  NAND record  -> one leaf: its output
  LATCH record -> one leaf: its output (the value of its state bit coming into this beat)
  REF record   -> the child invocation's whole block (recursively, flatSize(child) leaves),
                  then nOut leaves copying the child's output signals
```

```
flatSize(C) = 2 + nIn + sum over records (NAND/LATCH: 1, REF: flatSize(sub) + nOut)
```

A job of `beats` beats is one block of `B = F + S` leaves per beat, where `F = flatSize(C)` and
`S = nState(C)`. After each beat's invocation block come the `S` **state leaves**: state bit `i`'s
new value (the value its `LATCH` input wire holds at the end of the beat). Total trace length:

```
traceSize = beats × (F + S)
```

In this order every leaf depends only on strictly earlier leaves (or on the job's inputs and
starting state, which are committed in the job itself). Consequence: if an honest trace and a
claimed trace differ anywhere, the **first** differing leaf is a single checkable step. A fault
injected at leaf `k` and propagated honestly afterwards produces exactly this: the first difference
is at `k` (§8, fault vectors).

## 4. Commitment

The claimant commits `keccak256` Merkle root over the padded trace (contract `LEAF0`, `LEAF1`, `PAD`;
`src/trace.js` `Tree`):

- Leaf hash for bit `b` is `keccak256(uint8 b)`:
  - `LEAF0 = keccak256(0x00) = 0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a`
  - `LEAF1 = keccak256(0x01) = 0x5fe7f977e71dba2ea1a68e21057beebb9be2ac30c6410aa38d4f3fbe41dcffd2`
- The trace is padded to a power of two with padding leaves `PAD = bytes32(0)` (each an
  all-zero 32-byte node). Depth is `ceil(log2(traceSize))` (`Overclock._depth`).
- Parent = `keccak256(left || right)`, two 32-byte values packed as 64 bytes.
- Leaves past `traceSize` are defined as `PAD`; a dispute that walks into the padding expects `PAD`
  (§6, `resolveLeaf`).

The root is committed in `claim(jobId, traceRoot, outputs, newState)`. The claimed `outputs` and
`newState` must have exactly `_bytes(nOut)` / `_bytes(nState)` bytes, and every padding bit past
`nOut` / `nState` must be zero — padding bits are unreachable by any dispute, so a claim may not
carry garbage there.

## 5. One-step semantics

The contract recomputes the expected value of any leaf `q` from the leaves it depends on
(`Overclock._expected`; off-chain mirror `src/game.js` `depsOf`). Let `block = F + S`,
`beat = q / block`, and `p = beat × block`.

**Logic leaves** (`q < p + F`), by walking the netlist record by record from position `p`
(`_bitAt`):

| Leaf | Value | Depends on |
|---|---|---|
| Constant 0 / 1 (`p`, `p+1`) | `0` / `1` | nothing |
| Top-level input leaf | job's input bit `i` (perBeat: bit `beat × nIn + i`) | nothing (calldata) |
| Nested input leaf | the parent signal leaf the `REF` wires it to | that one leaf |
| `NAND` output leaf | `1 − (a AND b)` of its two input signal leaves | those two leaves |
| `LATCH` output leaf (beat `b`) | state bit `i` **entering** the beat: the job's `state` if `b = 0`, else leaf `(b−1) × block + F + i` | that state leaf (none at `b = 0`) |
| `REF` leaves | the child invocation's block, evaluated recursively against the child's own netlist | the child's wiring: each child input leaf is the parent signal leaf it is wired to |
| `REF` output copy leaf | the sub-circuit's output signal leaf | that one leaf |

**State leaves** (`q = p + F + i`): the value of the traced signal that state bit `i`'s `LATCH`
input wire holds at the end of this beat. The contract computes that trace position by walking the
netlist (`_latchD`; off-chain `latchDPos`). It depends on exactly one leaf.

**Result bits** (`disputeOutput`): claimed result bit `k < nOut` is output `k` of the last beat —
trace position of local signal `nSignals − nOut + k` in the last beat's invocation; bit
`nOut + i` is final state bit `i` — leaf `(beats−1) × block + F + i`.

A standard implementation must reproduce these dependencies exactly. `src/game.js` and
`contracts/Overclock.sol` agree on every leaf of the circuits in the test suite, including
every-leaf dispute sweeps and the TAP-02 spec vectors (`test/overclock.test.js`,
`test/audit.test.js`).

## 6. Contract interface

The interface below is `contracts/Overclock.sol` as it stands in this repository (Solidity 0.8.28).
It accepts jobs only on circuits of processors registered in the TapeOut factory, because a dispute
re-reads the netlist and relies on TapeOut never changing it. `flatSize(cpu, id)` is computed
on-chain and memoized; it reverts on a malformed netlist and refuses sizes above `uint64`.

```solidity
struct Leaf { uint256 pos; uint8 bit; bytes32[] siblings; }

// posting and claiming
function postJob(address cpu, uint256 id, bytes inputs, bytes state,
                 uint32 beats, bool perBeat) external payable returns (uint256 jobId);
    // msg.value is the fee, paid to whoever's claim finalizes
function continueJob(uint256 parentJobId, bytes inputs, uint32 beats, bool perBeat)
    external payable returns (uint256 jobId);
    // runs more beats from a finalized job's final state
function claim(uint256 jobId, bytes32 traceRoot, bytes outputs, bytes newState) external payable;
    // msg.value == bond; one live claim per job; padding bits must be zero

// disputes
function challenge(uint256 jobId) external payable returns (uint256 gameId);
    // bond; any number of parallel games against the same claim, inside the window
function reveal(uint256 gameId, bytes32 left, bytes32 right) external;
    // claimant opens the disputed node into its two children; keccak256(left,right) == node
function pending(uint256 gameId) external view returns (bytes32 left, bytes32 right);
function pick(uint256 gameId, bool right) external;
    // challenger chooses the child it disagrees with
function resolveLeaf(uint256 gameId, Leaf[] calldata deps) external;
    // challenger proves the dependency leaves against the claimant's root; the contract
    // recomputes the expected leaf and settles
function disputeOutput(uint256 jobId, uint256 k, Leaf[] calldata deps) external payable;
    // one-call game: claimed result bit k vs the claimant's own trace
function timeout(uint256 gameId) external;
    // whoever is due to move and missed the deadline loses; stale games refund the challenger

// settlement
function finalize(uint256 jobId) external;
    // after the window with no open games: feeBps of the fee to the treasury, the rest plus
    // the claimant's bond to the claimant, then onOverclockResult (300K gas, best effort)
function result(uint256 jobId) external view returns (bytes outputs, bytes newState);

// views
function bond() external view returns (uint256);
function window() external view returns (uint256);
function traceSize(uint256 jobId) external view returns (uint256);
function flatSize(address cpu, uint256 id) external returns (uint256);
function jobCount() external view returns (uint256);
function gameCount() external view returns (uint256);
```

Events: `JobPosted(jobId, cpu, id, beats)`, `Claimed(jobId, claimant, traceRoot, outputs)`,
`Challenged(jobId, gameId, challenger)`, `Revealed(gameId, level, index, left, right)`,
`Picked(gameId, level, index)`, `Resolved(jobId, gameId, winner, reason)`,
`Finalized(jobId, outputs)`, `Continued(jobId, parentJobId)`.

A receiving contract implements `onOverclockResult(uint256 jobId, bytes outputs, bytes newState)`
to consume results as they finalize.

## 7. Dispute protocol (current: binary bisection)

This is the protocol the contract in this repository implements today. Game state:
`{ jobId, challenger, level, index, node, turn, deadline }`, with `Turn ∈ {Claimant, Challenger,
Leaf, Done}`.

**Opening.** `challenge(jobId)` (challenger, bond, inside the claim's window) opens a game at
`level = depth(traceSize)`, `index = 0`, `node = j.traceRoot`, turn `Claimant`,
`deadline = now + window`. Multiple games may run in parallel against one claim; each is decided on
its own. Every game records which claim it opened against (`gameClaim` = the job's `claimCount` at
that moment); once that claim is overturned, its other games are **stale** and take no moves.

**Bisection.** While `level > 0`:

1. The **claimant** reveals the two children of the disputed node:
   `reveal(gameId, left, right)`. The call must come from the claimant during its turn and before
   the deadline, and must satisfy `keccak256(abi.encodePacked(left, right)) == node`. The two
   children are stored as `pending`, the turn moves to the challenger, and the deadline resets.
2. The **challenger** picks the child it disagrees with: `pick(gameId, right)`. Only the challenger
   may call it, in its turn, on time. The game's `node` becomes the chosen child, `index` becomes
   `index × 2 + (right ? 1 : 0)`, and `level` decreases by one. At `level = 0` the game is at a leaf
   (`Turn.Leaf`); otherwise it is the claimant's turn again.

**The one-step check.** At a leaf, `resolveLeaf(gameId, deps)` (challenger, on time). Each `dep` is
`{ pos, bit, siblings }`: the trace position of a dependency leaf, its claimed bit, and `depth`
sibling hashes. The contract recomputes each proof bottom-up — start from `LEAF0`/`LEAF1` by `bit`,
fold in the siblings (`idx & 1` picks the pairing order), and require the result to equal the
claimant's `traceRoot`. Then it computes the expected leaf by §5 (`_expected`; `PAD` if
`index ≥ traceSize`) and settles:

- claimant's node ≠ expected → the claim is wrong. The challenger is paid `2 × bond` (its own bond
  back plus the claimant's). The claim is erased (claimant, root, outputs, state cleared), the
  job's `claimCount` increments — which turns the claim's other games stale — and the job reopens
  for a new claim.
- claimant's node = expected → the challenge was wrong. The claimant is paid the challenger's bond;
  its own bond stays staked on the claim until `finalize`. `openGames` decreases and the claim's
  window restarts from now, so other watchers still get their chance.

**Result disputes.** `disputeOutput(jobId, k, deps)` (bond, inside the window) skips bisection: it
opens a game already at the leaf for claimed result bit `k` (§5) and settles it in the same
transaction — a claim whose result disagrees with its own trace is disproved in one call.

**Timeouts.** `timeout(gameId)`: a stale game closes at once and returns the challenger's bond.
Otherwise the party due to move loses — if the claimant missed a `reveal` deadline the claim is
overturned as above; if the challenger missed, the claimant wins as above. Moves after a deadline
are refused outright (`"late"`), so the outcome does not depend on when anyone calls `timeout`.

**Finalization.** `finalize(jobId)` requires a claimant, `openGames == 0`, and the window elapsed
since the last claim or surviving challenge. It pays `feeBps` of the fee to the treasury (capped at
deploy time, ≤ 10%), the rest plus the claimant's bond to the claimant, and calls the poster's
`onOverclockResult` with a guaranteed 300K gas (best effort: a reverting receiver does not block
finalization). `result(jobId)` then serves the outputs and final state to any contract.
`continueJob` starts the next job from a finalized job's final state, which is how a stateful
machine keeps running for as long as anyone pays.

**Deployment note.** The contract live at `0xe29F…E710` is an earlier build that predates the fixes
in this repository (two critical payout bugs, documented with proof-of-concept tests in
[`docs/security-audit.md`](security-audit.md)). The protocol above is the corrected specification;
redeploying it is planned work (see §9).

**Rounds.** Binary bisection needs at most `depth = ceil(log2(traceSize))` reveal/pick rounds plus
one `resolveLeaf`. The 181,840-step mainnet job (an 8×8 board circuit, 40 generations) resolves in at most
18 rounds; a 10-billion-step trace would need 34. Reducing this is §9's first planned change.

## 8. Test vectors

All values below were generated from the code in this repository (`src/hdl.js` to build the
circuit, `src/trace.js` for the trace and tree, `src/game.js` for the dependencies) and can be
regenerated the same way. The circuit is a local example; it is not taped out on mainnet.

**Circuit.** `nIn = 2`, `nOut = 2`, `nState = 1`; five records: four `NAND`s computing
`xor(x0, x1)` (signals 4–7), then one `LATCH` whose input is signal 7 (its state bit enters the
next beat). Outputs are the last two signals: the XOR result and the latch value. Built by
`new Builder(2)` with `b.xor`, `b.latch`, `b.setLatch`, `b.build([s, q])`.

```
flatSize = 2 + 2 + 5 = 9        B = 9 + 1 = 10        2 beats -> traceSize = 20, depth = 5
```

**Beat-0 leaves** (inputs `x0 = 1`, `x1 = 0`; starting state `0`) and their dependencies per §5:

| leaf | kind | value | deps |
|---:|---|---:|---|
| 0 | constant 0 | 0 | — |
| 1 | constant 1 | 1 | — |
| 2 | input x0 | 1 | — |
| 3 | input x1 | 0 | — |
| 4 | NAND (x0,x1) | 1 | 2, 3 |
| 5 | NAND (x0,4) | 0 | 2, 4 |
| 6 | NAND (x1,4) | 1 | 3, 4 |
| 7 | NAND (5,6) | 1 | 5, 6 |
| 8 | LATCH | 0 | — (beat 0 reads the job's state) |
| 9 | state leaf | 1 | 7 (the signal the latch input wire holds) |

**Two-beat trace.** With inputs `[1, 0]` on both beats: beat 1's invocation leaves are
`0 1 1 0 1 0 1 1` (latch leaf 18 = 1, because state entered the beat as 1; deps: leaf 9), state
leaf 19 = 1 (deps: leaf 17, the XOR output of beat 1). Full trace:

```
beat 0:  0 1 1 0 1 0 1 1 0 | 1
beat 1:  0 1 1 0 1 0 1 1 1 | 1
outputs [1, 1], final state [1]
```

Merkle root over the 20 leaves padded to 32 with `PAD`:

```
root  0x38acabb6392b2eaeffa2c0a61a29178805bc74b0e1fd534bdd35e541c2aacc85
```

**Merkle proof** for leaf 4 (value 1, `LEAF1`), siblings bottom-up:

```
0xbc36789e7a1e281436464229828f817d6612f7b477d66591ff96a9e064bcc98a   (LEAF0, the constant-0 leaf)
0xa284944720d246a0f5f3de67cb4b832a8b5dfdc512e0554cedc652aaf162d178
0x08861d328453dc4b6e4015cbb2bcd302abe36026e3cf20d59064ab5a13257e4d
0xff4051c6657c8525d82eef0db0090675386ad22d6f04912160b16912a1b3fdb8
0x9d94a4e5758ec5b22d501e7744323fb1aaaefe5e5ad276d1beebdbe941f4ad25
```

**Fault vectors** (`traceJob` with `fault = k` flips leaf `k` and everything downstream is computed
from the flipped value — the hardest lie to catch). The first differing leaf is always the fault:

| fault at | differing leaves (honest vs faulted) | first difference |
|---:|---|---:|
| 5 | 5, 7, 9, 18 | 5 |
| 14 | 14, 15, 17, 19 | 14 |

Fault at 5: honest root `0x38ac…cc85`, faulted root
`0xa224779bc55cf554fecdfe3f39d1946ded18c95af8a8a826404e30d58d8df856`. The roots differ, so a
challenge opens; the game bisects to the first differing leaf. Leaf 5 sits at index 5 of the
32-leaf padded tree (binary `00101`), so the honest challenger picks left, left, right, left,
right — five picks, one per level — then
`resolveLeaf(5, deps = [leaf 2 (bit 1), leaf 4 (bit 1)])`: the contract recomputes
`1 − (1 AND 1) = 0`, the claimant's leaf is 1, the claimant loses. Both dependency leaves (2 and 4)
lie strictly before the fault, so the challenger knows their claimant-side values honestly —
everything before the first difference is identical, and everything after it is only needed where a
dependency sits inside the faulted region, which bisection never requires.

## 9. Planned changes (not implemented today)

This section is explicitly **planned work**, tracked in [`PLAN.md`](../PLAN.md) §4-A. Nothing in it
exists in the deployed contract or in this repository's contract source yet.

### 9.1 Sixteen-way dissection

The claimant reveals the **16 nodes four levels down** from the disputed node. The contract hashes
them up pairwise (15 pair-hashes) and requires the top of the little tree to equal the disputed
node, then the challenger picks **one of the 16** and the game jumps four levels at once. The trace
layout of §3 does not change — 16-way is compatible with the same Merkle tree, so traces built for
the binary game stay valid.

Effect on rounds: each round covers four levels, so a game takes `ceil(depth / 4)` rounds:

| trace size | depth | binary rounds | 16-way rounds |
|---:|---:|---:|---:|
| 181,840 (the mainnet 8×8 board job) | 18 | 18 | 5 |
| 10,000,000,000 | 34 | 34 | 9 |

### 9.2 Bond split and scaled bonds

- **Slashing split.** When a claim is proven wrong, the winning challenger gets its own bond back
  plus **half** the claimant's bond; the other half goes to the protocol treasury. A claimant
  working with an accomplice who settles games against it then loses half a bond per caught claim
  instead of netting zero. The treasury share also funds planned *forced errors* (the runner
  deliberately posts a wrong claim, committed in advance; the first watcher to catch it earns a
  jackpot, so watchers earn even when nobody cheats).
- **Bonds that scale with the fee.** `bondFor(job) = minBond + k × fee`: small jobs stay cheap,
  large jobs carry security proportional to the value at risk.

### 9.3 Other planned work

A worst-case gas bound for `resolveLeaf` checked at `postJob` (the one-step check's cost grows with
netlist size and `REF` depth) is planned as well. Redeploying the corrected contract as v2, first on
testnet then mainnet, precedes all of the above.
