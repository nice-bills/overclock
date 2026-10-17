# Overclock

Optimistic execution for TapeOut circuits on X Layer. Run a circuit of any size off-chain, claim
the result with a bond, and let anyone challenge it. A dispute bisects the execution trace down to
the first leaf the two sides disagree on, and the contract re-checks that single step: one NAND, one
LATCH read, one REF wire or one input. The liar loses their bond.

Status: week-1 spike. Everything runs against a local EVM and a mock processor; mainnet checks are pending.

## What works

- `src/tap02.js`: TAP-02 decoder, well-formedness checks and one-beat evaluator. It passes every
  vector in TapeOutProtocol/TAPs `assets/tap-02` (including `popcount8_3151`, a real mainnet netlist,
  and `ref_with_state`, which pins LATCH and REF semantics).
- `src/trace.js`: the execution-order trace of one beat and its Merkle tree. In this order every
  leaf depends only on earlier leaves, so the first disagreement is always one checkable step.
- `contracts/Overclock.sol`: jobs, bonded claims, bisection, the one-step check (NAND, LATCH,
  constants, inputs, REF inputs and REF outputs), output disputes, timeouts and finalization.
  It reads netlists straight from the processor contract (`netlist`, `circuitInfo`).
- `src/game.js`: the challenger side, covering which leaves a step depends on and how to build
  proofs against the claimant's tree without the claimant publishing it.

## Tests

```sh
npm install
node scripts/compile.js
node --test test/*.test.js
```

22 tests. They cover: an honest claim finalizes; a one-gate lie in a real mainnet netlist is caught
(about 168K gas for the final check); a false challenge loses; a wrong claimed output is caught; a lie
at *every* leaf of a stateful REF circuit is caught; and a silent claimant loses on timeout.

## Not done yet

- Disputes over the claimed new state (LATCH writes) and multi-beat jobs.
- Mainnet: gas for reading real netlists, deep REF trees and large circuits on X Layer (blocked: this
  environment cannot reach the X Layer RPC yet).
- Multiple concurrent challengers, bond sizing and anti-griefing, plus an audit.
