# Overclock security audit (October 2026)

Scope: `contracts/Overclock.sol` as deployed on X Layer mainnet at
[`0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710`](https://www.oklink.com/x-layer/address/0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710)
(commit `9e21912`), plus a lighter pass over `Machine.sol`. `TapeOutLocal.sol`, `MockProcessor.sol`
and `DirectEval.sol` are local stand-ins and baselines; they are not deployed and were only read for
what Overclock assumes about TapeOut.

Method: line-by-line manual review of the dispute game and the one-step check, Slither 0.11 (results
below), proof-of-concept tests for every finding, and a randomized solvency invariant. All of it is in
[`test/audit.test.js`](../test/audit.test.js); `npm test` runs it.

**Live contract status.** The deployed contract has no owner, pause or upgrade path, so its bugs can't
be patched in place. When checked (`eth_getBalance`, latest block) it held **0 OKB**, so nothing can be
stolen today. Any fee or bond sent to it from now on is at risk (C-1, C-2). **Redeploy recommended**;
see the end of this file.

## Summary

| ID | Severity | Finding | Status |
|---|---|---|---|
| C-1 | Critical | A settled game can be resolved again, paying its winner every time | Fixed |
| C-2 | Critical | A claimant who survives a challenge is paid two bonds while its own stays staked | Fixed |
| H-1 | High | An old game can wipe a later honest claim on the same job and take its bond | Fixed (by C-1) |
| M-1 | Medium | Whoever calls `finalize` can starve the poster's result callback of gas | Fixed |
| M-2 | Medium | Padding bits of a claimed result are unchecked and undisputable | Fixed |
| M-3 | Medium | One challenge at a time: a claimant and an accomplice can stall a job indefinitely | Fixed (parallel games) |
| M-4 | Medium | A caught cheat settles its own claim through an accomplice and loses nothing | Fixed (slashing split) |
| L-1 | Low | `flatSize` is truncated to `uint64` when a job is posted | Fixed |
| L-2 | Low | A 10-minute move window and a 0.001 OKB bond are thin for real value | Fixed for the bond (`bondFor`, 17 Nov); the window stays a deploy parameter |
| L-3 | Low | Moves after their deadline are accepted until someone calls `timeout` | Fixed |
| I-1 | Info | Gas of the one-step check is not bounded by the contract | Fixed (`leafGasBound`, 17 Nov) |
| M-5 | Medium | A forced-error runner that rejects its refund could keep its own caught claim from settling | Found and fixed during the v2 work (17 Nov) |
| I-2 | Info | Slither results | Triaged, re-run 17 Nov |
| I-3 | Info | 16-way dissection: soundness and cost | Reviewed (17 Nov) |
| I-4 | Info | Forced errors: what the runner is trusted with | Documented (17 Nov) |

**v2 changes (17 Nov).** The next contract version adds scaled bonds (A2), 16-way dissection (A3), a gas
bound for the one-step check (A5) and forced errors (A4), on top of the slashing split (M-4). Each
has proof-of-concept tests in [`test/audit.test.js`](../test/audit.test.js), and the solvency
invariant covers all of them. The findings below marked 17 Nov are about v2 itself.

Line numbers marked *old* are in the deployed version (`git show 9e21912:contracts/Overclock.sol`);
the rest are in the fixed file.

## C-1. A settled game can be resolved again (Critical)

`_settle` marked a finished game with `g.turn = Turn.Leaf` (old line 287), and `resolveLeaf` only checks
`g.turn == Turn.Leaf` (old line 237). So every settled game stays open to `resolveLeaf` forever, and each
call runs `_settle` again and pays `2 * bond` from the contract's balance, which holds every other
user's fees and bonds.

Attack: post a tiny job, claim it honestly from account A, challenge from account B, and pick left at
every level. That ends at leaf 0, the constant 0, which needs no Merkle proofs. `resolveLeaf(game, [])`
pays A, and so does every repeat call, until the contract is empty. It needs no help from anyone else
and costs about 20 transactions. A game opened by `disputeOutput` is just as replayable.

PoC: *a settled game cannot be resolved again to pay its winner twice*. Against the deployed code it
drains another user's 5 OKB job fee to 0.

Fix: a new `Turn.Done` that `_settle` sets (line 291). `reveal`, `pick`, `resolveLeaf` and `timeout`
all refuse a game in that state.

## C-2. A surviving claimant is paid two bonds (Critical)

When a challenge fails, `_settle` paid the claimant `2 * bond` (old line 301), but the claim stays live
and `finalize` pays the claimant's bond again (old line 166). Only two bonds came in, and three go out.
Each failed challenge takes one bond from other users' money.

Attack: A claims its own job honestly; B calls `disputeOutput` on a result bit that is correct. That
settles in the same transaction, pays A two bonds, and leaves the job open for another dispute
straight away. Repeat, then finalize. Each round nets A + B one bond.

PoC: *a claimant who survives a challenge is paid the challenger's bond, not two bonds*. Against the
deployed code, four rounds take 4 of another user's 5 OKB.

Fix: the claimant now gets only the challenger's bond (line 303). Its own bond stays staked until
`finalize` returns it, or until a later challenge takes it.

## H-1. An old game can wipe a later honest claim (High)

This is a consequence of C-1, and it needs no money in the contract. A cheat's claim is caught, and the
job reopens. An honest operator then claims. Anyone can now replay the old game with `resolveLeaf`,
proving the dependencies against the **new** claim's root (they are honest values, so the proofs
verify). The recomputed leaf is the honest value, it differs from the cheat's leaf stored in the old
game, so `_settle` takes the "claimant wrong" path against the *current* claimant. That wipes the
honest claim and pays its bond to the old challenger. Repeated, it keeps any job from ever finalizing.

PoC: *an old game cannot wipe a later honest claim on the same job*. Fixed by C-1's `Turn.Done`.

## M-1. Callback gas starvation (Medium)

`finalize` calls `onOverclockResult{gas: 300_000}` inside `try/catch` (old line 170). Because of the
63/64 rule, a caller who sends just enough gas for `finalize` to finish leaves the callback far less
than 300K. The callback fails, the `catch` swallows it, and the result is still final. Anyone can call
`finalize`, so anyone can make a receiver contract miss its result. `Machine` has a `sync` fallback,
but other receivers may not.

PoC: *anyone finalizing cannot starve the poster's result callback of gas*. Against the deployed code,
`finalize` succeeds with 57,414 gas and the callback never runs.

Fix: `finalize` requires `gasleft() >= CALLBACK_GAS * 64 / 63 + 20_000` before the callback (line 173),
so the callback always gets its full 300K. A receiver that reverts or needs more gas than that still
cannot block finalization.

## M-2. Unchecked padding bits in a claimed result (Medium)

`claim` checked only the byte lengths of `outputs` and `newState`. Bits past `nOut` / `nState` in the
last byte were stored as given, and `disputeOutput` can't reach them (`k < nOut + nState`). A claimant
could finalize, for example, `0xf6` where the correct value is `0x06`. A consumer that compares the bytes
from `result()` (`keccak256(outputs) == ...`, `uint8(outputs[0]) == 6`) would get a wrong answer, and
no one could dispute it.

PoC: *a claim cannot carry unchecked garbage in the padding bits of its result*. Fix: `claim` requires
those bits to be zero (line 156).

## M-3. One challenge at a time (Medium, fixed)

A job holds one challenge at a time (`j.challenged`). A cheat can have an accomplice challenge its own
wrong claim first and then let the game time out. The accomplice's bond goes back to the cheat, so the
pair loses nothing but gas. Every time the claimant wins, the window restarts (good: the wrong claim
can't finalize), and the pair can race to be the next challenger again. Safety holds, because a wrong
claim never finalizes while an honest watcher keeps trying, but the job can be stalled for as long as
the pair keeps winning that race. The poster's fee stays locked.

Recommendation for the next version: let any number of challengers open games against the same claim
(each game decided independently, as in Arbitrum's BOLD or Cartesi's Dave), or at least let a second
challenger join an open game.

**Fix (27 Oct).** Any number of challengers can open games against the same claim (`challenge` and
`disputeOutput` no longer require the claim to be unchallenged). Each game is decided on its own.
The job counts its open games (`openGames`), and a claim finalizes only when none is open. Every game
records which claim it was opened against (`gameClaim`, `claimCount`). The first game that proves
the claim wrong pays its challenger both bonds and reopens the job, and the claim's other games turn
stale: they take no more moves, and `timeout` closes each one at once and returns its challenger's
bond. PoC: *a cheat's accomplice who challenges first cannot keep an honest watcher out*; also *a
claim cannot finalize while any game against it is open*. The solvency invariant now opens games in
parallel and leaves some parked until they go stale.

## M-4. A caught cheat loses nothing (Medium, fixed 17 Nov)

Found 16 Nov. When an honest watcher challenges a wrong claim, the cheat's second account settles
the claim first with one `disputeOutput` call (or a fast bisection it plays against itself). That
game pays its challenger both bonds and makes the watcher's game stale, so the watcher only gets a
refund through `timeout`. The cheat and its accomplice net zero, which defeats the point of a bond.
The same trick made self-challenges a free way to keep restarting a claim's window.

**Fix.** `_settle` now splits every losing bond: half goes to the winner and the rest (including
any odd wei) is held in `slashed`, which `sweep()` sends to the treasury. Pull-based, so a treasury
that rejects payment can't block a dispute. A cheat caught through an accomplice now loses half a
bond, and each self-challenge costs half a bond. PoCs: *a caught cheat cannot rescue its bond by
settling the claim through an accomplice*, *stalling a claim with self-challenges costs half a bond
each time*, *sweep sends the slashed pool to the treasury*. The solvency invariant counts `slashed`
as owed.

## L-1. `flatSize` truncated to `uint64` (Low)

`_post` stores `uint64(f)` (old line 140) without checking `f`. A chain of circuits that each REF the
previous one twice doubles `flatSize` per level, and 64 cheap tapeouts pass `2^64`. Then the job's trace
layout no longer matches the netlist. Such a job can't be computed off-chain anyway, but it may
*look* small. Fix: `flatSize` refuses sizes above `uint64` (line 520). PoC: *a circuit whose trace does
not fit in 64 bits is refused*.

## L-2. Thin parameters for real value (Low, bond fixed 17 Nov)

The deployed instance has a 600 s window per move and a 0.001 OKB bond. An honest party offline for
10 minutes during a dispute loses its bond. A wrong claim finalizes if no watcher acts within 10
minutes. And a lie on a job with a large fee risks only 0.001 OKB.

**Fix (A2).** A job's bond is `bondFor(jobId) = bond + fee * bondBps / 10_000` (constructor
arguments `bond`, the minimum, and `bondBps`, at most 100,000, i.e. 10x the fee). Claiming,
challenging, `disputeOutput`, the stale-game refund, `_settle` and `finalize` all use the job's own
bond, so a lie on a big job always risks more than the job pays when `bondBps >= 10_000`. A free
job stays at the minimum. The bond is read from the job's fee, which is fixed when the job is
posted, so it cannot change under a live claim. PoCs: *bondFor(job) is the minimum bond plus a share
of the fee, and every bonded call asks for it* (the minimum bond, or one wei too much, is refused in
`claim`, `challenge` and `disputeOutput`), *a lie on a big job costs more than a lie on a small
one*, *a bond share above 10x the fee is refused at deploy*. The solvency invariant now sums each
live claim's and each open game's own bond. The window is still a deploy parameter: for anything
beyond a demo, use hours.

## L-3. Late moves are accepted (Low, fixed)

`reveal`, `pick` and `resolveLeaf` don't check `g.deadline`, so a late move counts if it lands before
anyone calls `timeout`. Nobody gains from that beyond what the waiting side could have stopped, and it
lets a late but correct `resolveLeaf` still win.

**Fix (27 Oct).** `reveal`, `pick` and `resolveLeaf` refuse a move after the game's deadline, so the
side that was due loses on `timeout` however late anyone calls it. PoC: *a move after its deadline is
refused, and the side that was due loses on timeout*. Watchers should still move well before the
deadline.

## I-1. One-step check gas is unbounded (Info, fixed 17 Nov)

`resolveLeaf` re-reads the netlist of every circuit on the path to the disputed leaf, and walks it.
Its cost grows with netlist size and REF nesting depth. If some leaf of a crafted circuit cost more
than a block to check, a wrong claim at that leaf could not be proven, and the claimant could not
be slashed however wrong it was.

**Fix (A5).** `flatSize` already walks each circuit once and memoizes. It now also memoizes a
worst-case gas bound for the check inside that circuit: 40,000 gas per level, 1,500 per netlist
record, 30 per netlist byte, plus the costliest child REF (a check goes through one REF per level).
`leafGasBound(cpu, id)` adds a fixed 300,000 for the dependency proofs. `postJob` and `continueJob`
refuse a circuit whose bound is above `maxLeafGas` (constructor argument, 0 = 30M, under any block
limit we know of), with "check too costly". The bound is a model, not a proof, so it is
calibrated with margin against measured checks and the tests fail if a real check ever exceeds it:

| Circuit | Measured `resolveLeaf` | `leafGasBound` |
|---|---|---|
| Life 16x16 board (demo) | 910,976 | 1,721,630 |
| 4-bit CPU (`npm run cpu`) | 921,886 | 2,778,820 |
| Crafted chain, 40 nested REFs | 1,099,895 | 2,038,910 |

PoCs: *postJob refuses a circuit whose worst-case check would cost too much gas, and the bound
covers the real check* (a 1.5M cap refuses the 40-deep chain and accepts a 20-deep one, and the
real check at the deepest NAND stays under its bound) and *the gas bound covers the real check on
every leaf...*; `npm run demo` and `npm run cpu` throw if a measured check reaches the bound.
Limit: a circuit with an enormous but shallow netlist is bounded by the record term, so one
`maxLeafGas` covers both shapes; set it lower for chains with a smaller block limit.

## I-2. Slither

`slither contracts/Overclock.sol --solc-args "--via-ir --optimize" --exclude-informational`
(Slither 0.11.6, solc 0.8.28), re-run 17 Nov on the v2 contract:

- `arbitrary-send-eth` on `_pay`: expected; it pays winners and claimants.
- `reentrancy-events` in `_settle` and `finalize`: benign. State is written before every external
  call, and with `Turn.Done` a re-entered `resolveLeaf` is refused.
- `reentrancy-eth` in `_settle` (new): `slashed += refund` after the forced-error refund call. It
  only runs when that call failed, and a failed call's reentrant effects are reverted with it.
  Benign. The first version of the forced-error payout wrote `g.level` after the call; Slither
  caught that, and the refund now happens after the game is closed.
- `incorrect-equality` on `msg.value == bondFor(jobId)` (new): intended. A bond is an exact amount.
- `uninitialized-state` on `_pending`: a mapping of fixed arrays written in `reveal16`. False positive.
- `missing-zero-check` on `treasury_` and `runner_`: immutables set once at deploy; a zero runner
  turns forced errors off.
- `calls-loop`, `unused-return`, `timestamp`, `uninitialized-local`: inherent to the design, or false
  positives.

Slither found none of C-1, C-2, H-1, M-4 or M-5. They are logic bugs in the game's state machine and
payouts, which the solvency invariant below catches.

## M-5. A runner can refuse its refund (Medium, fixed 17 Nov)

Found while building forced errors (A4). When a forced claim is caught, the runner's bond is
refunded. A first version paid it with `_pay`, which reverts if the receiver does. A runner contract
that reverts on receive would make `_settle` revert, so the claim could never be proven wrong: its
game would stay open, the job could never finalize, and `timeout` would revert the same way.

Fix: the refund is a plain `call` after the game is closed; if it fails the amount goes to
`slashed`. PoC: *a runner contract that refuses its refund cannot keep its caught claim from
settling*.

## I-3. 16-way dissection (Info, reviewed 17 Nov)

A move now covers four levels of the trace tree (`reveal16`, `pick16`), or what is left near the
bottom (`_span`). The claimant reveals the 2^s nodes s levels below the disputed node; the contract
hashes them up and requires the result to equal the disputed node, so the claimant cannot reveal
anything but its own subtree. The challenger picks one of them. If the challenger's tree differs
at the disputed node, some revealed node differs, and the challenger picks the first such node, so
every step keeps the claimant's node different from the honest one, exactly as the binary game
did. The trace tree, leaf hashes, padding and the one-step check are unchanged. 181,840 steps take
5 rounds instead of 18 (`npm run demo`: reveals at levels 18, 14, 10, 6, 2); the 16.4M-leaf CPU
trace takes 6 rounds.

Cost: the first `reveal16` of a game stores 16 nodes (about 431K gas, fresh storage); later ones
about 157K, the last about 77K. A pick is 56-73K. A whole dispute on the CPU job (`npm run cpu`)
is 2.65M gas over 14 transactions, of which the one-step check is 0.92M. Handled by tests: wrong node counts, a node set that
does not hash to the parent, a pick out of range, picks before a reveal, a reveal by the wrong
account, and every-leaf dispute sweeps at a depth that is not a multiple of four (*a dispute whose
depth is not a multiple of four ends with a partial step, at every leaf*) as well as the existing
every-leaf sweeps on the REF and multi-beat circuits.

## I-4. Forced errors: what the runner is trusted with (Info, documented 17 Nov)

A4 adds Truebit's forced errors. The `forcedRunner` (a constructor argument, one address) can
`commitForced(jobId, keccak256(jobId, salt))` before it claims a job and then claim a wrong result
on purpose. If another party proves it wrong, the runner gets its bond back in full and the catcher
is paid a jackpot of min(bond, `slashed`) from the treasury pool, so watchers earn even when no one
cheats. If nobody catches it, the runner reveals the salt after the first window
(`revealForced`), the claim is voided and its bond refunded; a stranger cannot finalize a committed
claim until a second window has passed. The runner may commit to honest claims as well, so a
commitment is not a tell, and it is the runner's own decision whether to reveal.

What this trusts the runner with: a committed claim is never slashed, so a runner that commits and
then claims a wrong result *for real* loses nothing if it is caught. If nobody catches it, the
second window ends and the wrong result finalizes, as it would for any cheat. So the runner has no
extra way to profit from a lie, but its deterrent is the pool and its reputation rather than its
bond. The role is for Overclock's own runner (B3) and nobody else; point it at a dedicated key. A
dishonest runner's worst case is bounded by the pool: the jackpot is at most one bond and at most
what `slashed` holds, and every payout is out of money the contract already counts as owed.
PoCs: *a forced error is caught and paid*, *an uncaught forced error is revealed after the window
and its bond refunded, with no penalty*, *a forced claim ... finalizes only after a second window*,
*a runner with no commitment is slashed like anyone else*, *only the runner can commit ... before it
claims*, and *the runner and watcher bots play forced errors* (the bots, end to end). The solvency
invariant mixes forced claims (lies and decoys), reveals and caught forced errors into its run.

## Solvency invariant

*solvency invariant holds over a random run* (3 seeds) drives random posts, honest and lying claims,
challenges with full bisection, timeouts, `disputeOutput`, replays of settled games and finalizations.
After every step it checks that the contract holds exactly what it owes: the fee of every open job,
the bond of every live claim, the bond of every open game, and the slashed pool (each at its own
job's `bondFor`). Two of the three seeds break it on the deployed code; all three hold on the fix
and on v2, where the run also mixes in forced errors.

## Machine.sol

Not deployed. Reviewed for how it uses Overclock: `onOverclockResult` checks the caller, `sync`
covers a missed callback, and `_apply` only moves the head for a continuation of the current head.
No issues.

## Redeploy

The fix changes behavior that the live instance can't be patched to get, so the recommendation is:

1. Deploy the fixed `Overclock` (`npm run deploy`), ideally with a longer window and a bond that scales with the fee (L-2). The constructor is `(bond, window, factory, treasury, feeBps, bondBps, maxLeafGas, forcedRunner)`.
2. Point `deployments/196.json`, the MCP server and the web pages at the new address.
3. Mark `0xe29F…E710` as retired in the README and tell users not to send funds to it.
   `docs/mainnet-run.md` stays as the record of the demo run.

Nothing was redeployed and no funds were moved as part of this audit.
