# overclock-js

A small library for apps that need a result from a TapeOut circuit that is too big to run in a block. You post a job to [Overclock](../../README.md), an operator runs it off-chain and bonds the answer, and once the challenge window passes without a dispute you read a settled result. It is a library, not a game.

```js
import { JsonRpcProvider, Wallet, parseEther } from 'ethers';
import { connect } from 'overclock-js';

const signer = new Wallet(process.env.KEY, new JsonRpcProvider(process.env.RPC_URL));
const app = connect({ signer, overclock: '0x...' }); // the Overclock contract

const { jobId, bond } = await app.postJob({
  processor: '0x...', // the TapeOut processor that holds the circuit
  circuitId: 5,
  beats: 20,
  inputs: [1, 0, 1, 1], // bits; packed hex also works
  fee: parseEther('0.01'), // paid to the operator whose claim finalizes
});

await app.watchJob(jobId);           // waits until an operator has claimed and the window has passed
await app.finalize(jobId);           // anyone can send this
const { outputs, newState } = await app.getResult(jobId); // bits
```

## API

All of it hangs off `connect({ signer | provider, overclock, abi?, stream? })`. Reads work with a provider alone.

| Call | What it does |
|---|---|
| `postJob({ processor, circuitId, beats, inputs, state?, perBeat?, fee? })` | Posts a job. Returns `{ jobId, bond, txHash, receipt }`. `inputs` is one beat's bits, applied every beat; with `perBeat` (or when you pass more than one beat's bits) it is `beats * nIn` bits. Missing bits are 0. `bond` is `bondFor(jobId)`: the minimum bond plus a share of `fee`. |
| `getJob(jobId)` | The job as plain JS, with `status`: `unclaimed`, `claimed`, `challenged`, `finalizable` or `finalized`. |
| `watchJob(jobId, { until?, intervalMs?, timeoutMs?, signal?, onUpdate? })` | Polls until the job reaches `until` (default `finalized`). `onUpdate` fires on each status change. |
| `finalize(jobId)` | Settles a job whose window is over. Pays the operator. |
| `getResult(jobId, { verify? })` | The finalized `outputs` and `newState`, as bits and packed hex. Throws `NotFinalizedError` before that. `verify: true` also recomputes the job and sets `verified`. |
| `runLocally({ processor, circuitId, beats, inputs, state?, perBeat? })` or `runLocally({ jobId })` | Runs the circuit on this machine with the TAP-02 evaluator. Returns `outputs`, `newState` and the `traceRoot` an honest claim commits to. |
| `verifyClaim(jobId)` | Recomputes the trace root and result and compares them with the operator's claim: `honest`, `cheating` (with a `reason`) or `no-claim`. |

The package also re-exports the pieces it is built from (`Operator`, `Challenger`, `loadCircuit`, `traceJob`, `Tree`, `pack`/`unpack` and others from the repository's `src/`), so an app that wants to run its own operator or watcher needs no second import.

## Try it

From the repository root, on a local dev node (nothing leaves your machine):

```sh
npm run build                                   # compile the contracts once
npx ganache --wallet.totalAccounts 4 --wallet.defaultBalance 1000 &
RPC_URL=http://127.0.0.1:8545 node packages/overclock-js/examples/post-and-read.js
CHEAT=1 RPC_URL=http://127.0.0.1:8545 node packages/overclock-js/examples/post-and-read.js   # adds a dishonest operator
```

The script deploys a throwaway stack (a mock TapeOut processor holding a real 8-bit popcount circuit, plus Overclock v2), posts a job, has an operator claim it, finalizes and reads the result. With `CHEAT=1` it also shows `verifyClaim` flagging a claim with one corrupted gate. `test/overclock-js.test.js` covers every call and runs this script.

## Notes

- It targets Overclock v2 (per-job bond `bondFor(jobId)`). `verifyClaim` only tells you; to dispute a bad claim, run the repository's `Challenger`, which plays the 16-way dissection.
- Status is computed from the latest block's time, so a quiet chain can show `claimed` a little after the window ended. `finalize` itself is judged by the contract.
- `runLocally` and `verifyClaim` hold the whole trace in memory, and switch to the streaming engine for traces above 2^27 leaves (`stream` option).
- This package lives in the Overclock repository and imports its `src/` modules directly. It is not published to npm: shipping it needs a build step that vendors those modules.
