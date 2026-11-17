---
name: overclock
description: Use when the user wants to run, check or build TapeOut circuits on X Layer with Overclock - posting compute jobs too big for one block, verifying or challenging a claimed result, operating as a bonded operator or watcher, or creating a TapeOut processor and taping out a netlist.
---

# Overclock

Overclock runs TapeOut circuits on X Layer far past the block gas limit. An operator runs a job
off-chain and claims the result with a bond. Anyone can re-run it. If the claim is wrong, a
challenger narrows the trace down to one gate (the contract opens sixteen branches a move, so a
dispute takes a handful of rounds), the contract re-checks that gate against the netlist TapeOut
stores, and the liar loses its bond: half to the challenger, half to a pool for the treasury.
Unchallenged claims finalize after the challenge window and become readable by any contract.

A job's bond is the contract's minimum plus a share of the job's fee, so a lie on a big job always
risks more than the job pays. `get_job` shows it as `bond`; `overclock_info` shows the minimum,
the share, and the slashed pool. The contract's own runner may also post deliberate wrong claims
("forced errors", so watchers earn even when nobody cheats): catching one pays the challenger
its bond back plus a jackpot from the pool, and a claim the runner has committed to takes two
windows to finalize for anyone else (`get_job` says so).

The `overclock` MCP server provides the tools. Configuration comes from the environment:
`RPC_URL` (defaults to X Layer mainnet), `OVERCLOCK` (the deployed contract; on X Layer mainnet it
defaults to `0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710`, elsewhere without it only the TapeOut tools appear).
That first deployment is retired: its tools read fine (jobs, games, results), but claiming and
challenging speak the current contract's ABI, so for those set `OVERCLOCK` to a v2 deployment
(`overclock_info` says "an earlier contract version" when it is the old one).

## Ready-made machines

People should never need an address or hex. Two machines are already on X Layer mainnet:

- `machine: "life"`: Game of Life on an 8x8 board. `pattern` is glider (default), blinker, toad,
  lwss or rpentomino; `beats` is the number of generations. Results come back as a `picture`.
- `machine: "cpu"`: a 4-bit CPU running Fibonacci. 16 beats make the next number (mod 256).

"Show me", "try" or "what happens if" means `run_locally`: free, instant, no wallet. Only use
`post_job` when the user wants it run and settled on-chain. A circuit whose one-step check could
cost too much gas is refused with "check too costly"; `describe_circuit` gives the size.

## Wallet

Never ask the user for a private key or seed phrase, and there is no setup step. Call the
transaction tool directly:

1. If it finishes, it returns the result.
2. If it needs the user, it returns `status: "waiting for approval"`, an `approve` link and a
   `requestId`. Show the link as one tappable link: it opens a page that connects OKX Wallet or
   MetaMask and shows the transaction to approve. On a phone, `phone.openInOkxWalletApp` opens the
   page inside the OKX Wallet app.
3. When they say they approved (or after a short wait), call `transaction_status` with the
   `requestId` to get the result.

A rejection comes back as an error starting `Wallet:`: the user said no, so do not retry unasked.
Tools that send several transactions (`tapeout_circuit`, `challenge_claim`) ask once per
transaction; say how many to expect. If the server was started with `OVERCLOCK_PRIVATE_KEY` it
signs without asking; the cost rules below matter even more then.

## Conventions

- Bit vectors (inputs, state, outputs) are TAP-02 packed hex: bit i is `(byte[i>>3] >> (i&7)) & 1`.
  Tools also return a `bits` string, bit 0 first, for reading.
- Amounts are OKB as decimal strings (`"0.01"`).
- A circuit is a `processor` (its TapeOut circuits contract) plus a `circuitId`.

## Before spending anything

Every write tool sends a real transaction. Before calling one, tell the user what it costs and get
a yes, unless they already asked for exactly that action. Their wallet prompt shows the amount,
but they should not be surprised by it:

| Tool | Cost |
|---|---|
| `post_job`, `continue_job` | the `fee` (default 0.0001 OKB), paid to whoever's claim finalizes |
| `claim_job`, `challenge_claim` | locks the job's bond (`get_job`: the minimum plus a share of the fee); returned with winnings if you are right. A winning challenge gets its bond plus half the loser's |
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
plays the dispute (a few rounds of reveal and pick); if it returns open disputes, keep calling `advance_disputes` until none
remain. Each move must land before the opponent's deadline, so do not leave a dispute idle, and
tell the user each move needs their approval in the wallet. For unattended watching or operating,
suggest a dedicated wallet with `OVERCLOCK_PRIVATE_KEY` holding only the bond and gas.

**Put a circuit on TapeOut.** `create_processor`, then `tapeout_circuit` with a TAP-02 netlist
(it mints the transistors it needs). A netlist that REFs another circuit needs that circuit taped
out first. `life_circuits` gives a working example: tape out the cell, then the board with the
processor address and the cell's id.

## When something fails

Tool errors come back as text. `not a TapeOut processor` means the address is not registered
with the TapeOut factory Overclock trusts. A revert on `finalize_job` usually means the window has
not passed or the job is disputed; `get_job` shows which.
