// Check our TAP-02 evaluator against TapeOut's own eval()/step() on live circuits. Read-only.
//
//   RPC_URL=https://rpc.xlayer.tech node scripts/verify-live.js [--cpus 40] [--per-cpu 4] [--samples 8] [--max-gates 20000]
//
// Samples circuits across the factory's processors (REFs are followed across processors), runs
// random inputs and states through both evaluators and writes docs/live-check.json.

import { JsonRpcProvider, Contract } from 'ethers';
import { writeFileSync, mkdirSync } from 'node:fs';
import { loadCircuit } from '../src/chain.js';
import { beat, pack, unpack, bytesToHex, hexToBytes } from '../src/tap02.js';
import { XLAYER, FACTORY_ABI, CIRCUITS_FULL_ABI } from '../src/tapeout.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const CPUS = arg('cpus', 40), PER = arg('per-cpu', 4), SAMPLES = arg('samples', 8), MAX = arg('max-gates', 20000);
const provider = new JsonRpcProvider(process.env.RPC_URL ?? XLAYER.rpc);
const factory = new Contract(process.env.FACTORY ?? XLAYER.factory, FACTORY_ABI, provider);
const net = await provider.getNetwork();
const block = await provider.getBlockNumber();
const nCpu = Number(await factory.cpuCount());
console.log(`chain ${net.chainId}, block ${block}: ${nCpu} processors`);

let seed = 0x0c10c;
const rand = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) & 1);
const bits = (n) => Array.from({ length: n }, rand);

const cache = new Map();
const results = [];
const stride = Math.max(1, Math.floor(nCpu / CPUS));
for (let k = 0; k < nCpu && results.length < CPUS * PER; k += stride) {
  const addr = await factory.cpus(k);
  const circuits = new Contract(addr, CIRCUITS_FULL_ABI, provider);
  const count = Number(await circuits.nextId().catch(() => 0n));
  const ids = [...new Set(Array.from({ length: Math.min(PER, count) }, (_, i) => 1 + Math.floor((i * count) / Math.min(PER, count))))];
  for (const id of ids) {
    const row = { cpu: addr, id };
    try {
      const info = await circuits.circuitInfo(id);
      Object.assign(row, { nIn: Number(info.nIn), nOut: Number(info.nOut), nState: Number(info.nState), gates: Number(info.gateCount) });
      if (row.gates > MAX) { row.skipped = `more than ${MAX} gates`; results.push(row); continue; }
      const c = await loadCircuit(provider, addr, BigInt(id), cache);
      let agree = 0;
      for (let s = 0; s < SAMPLES; s++) {
        const ins = bits(c.nIn), st = bits(c.nState);
        const [ns, outs] = beat(c, st, ins);
        if (c.nState === 0) {
          const got = await circuits.eval(id, bytesToHex(pack(ins)));
          if (bytesToHex(pack(outs)) === got.toLowerCase()) agree++;
        } else {
          const [gotState, gotOuts] = await circuits.step(id, bytesToHex(pack(st)), bytesToHex(pack(ins)));
          if (bytesToHex(pack(outs)) === gotOuts.toLowerCase() && bytesToHex(pack(ns)) === gotState.toLowerCase()) agree++;
        }
      }
      Object.assign(row, { samples: SAMPLES, agree, refs: c.elements.filter((e) => e.op === 2).length });
    } catch (e) {
      row.error = e.shortMessage ?? e.message;
    }
    results.push(row);
    console.log(`${addr} #${id}: ${row.skipped ?? row.error ?? `${row.agree}/${row.samples} agree (${row.gates} gates, ${row.nState} state bits)`}`);
  }
}

const checked = results.filter((r) => r.samples);
const summary = {
  chainId: Number(net.chainId), block, processors: nCpu,
  circuitsChecked: checked.length,
  samples: checked.reduce((s, r) => s + r.samples, 0),
  agree: checked.reduce((s, r) => s + r.agree, 0),
  stateful: checked.filter((r) => r.nState > 0).length,
  withRefs: checked.filter((r) => r.refs > 0).length,
  skipped: results.filter((r) => r.skipped).length,
  errors: results.filter((r) => r.error).length,
};
mkdirSync('docs', { recursive: true });
writeFileSync('docs/live-check.json', JSON.stringify({ summary, results }, null, 1));
console.log(JSON.stringify(summary, null, 1));
process.exit(summary.agree === summary.samples ? 0 : 1);
