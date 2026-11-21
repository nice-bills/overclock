// Post a job to Overclock, watch it settle, read the verified result.
//
//   npm run build                       # once, in the repository root: compiles the contracts
//   npx ganache --wallet.totalAccounts 4 --wallet.defaultBalance 1000 &
//   RPC_URL=http://127.0.0.1:8545 node packages/overclock-js/examples/post-and-read.js
//   CHEAT=1 RPC_URL=... node ...        # also shows verifyClaim catching a dishonest operator
//
// This talks to a local dev node whose accounts are unlocked and funded (ganache, hardhat), and
// sends nothing anywhere else. With no OVERCLOCK/PROCESSOR/CIRCUIT_ID set it first deploys a
// throwaway stack (examples/local-stack.js); set the three to use one that already exists.
import { JsonRpcProvider, Contract, parseEther, formatEther } from 'ethers';
import { connect, artifact, Operator } from '../src/index.js';
import { deployLocalStack } from './local-stack.js';

if (!process.env.RPC_URL) {
  console.error('Set RPC_URL to a local dev node, e.g. RPC_URL=http://127.0.0.1:8545');
  process.exit(1);
}
const provider = new JsonRpcProvider(process.env.RPC_URL, undefined, { polling: true, pollingInterval: 250, cacheTimeout: -1 });
const [poster, operatorKey, cheatKey] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
const say = (s) => console.log(s);

const stack = process.env.OVERCLOCK
  ? { overclock: process.env.OVERCLOCK, processor: process.env.PROCESSOR, circuits: { popcount: BigInt(process.env.CIRCUIT_ID) }, window: null }
  : await deployLocalStack(poster);
const app = connect({ signer: poster, overclock: stack.overclock });
const full = new Contract(stack.overclock, artifact('Overclock').abi, provider); // an operator needs every method
const window = stack.window ?? Number(await app.contract.window());

// ---- 1. an app posts a job: count the 1s in 1,0,1,1,0,1,1,1 -------------------------------------
const job = { processor: stack.processor, circuitId: stack.circuits.popcount, beats: 1, inputs: [1, 0, 1, 1, 0, 1, 1, 1], fee: parseEther('0.01') };
const { jobId, bond } = await app.postJob(job);
say(`posted job ${jobId}: fee ${formatEther(job.fee)}, an operator must bond ${formatEther(bond)}`);
say(`runLocally says: ${JSON.stringify((await app.runLocally(job)).outputs)}`);

// ---- 2. an operator claims it (in production this is somebody else's bot) ------------------------
const operator = new Operator({ oc: full, signer: operatorKey, name: 'operator' });
operator.only = new Set([Number(jobId)]);
await operator.tick();
say(`status: ${(await app.getJob(jobId)).status}`);
say(`verifyClaim: ${(await app.verifyClaim(jobId)).verdict}`);

// ---- 3. nobody disputes it: wait out the challenge window, finalize, read ------------------------
await provider.send('evm_increaseTime', [window + 1]); // a real chain: just app.watchJob(jobId, { until: 'finalizable' })
await provider.send('evm_mine', []);
await app.watchJob(jobId, { until: 'finalizable', intervalMs: 100 });
await app.finalize(jobId);
const result = await app.getResult(jobId);
say(`status: ${(await app.getJob(jobId)).status}`);
say(`result: ${JSON.stringify(result.outputs)}  (popcount of the inputs = 6, little-endian bits 0,1,1,0)`);

// ---- 4. optional: a dishonest operator, caught by recomputing --------------------------------------
if (process.env.CHEAT) {
  const { jobId: bad } = await app.postJob({ ...job, inputs: [1, 1, 1, 1, 0, 0, 0, 1] });
  const cheat = new Operator({ oc: full, signer: cheatKey, name: 'cheat', lie: () => 2 + 8 + 20 }); // corrupts one gate
  cheat.only = new Set([Number(bad)]);
  await cheat.tick();
  const check = await app.verifyClaim(bad);
  say(`verifyClaim on job ${bad}: ${check.verdict} (${check.reason})`);
}
