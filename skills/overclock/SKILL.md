---
name: overclock
description: Use when the user wants to run, check or build TapeOut circuits on X Layer with Overclock - posting compute jobs too big for one block, verifying or challenging a claimed result, operating as a bonded operator or watcher, or creating a TapeOut processor and taping out a netlist.
---

# Overclock

Overclock runs TapeOut circuits on X Layer far past the block gas limit. An operator runs a job
off-chain and claims the result with a bond. Anyone can re-run it. If the claim is wrong, a
challenger bisects the trace down to one gate, the contract re-checks that gate against the
netlist TapeOut stores, and the liar loses the bond. Unchallenged claims finalize after the
challenge window and become readable by any contract.

The `overclock` MCP server provides the tools. Configuration comes from the environment:
`RPC_URL` (defaults to X Layer mainnet), `OVERCLOCK` (the deployed contract; on X Layer mainnet it
defaults to `0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710`, elsewhere without it only the TapeOut tools appear) and `PRIVATE_KEY` (without it only read-only tools appear).

## Conventions

- Bit vectors (inputs, state, outputs) are TAP-02 packed hex: bit i is `(byte[i>>3] >> (i&7)) & 1`.
  Tools also return a `bits` string, bit 0 first, for reading.
- Amounts are OKB as decimal strings (`"0.01"`).
- A circuit is a `processor` (its TapeOut circuits contract) plus a `circuitId`.

## Before spending anything

Every write tool sends a real transaction. Before calling one, tell the user what it costs and get
a yes, unless they already asked for exactly that action:

| Tool | Cost |
|---|---|
| `post_job`, `continue_job` | the `fee` you set, paid to whoever's claim finalizes |
| `claim_job`, `challenge_claim` | locks the bond from `overclock_info`; returned with winnings if you are right |
| `finalize_job` | gas only |
| `create_processor` | TapeOut deploy fee (0.0066 OKB on X Layer) |
| `tapeout_circuit` | transistors for every NAND and LATCH record, plus 0.0013 OKB tapeout fee |

Free and safe at any time: `overclock_info`, `list_jobs`, `get_job`, `describe_circuit`,
`run_locally`, `verify_claim`, `life_circuits`.

## Recipes

**Check a result before trusting it.** `get_job` shows the claim; `verify_claim` re-runs the job
and answers `correct` or `wrong: ...`. A claim is only safe to rely on once its status is `final`.

**Run a circuit.** `describe_circuit` first: it gives pin and state counts and `estimatedStepGas`.
If one beat fits in a block (210M gas) and the user only needs a few, calling TapeOut's own
`step` may be simpler. Otherwise preview with `run_locally`, then `post_job` with the same
arguments. Someone's operator claims it; `finalize_job` after the window, then `get_job` has the
result.

**Keep a stateful machine going.** `continue_job` on a finalized job runs more beats from its
final state.

**Earn as an operator.** `list_jobs` with status `open`, `run_locally` to see the size, then
`claim_job`. Call `advance_disputes` now and then while the claim is open so any challenge gets
answered (an honest claim always wins). `finalize_job` once status is `ready to finalize`.

**Earn as a watcher.** For each `claimed` job, `verify_claim`. On `wrong`, `challenge_claim`
plays the bisection; if it returns open disputes, keep calling `advance_disputes` until none
remain. Each move must land before the opponent's deadline, so do not leave a dispute idle.

**Put a circuit on TapeOut.** `create_processor`, then `tapeout_circuit` with a TAP-02 netlist
(it mints the transistors it needs). A netlist that REFs another circuit needs that circuit taped
out first. `life_circuits` gives a working example: tape out the cell, then the board with the
processor address and the cell's id.

## When something fails

Tool errors come back as text. `not a TapeOut processor` means the address is not registered
with the TapeOut factory Overclock trusts. A revert on `finalize_job` usually means the window has
not passed or the job is disputed; `get_job` shows which.
