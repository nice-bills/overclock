# TAP draft: Optimistic Execution of Circuits

Status: **draft**. This file is the working copy in the Overclock repository. The planned next step
is to open a pull request against `TapeOutProtocol/TAPs` with this text (that step has not happened
yet). The text describes the contract and code as they exist in this repository on 17 Nov 2026
(contract v2). Only §9 is planned work: v2 is not deployed yet, and the live contract is the first
version (§7, deployment note).

| | |
|---|---|
| Standard | Optimistic execution of TapeOut circuits |
| Version | 0 (draft) |
| Depends on | [TAP-02](https://github.com/TapeOutProtocol/TAPs) (netlists, `NAND`/`LATCH`/`REF`, packed vectors §5) |
| Reference implementation | [`contracts/Overclock.sol`](../contracts/Overclock.sol), [`src/trace.js`](../src/trace.js), [`src/game.js`](../src/game.js) |
| Live deployment | None of v2 yet. X Layer mainnet, chain 196, has the first version, [`0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710`](https://www.oklink.com/x-layer/address/0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710) (pre-audit, binary disputes, one flat bond; retired, see §7 note) |

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
- **Bond** `b = bondFor(jobId) = bond + fee × bondBps / 10,000`: what a claim, a challenge or a
  `disputeOutput` on that job puts at stake. `bond` is the minimum, `fee` the job's fee.
- **Slashed pool** (`slashed`): the half of every losing bond that is not paid to the winner; it
  waits for `sweep()` to send it to the treasury.
- **Forced runner** (`forcedRunner`): the one address allowed to plant forced errors (§7).

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
constructor(uint256 bond, uint256 window, ITapeOutFactory factory, address treasury,
            uint256 feeBps, uint256 bondBps, uint256 maxLeafGas, address forcedRunner);
    // feeBps <= 1000 (10%); bondBps <= 100_000 (a bond share of at most 10x the fee);
    // maxLeafGas == 0 means 30,000,000; forcedRunner == 0 turns forced errors off

struct Leaf { uint256 pos; uint8 bit; bytes32[] siblings; }

// posting and claiming
function postJob(address cpu, uint256 id, bytes inputs, bytes state,
                 uint32 beats, bool perBeat) external payable returns (uint256 jobId);
    // msg.value is the fee, paid to whoever's claim finalizes; reverts "check too costly" when
    // leafGasBound(cpu, id) > maxLeafGas (§7, gas bound)
function continueJob(uint256 parentJobId, bytes inputs, uint32 beats, bool perBeat)
    external payable returns (uint256 jobId);
    // runs more beats from a finalized job's final state; same gas bound
function claim(uint256 jobId, bytes32 traceRoot, bytes outputs, bytes newState) external payable;
    // msg.value == bondFor(jobId), exactly; one live claim per job; padding bits must be zero

// disputes
function challenge(uint256 jobId) external payable returns (uint256 gameId);
    // msg.value == bondFor(jobId); any number of parallel games against the same claim, inside the window
function reveal16(uint256 gameId, bytes32[] calldata nodes) external;
    // claimant opens the disputed node into 2^s nodes, s levels down (s = min(4, level)); the contract
    // hashes them up and requires the result to equal the disputed node
function pending(uint256 gameId) external view returns (bytes32[] memory nodes);
    // the 2^s nodes the claimant just revealed
function pick16(uint256 gameId, uint8 which) external;
    // challenger chooses which revealed node it disagrees with (0 = leftmost)
function resolveLeaf(uint256 gameId, Leaf[] calldata deps) external;
    // challenger proves the dependency leaves against the claimant's root; the contract
    // recomputes the expected leaf and settles
function disputeOutput(uint256 jobId, uint256 k, Leaf[] calldata deps) external payable;
    // one-call game: claimed result bit k vs the claimant's own trace; msg.value == bondFor(jobId)
function timeout(uint256 gameId) external;
    // whoever is due to move and missed the deadline loses; stale games refund the challenger

// settlement
function finalize(uint256 jobId) external;
    // after the window with no open games: feeBps of the fee to the treasury, the rest plus
    // the claimant's bond to the claimant, then onOverclockResult (300K gas, best effort)
function result(uint256 jobId) external view returns (bytes outputs, bytes newState);
function sweep() external;
    // sends the slashed pool to the treasury (pull-based: a treasury that rejects payment
    // cannot block a dispute)

// forced errors (§7)
function commitForced(uint256 jobId, bytes32 commitment) external;
    // forcedRunner only, before it claims the job: commitment = keccak256(abi.encode(jobId, salt))
function revealForced(uint256 jobId, bytes32 salt) external;
    // forcedRunner only: owns up to an uncaught forced claim, which is voided with its bond refunded

// views
function bond() external view returns (uint256);           // the minimum bond
function bondBps() external view returns (uint256);
function bondFor(uint256 jobId) external view returns (uint256);
function window() external view returns (uint256);
function feeBps() external view returns (uint256);
function treasury() external view returns (address);
function maxLeafGas() external view returns (uint256);
function forcedRunner() external view returns (address);
function slashed() external view returns (uint256);
function forcedCommit(uint256 jobId) external view returns (bytes32);
function forcedAt(uint256 jobId) external view returns (uint256); // claimCount of the claim under a commitment, 0 if none
function claimCount(uint256 jobId) external view returns (uint256);
function gameClaim(uint256 gameId) external view returns (uint256);
function traceSize(uint256 jobId) external view returns (uint256);
function flatSize(address cpu, uint256 id) external returns (uint256);
function leafGasBound(address cpu, uint256 id) external returns (uint256);
function jobCount() external view returns (uint256);
function gameCount() external view returns (uint256);
```

Events: `JobPosted(jobId, cpu, id, beats)`, `Claimed(jobId, claimant, traceRoot, outputs)`,
`Challenged(jobId, gameId, challenger)`, `Revealed16(gameId, level, index, nodes)` (the 2^s revealed
nodes, `level` and `index` those of the disputed node), `Picked(gameId, level, index)` (`level` and
`index` of the chosen node, after the move), `Resolved(jobId, gameId, winner, reason)`,
`Finalized(jobId, outputs)`, `Continued(jobId, parentJobId)`, `ForcedCommitted(jobId)`,
`ForcedCaught(jobId, gameId, catcher, jackpot)`, `ForcedRevealed(jobId)`. The first version emitted
`Revealed(gameId, level, index, left, right)` instead of `Revealed16`; readers that cover both
contracts decode both.

A receiving contract implements `onOverclockResult(uint256 jobId, bytes outputs, bytes newState)`
to consume results as they finalize.

## 7. Dispute protocol

Game state: `{ jobId, challenger, level, index, node, turn, deadline }`, with `Turn ∈ {Claimant,
Challenger, Leaf, Done}`. Every amount below is in terms of the job's bond `b = bondFor(jobId)`.

**Opening.** `challenge(jobId)` (challenger, `msg.value == b`, inside the claim's window) opens a
game at `level = depth(traceSize)`, `index = 0`, `node = j.traceRoot`, turn `Claimant`,
`deadline = now + window`. Multiple games may run in parallel against one claim; each is decided on
its own. Every game records which claim it opened against (`gameClaim` = the job's `claimCount` at
that moment); once that claim is overturned, its other games are **stale** and take no moves.

**Sixteen-way dissection.** A move covers `s = min(4, level)` levels: four, or what is left of the
tree near the bottom. While `level > 0`:

1. The **claimant** reveals the `2^s` nodes `s` levels below the disputed node:
   `reveal16(gameId, nodes)`, `nodes[i]` being the node at `(level − s, index × 2^s + i)`. The call
   must come from the claimant during its turn and before the deadline, with exactly `2^s` nodes.
   The contract stores them as `pending`, hashes them up pairwise (`keccak256(left ‖ right)`, `2^s − 1`
   hashes) and requires the top to equal the disputed node, so the claimant can reveal nothing but
   its own subtree. The turn moves to the challenger and the deadline resets.
2. The **challenger** picks the revealed node it disagrees with: `pick16(gameId, which)` with
   `which < 2^s`. Only the challenger may call it, in its turn, on time. The game's `node` becomes
   `pending[which]`, `index` becomes `index × 2^s + which`, and `level` decreases by `s`. At
   `level = 0` the game is at a leaf (`Turn.Leaf`); otherwise it is the claimant's turn again.

The trace layout of §3 is unchanged: the tree is the same Merkle tree the binary game used, the
dissection just walks it four levels per move. If the challenger's tree differs from the claim at
the disputed node, some revealed node differs, and the challenger picks the first such node (the
off-chain `Bisector.choose` in `src/game.js`), so every step keeps the claimant's node different
from the honest one, exactly as the binary game did. Soundness is unchanged for the same reason:
the first differing leaf is a single checkable step.

*Rounds.* A game takes `ceil(depth / 4)` reveal/pick rounds plus one `resolveLeaf`:

| trace size | depth | binary rounds | 16-way rounds |
|---:|---:|---:|---:|
| 181,840 (the 8×8 board job, 40 generations) | 18 | 18 | 5 (reveals at levels 18, 14, 10, 6, 2) |
| about 16.4M (the 4-bit CPU job, 10,000 beats) | 24 | 24 | 6 |
| 10,000,000,000 | 34 | 34 | 9 |

*Gas.* The first `reveal16` of a game stores 16 nodes (about 431K gas, fresh storage); later ones
cost about 157K and the last about 77K. A pick is 56-73K. A whole dispute on the CPU job is 2.65M
gas over 14 transactions, 0.92M of it the one-step check (`docs/security-audit.md`, I-3).

**The one-step check.** At a leaf, `resolveLeaf(gameId, deps)` (challenger, on time). Each `dep` is
`{ pos, bit, siblings }`: the trace position of a dependency leaf, its claimed bit, and `depth`
sibling hashes. The contract recomputes each proof bottom-up — start from `LEAF0`/`LEAF1` by `bit`,
fold in the siblings (`idx & 1` picks the pairing order), and require the result to equal the
claimant's `traceRoot`. Then it computes the expected leaf by §5 (`_expected`; `PAD` if
`index ≥ traceSize`) and settles (next paragraph).

**Settlement and the bond split.** `_settle` closes the game and splits the loser's bond: half
(`b / 2`, rounded down) goes to the winner, the rest, `b − b / 2` (including any odd wei), goes to
the slashed pool. Nothing else about a loss changes the money, so every payout comes out of
amounts the contract already holds for the claim and the game.

- Claimant's node ≠ expected → the claim is wrong. The challenger is paid its own bond back plus
  half the claimant's: `b + b / 2`. The claim is erased (claimant, root, outputs, state cleared),
  the job's `claimCount` increments — which turns the claim's other games stale — `openGames`
  resets, and the job reopens for a new claim.
- Claimant's node = expected → the challenge was wrong. The claimant is paid half the challenger's
  bond (`b / 2`); its own bond stays staked on the claim until `finalize`. `openGames` decreases and
  the claim's window restarts from now, so other watchers still get their chance.

The split is what makes a cheat's accomplice pointless. A claimant that settles its own wrong claim
through a second account (`disputeOutput`, or a fast game against itself) used to net zero; now the
pair loses `b − b / 2` to the pool, and each self-challenge that only stalls the claim costs the
same. The pool pays out in two ways: `sweep()` to the treasury, and the forced-error jackpot below.
Pulling it through `sweep` keeps a treasury that rejects payment from blocking any dispute.

**Result disputes.** `disputeOutput(jobId, k, deps)` (`msg.value == b`, inside the window) skips the
dissection: it opens a game already at the leaf for claimed result bit `k` (§5) and settles it in
the same transaction — a claim whose result disagrees with its own trace is disproved in one call.

**Timeouts.** `timeout(gameId)`: a stale game closes at once and returns the challenger's bond `b`
(no split: nobody lost). Otherwise the party due to move loses — if the claimant missed a `reveal16`
deadline the claim is overturned as above; if the challenger missed, the claimant wins as above.
Moves after a deadline are refused outright (`"late"`), so the outcome does not depend on when
anyone calls `timeout`.

**Finalization.** `finalize(jobId)` requires a claimant, `openGames == 0`, and the window elapsed
since the last claim or surviving challenge. It pays `feeBps` of the fee to the treasury (capped at
deploy time, ≤ 10%), the rest plus the claimant's bond `b` to the claimant, and calls the poster's
`onOverclockResult` with a guaranteed 300K gas (best effort: a reverting receiver does not block
finalization). `result(jobId)` then serves the outputs and final state to any contract.
`continueJob` starts the next job from a finalized job's final state, which is how a stateful
machine keeps running for as long as anyone pays.

**Scaled bonds.** A job's bond is `bondFor(jobId) = bond + fee × bondBps / 10,000`: the constructor's
minimum `bond` plus a share of the job's own fee, read from the job as posted (a job's fee never
changes, so the bond cannot move under a live claim). A free job costs the minimum; with
`bondBps = 10,000` a lie on a job always risks more than the job pays. `bondBps` is at most
100,000 (10× the fee) and is checked at deploy. `claim`, `challenge` and `disputeOutput` require
`msg.value == bondFor(jobId)` exactly, and the stale-game refund, `_settle` and `finalize` all use
the same value.

**Gas bound for the one-step check.** `resolveLeaf` re-reads the netlist of every circuit on the path
to the disputed leaf, so its cost grows with netlist size and `REF` depth. If some leaf cost more than
a block, a wrong claim there could not be proven and the claimant could not be slashed. So the
contract bounds it when a job is posted. `flatSize` already walks each circuit once and memoizes; it
now also memoizes, per circuit, `LEAF_LEVEL_GAS + LEAF_RECORD_GAS × records + LEAF_BYTE_GAS × netlist
bytes + (the costliest child REF's bound)`, with `LEAF_LEVEL_GAS = 40,000`, `LEAF_RECORD_GAS = 1,500`
and `LEAF_BYTE_GAS = 30`. `leafGasBound(cpu, id) = 300,000 + that` (the 300,000 covers the dependency
proofs and the result lookup). `postJob` and `continueJob` revert with `"check too costly"` when
`leafGasBound > maxLeafGas`; `maxLeafGas` is a constructor argument (`0` = 30,000,000, under every
block limit we know of). The bound is a model, not a proof: it is calibrated with margin against
measured checks (Life 16×16 board: 910,976 measured vs 1,721,630 bound; 4-bit CPU: 921,886 vs
2,778,820; a crafted chain of 40 nested `REF`s: 1,099,895 vs 2,038,910) and the test suite fails if a
real check ever exceeds it. A circuit with an enormous but shallow netlist is bounded by the record
term, so one `maxLeafGas` covers both shapes; set it lower for chains with a smaller block limit.

**Forced errors.** The verifier's dilemma (if claims are almost always right, nobody re-runs them)
is answered as in Truebit: the protocol pays watchers even when nobody cheats. The `forcedRunner`
is the one address that may plant errors on purpose:

1. Before claiming a job, the runner calls `commitForced(jobId, keccak256(abi.encode(jobId, salt)))`
   (job unclaimed, not final, no earlier commitment). Its next `claim` on that job records
   `forcedAt[jobId] = claimCount[jobId]`. It may then claim a deliberately wrong result. It may also
   commit to claims that are right, so a commitment alone says nothing about the claim.
2. If another party proves the claim wrong, `_settle` sees `loser == forcedRunner` and
   `forcedAt == claimCount`: the runner gets its bond `b` back in full (a plain `call` after the game
   is closed; if the runner refuses it, the amount goes to the slashed pool, so a refusing runner
   cannot keep its own caught claim from settling), and the catcher is paid `b` (its own bond) plus
   a jackpot of `min(b, slashed)` out of the pool. `ForcedCaught(jobId, gameId, catcher, jackpot)` is
   emitted, the commitment is cleared and the job reopens. The jackpot is the point: watchers earn
   even when no one cheats. It can only come from money the contract already owes the treasury.
3. If nobody catches it, the runner calls `revealForced(jobId, salt)` after the first window, with no
   game open: the claim is voided, its bond is refunded in full, the commitment is cleared and the
   job reopens for an honest claim (`ForcedRevealed`). Until then, a claim under a commitment cannot be
   finalized by anyone but the runner before a second window has passed (`finalize` needs
   `now ≥ claimedAt + 2 × window`), which gives the runner the time to reveal it.

*What the runner is trusted with.* A committed claim is never slashed, so a runner that commits and
then claims a wrong result *for real* loses nothing if it is caught; if nobody catches it, the second
window ends and the wrong result finalizes, as it would for any cheat. So the runner has no extra way
to profit from a lie, but its deterrent is the pool and its reputation rather than its bond. The role
is for Overclock's own runner and nobody else, on a dedicated key. A dishonest runner's worst case is
bounded by the pool: the jackpot is at most one bond and at most what `slashed` holds.

**Deployment note.** The contract live at `0xe29F…E710` is the first version: it predates the fixes
in this repository (two critical payout bugs, documented with proof-of-concept tests in
[`docs/security-audit.md`](security-audit.md)), disputes in binary (`reveal(gameId, left, right)`,
`pick(gameId, bool)`, event `Revealed`), asks one flat bond for every job and has no forced errors or
gas bound. Its constructor is `(bond, window, factory, treasury, feeBps)`; v2's is the eight-argument
one of §6. Tools in this repository read both (the job board and the MCP server tell them apart by
whether `bondBps` answers); disputes are played against v2 only. Redeploying v2, first on testnet
then mainnet, is planned work (§9).

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
challenge opens; the game dissects to the first differing leaf. Leaf 5 sits at index 5 of the
32-leaf padded tree (binary `00101`, depth 5), so the game takes `ceil(5 / 4) = 2` rounds. Round 1
is at level 5 with `s = 4`: the claimant reveals the 16 nodes at level 1 (`reveal16`), the honest
challenger sees the first differing one is node 2 (the pair of leaves 4 and 5) and calls
`pick16(gameId, 2)`; the game is at level 1, index 2. Round 2 has `s = 1`: the claimant reveals leaves
4 and 5, the challenger picks `which = 1`; the game is at level 0, index `2 × 2 + 1 = 5`. Then
`resolveLeaf(5, deps = [leaf 2 (bit 1), leaf 4 (bit 1)])`: the contract recomputes
`1 − (1 AND 1) = 0`, the claimant's leaf is 1, the claimant loses. Both dependency leaves (2 and 4)
lie strictly before the fault, so the challenger knows their claimant-side values honestly —
everything before the first difference is identical, and everything after it is only needed where a
dependency sits inside the faulted region, which the dissection never requires.

## 9. Planned work

Everything in §§1-8 is implemented in this repository's contract and code and covered by its tests
(`test/overclock.test.js`, `test/audit.test.js`, `test/stream-trace.test.js`, `test/mcp.test.js`).
What is not done yet is deployment: v2 has not been deployed to X Layer testnet or mainnet, so the live
contract (§7, deployment note) is still the first version. Redeploying v2 and pointing
`deployments/196.json`, the MCP server and the web pages at it is the next step, funding permitting;
the old address would be marked retired.
