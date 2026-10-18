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
| M-3 | Medium | One challenge at a time: a claimant and an accomplice can stall a job indefinitely | Open (design) |
| L-1 | Low | `flatSize` is truncated to `uint64` when a job is posted | Fixed |
| L-2 | Low | A 10-minute move window and a 0.001 OKB bond are thin for real value | Open (redeploy parameters) |
| L-3 | Low | Moves after their deadline are accepted until someone calls `timeout` | Open |
| I-1 | Info | Gas of the one-step check is not bounded by the contract | Open |
| I-2 | Info | Slither results | Triaged |

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

## M-3. One challenge at a time (Medium, open)

A job holds one challenge at a time (`j.challenged`). A cheat can have an accomplice challenge its own
wrong claim first and then let the game time out. The accomplice's bond goes back to the cheat, so the
pair loses nothing but gas. Every time the claimant wins, the window restarts (good: the wrong claim
can't finalize), and the pair can race to be the next challenger again. Safety holds, because a wrong
claim never finalizes while an honest watcher keeps trying, but the job can be stalled for as long as
the pair keeps winning that race. The poster's fee stays locked.

Recommendation for the next version: let any number of challengers open games against the same claim
(each game decided independently, as in Arbitrum's BOLD or Cartesi's Dave), or at least let a second
challenger join an open game. That is a design change, so it is not part of this fix.

## L-1. `flatSize` truncated to `uint64` (Low)

`_post` stores `uint64(f)` (old line 140) without checking `f`. A chain of circuits that each REF the
previous one twice doubles `flatSize` per level, and 64 cheap tapeouts pass `2^64`. Then the job's trace
layout no longer matches the netlist. Such a job can't be computed off-chain anyway, but it may
*look* small. Fix: `flatSize` refuses sizes above `uint64` (line 520). PoC: *a circuit whose trace does
not fit in 64 bits is refused*.

## L-2. Thin parameters for real value (Low, open)

The deployed instance has a 600 s window per move and a 0.001 OKB bond. An honest party offline for
10 minutes during a dispute loses its bond. A wrong claim finalizes if no watcher acts within 10
minutes. And a lie on a job with a large fee risks only 0.001 OKB. For anything beyond a demo, use a
window of hours, and a bond that covers the gas of a full dispute plus a margin over the largest fee
you expect (or make the bond scale with the fee).

## L-3. Late moves are accepted (Low, open)

`reveal`, `pick` and `resolveLeaf` don't check `g.deadline`, so a late move counts if it lands before
anyone calls `timeout`. Nobody gains from that beyond what the waiting side could have stopped, and it
lets a late but correct `resolveLeaf` still win. Left as is; worth knowing when writing watchers: call
`timeout` promptly.

## I-1. One-step check gas is unbounded (Info, open)

`resolveLeaf` re-reads the netlist of every circuit on the path to the disputed leaf, and walks it.
Its cost grows with netlist size and REF nesting depth. If some leaf of a crafted circuit cost more
than a block to check, a wrong claim at that leaf could not be proven. TapeOut's validation (backward
references, registered REF targets, matching pin counts) rules out malformed netlists, and the
largest measured check is 0.9M gas against a 210M block limit. A worst-case gas bound per circuit,
checked at `postJob`, would close this for good.

## I-2. Slither

`slither contracts/Overclock.sol --solc-args "--via-ir --optimize" --exclude-informational`:

- `arbitrary-send-eth` on `_pay`: expected; it pays winners and claimants.
- `reentrancy-events` in `_settle` and `finalize`: benign. State is written before every external call,
  and with `Turn.Done` a re-entered `resolveLeaf` is refused.
- `calls-loop`, `unused-return`, `timestamp`, `uninitialized-local`: inherent to the design, or false
  positives.
- `missing-zero-check` on `treasury`: immutable, set once at deploy.

Slither found none of C-1, C-2 or H-1. They are logic bugs in the game's state machine and payouts,
which the solvency invariant below catches.

## Solvency invariant

*solvency invariant holds over a random run* (3 seeds) drives random posts, honest and lying claims,
challenges with full bisection, timeouts, `disputeOutput`, replays of settled games and finalizations.
After every step it checks that the contract holds exactly what it owes: the fee of every open job,
the bond of every live claim and the bond of every open game. Two of the three seeds break it on the
deployed code; all three hold on the fix.

## Machine.sol

Not deployed. Reviewed for how it uses Overclock: `onOverclockResult` checks the caller, `sync`
covers a missed callback, and `_apply` only moves the head for a continuation of the current head.
No issues.

## Redeploy

The fix changes behavior that the live instance can't be patched to get, so the recommendation is:

1. Deploy the fixed `Overclock` (`npm run deploy`), ideally with a longer window and a larger bond (L-2).
2. Point `deployments/196.json`, the MCP server and the web pages at the new address.
3. Mark `0xe29F…E710` as retired in the README and tell users not to send funds to it.
   `docs/mainnet-run.md` stays as the record of the demo run.

Nothing was redeployed and no funds were moved as part of this audit.
