// The B3 runner: runs every stuck machine on the census once and records it in web/runs.json.
//
//   RPC_URL=https://testrpc.xlayer.tech RUNNER_KEY=0x... node scripts/runner.js [--watch] [--limit N] [--only proc:id,...]
//   node scripts/runner.js --dry-run [--limit N]          # prints the plan; needs no key, sends nothing
//
// Testnet (default off X Layer mainnet): each circuit is mirrored from mainnet into the playground's
// TapeOutLocal processor (deployments/<chain>.json, or RUNNER_PROCESSOR) and run there. Mainnet
// (chain 196): the circuit is used directly. RUNNER_MODE=direct|mirror overrides.
//
// Environment (the key is read from RUNNER_KEY only and never printed):
//   RUNNER_KEY  RPC_URL  OVERCLOCK  RUNNER_PROCESSOR  MAINNET_RPC
//   RUNNER_FEE (0.00001)  RUNNER_FLOOR (0.0005)  RUNNER_RESERVE (0.0003)  RUNNER_MAX_PER_DAY (0.01)   [OKB]
//   RUNNER_MAX_STEPS (20000000)  RUNNER_PARALLEL (1)  RUNNER_POLL_MS (5000)
//   RUNNER_STATE (runner-state-<chain>.json)  RUNNER_RUNS (web/runs.json)  RUNNER_CENSUS (docs/census.json)
//   RUNNER_REFS  JSON { "<processor>:<id>" | "shape:<gates>/<nIn>/<nOut>/<nState>": { processor, id, name? } }
//                naming the reference circuit a miner is certified against (src/bench.js)
//
// Resumable: kill it any time and start it again; it picks up where the state file says.

import { readFileSync } from 'node:fs';
import { buildQueue, dryRun, runnerFromEnv } from '../src/runner.js';
import { formatEther } from 'ethers';

const args = process.argv.slice(2);
const flag = (k) => args.includes(`--${k}`);
const arg = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const only = arg('only') ? new Set(arg('only').split(',').map((s) => s.trim().toLowerCase())) : null;
const limit = arg('limit') ? Number(arg('limit')) : Infinity;
const log = (e) => console.log(JSON.stringify(e));

if (flag('dry-run')) {
  const census = JSON.parse(readFileSync(process.env.RUNNER_CENSUS ?? new URL('../docs/census.json', import.meta.url), 'utf8'));
  const refs = process.env.RUNNER_REFS ? JSON.parse(readFileSync(process.env.RUNNER_REFS, 'utf8')) : {};
  const plan = dryRun(buildQueue(census), { maxSteps: Number(process.env.RUNNER_MAX_STEPS ?? 20_000_000), refs, only, limit });
  for (const p of plan) {
    console.log(`${String(p.kind).padEnd(7)} ${p.name} #${p.id} ${p.processor.slice(0, 10)}…  ${p.gates} gates, ${p.nState} state: ${p.skip ? `SKIP (${p.skip})` : `${p.beats} beats, ${p.steps.toLocaleString()} steps${p.certificate ? ', certificate' : ''}`}${p.members?.length ? ` (shape of ${p.members.length + 1})` : ''}`);
  }
  console.log(`dry run: ${plan.length} items, nothing sent`);
  process.exit(0);
}

const runner = await runnerFromEnv({ opts: { limit, only }, log });
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { console.log(JSON.stringify({ what: `${sig}: finishing the current step` })); runner.stop(); });
console.log(JSON.stringify({ what: 'runner starts', chain: Number((await runner.provider.getNetwork()).chainId), overclock: String(runner.oc.target), runner: runner.signer.address, mode: runner.mode, queue: runner.queue.length }));
const out = await runner.run({ watch: flag('watch') });
console.log(JSON.stringify({ what: 'runner stops', ...out, balance: formatEther(await runner.balance()) }));
process.exit(0);
