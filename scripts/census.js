// Census of every circuit taped out on X Layer mainnet: its size, its state, who holds it, and what running
// it directly would cost. Read-only, through Multicall3, so the whole chain takes a few dozen calls.
//
//   node scripts/census.js [--rpc https://rpc.xlayer.tech] [--out docs/census.json]
//
// Also writes docs/census.md: every processor with a circuit out of reach, its holders, and a link that opens
// its biggest circuit on the site's "Your circuit" view. That is the list of teams to talk to first.
//
// Gas per gate is taken from our three direct-run measurements on mainnet (docs/headline-demos.md,
// docs/mainnet-run.md): 388M gas for 161,080 gates, 441M for 148,480, 34.3B for 14.37M, plus eth_estimateGas of
// step() on three other teams' machines. All six are between 2,354 and 2,970 gas per flattened gate, so 2,400
// is close to the cheapest.

import { JsonRpcProvider, Contract, Interface } from 'ethers';
import { writeFileSync, mkdirSync } from 'node:fs';
import { XLAYER, FACTORY_ABI } from '../src/tapeout.js';

const opt = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const RPC = opt('rpc', process.env.RPC_URL ?? XLAYER.rpc);
const OUT = opt('out', 'docs/census.json');
export const GAS_PER_GATE = 2400;
export const BLOCK_GAS = 210_000_000;
const MULTICALL = '0xcA11bde05977b3631167028862bE2a173976CA11';
const CHUNK = 400;

const p = new JsonRpcProvider(RPC, 196, { staticNetwork: true, batchMaxCount: 1 });
const mc = new Contract(MULTICALL, ['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])'], p);
const factory = new Contract(XLAYER.factory, FACTORY_ABI, p);
const cpuI = new Interface([
  'function nextId() view returns (uint256)',
  'function name() view returns (string)',
  'function circuitInfo(uint256 id) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)',
  'function ownerOf(uint256 id) view returns (address)',
]);
const facI = new Interface(FACTORY_ABI);

// [[target, iface, fn, args]] → decoded result or null, CHUNK calls per eth_call.
async function multi(calls) {
  const out = [];
  for (let i = 0; i < calls.length; i += CHUNK) {
    const part = calls.slice(i, i + CHUNK);
    let res;
    for (let tries = 0; ; tries++) {
      try {
        res = await mc.aggregate3(part.map(([t, I, f, a]) => ({ target: t, allowFailure: true, callData: I.encodeFunctionData(f, a) })));
        break;
      } catch (e) {
        if (tries > 4) throw e;
        await new Promise((r) => setTimeout(r, 1000 * 2 ** tries));
      }
    }
    res.forEach(([ok, data], k) => {
      const [, I, f] = part[k];
      try { out.push(ok ? I.decodeFunctionResult(f, data) : null); } catch { out.push(null); }
    });
  }
  return out;
}

const block = await p.getBlockNumber();
const nCpu = Number(await factory.cpuCount());
const cpus = (await multi(Array.from({ length: nCpu }, (_, i) => [XLAYER.factory, facI, 'cpus', [i]]))).map((r) => r[0]);
const meta = await multi(cpus.flatMap((a) => [[a, cpuI, 'nextId', []], [a, cpuI, 'name', []]]));
const procs = cpus.map((a, i) => ({ address: a, name: meta[2 * i + 1]?.[0] ?? '', circuits: Math.max(0, Number(meta[2 * i]?.[0] ?? 1n) - 1) }));
console.log(`block ${block}: ${nCpu} processors, ${procs.reduce((s, x) => s + x.circuits, 0)} circuits`);

const ids = procs.flatMap((x) => Array.from({ length: x.circuits }, (_, k) => [x, k + 1]));
const info = await multi(ids.flatMap(([x, id]) => [[x.address, cpuI, 'circuitInfo', [id]], [x.address, cpuI, 'ownerOf', [id]]]));
const circuits = [];
ids.forEach(([x, id], k) => {
  const i = info[2 * k], o = info[2 * k + 1];
  if (!i) return;
  const gates = Number(i.gateCount), nState = Number(i.nState);
  const beatGas = gates * GAS_PER_GATE;
  circuits.push({
    processor: x.address, processorName: x.name, id, owner: o?.[0] ?? null,
    nIn: Number(i.nIn), nOut: Number(i.nOut), nState, gates,
    beatGas, beatsPerBlock: Math.floor(BLOCK_GAS / Math.max(1, beatGas)),
  });
});

// A circuit is out of reach when one beat doesn't fit a block. A machine is a circuit with state and logic
// (at least 16 gates besides its LATCHes; pure LATCH banks are storage, not machines). It is held back when a
// block fits fewer than 1,000 of its beats: a CPU or a game that stops after a few hundred steps.
const tooBig = circuits.filter((c) => c.beatsPerBlock < 1).sort((a, b) => b.gates - a.gates);
const machines = circuits.filter((c) => c.nState > 0 && c.gates - c.nState >= 16);
const heldBack = machines.filter((c) => c.beatsPerBlock >= 1 && c.beatsPerBlock < 1000).sort((a, b) => a.beatsPerBlock - b.beatsPerBlock);
const owners = new Set([...tooBig, ...heldBack].map((c) => c.owner).filter(Boolean));
// What the site lists: everything out of reach, then the biggest held-back machine of each processor.
// Our own processor's demo circuits are left out; a processor with many big circuits shows its three biggest.
const OURS = '0xb00f10bb4b2f32c561bf90e205e543d0a2395971';
const seen = new Map();
const take = (c, n) => c.processor.toLowerCase() !== OURS && (seen.get(c.processor) ?? 0) < n && seen.set(c.processor, (seen.get(c.processor) ?? 0) + 1);
const featured = [...tooBig.filter((c) => take(c, 3)), ...heldBack.slice().sort((a, b) => b.gates - a.gates).filter((c) => take(c, 1))].slice(0, 16)
  .map(({ processor, processorName, id, gates, nState, nIn, nOut, owner }) => ({ processor, processorName, id, gates, nState, nIn, nOut, owner }));
const summary = {
  chainId: 196, block, at: new Date().toISOString(), gasPerGate: GAS_PER_GATE, blockGas: BLOCK_GAS,
  processors: nCpu, circuits: circuits.length, machines: machines.length,
  largest: circuits.reduce((m, c) => Math.max(m, c.gates), 0),
  tooBigForABlock: tooBig.length, machinesHeldBack: heldBack.length, ownersToReach: owners.size,
};
mkdirSync('docs', { recursive: true });
writeFileSync(OUT, JSON.stringify({ summary, featured, tooBig, heldBack }, null, 1));

const SITE = 'https://overclock-board.onrender.com';
const fmt = (n) => n.toLocaleString('en-US');
const byProc = new Map();
for (const c of [...tooBig, ...heldBack]) {
  if (c.processor.toLowerCase() === OURS) continue;
  const g = byProc.get(c.processor) ?? { name: c.processorName, processor: c.processor, list: [], owners: new Set() };
  g.list.push(c); if (c.owner) g.owners.add(c.owner); byProc.set(c.processor, g);
}
const groups = [...byProc.values()].map((g) => ({ ...g, top: g.list.reduce((a, b) => (b.gates > a.gates ? b : a)) })).sort((a, b) => b.top.gates - a.top.gates);
const reach = (c) => (c.beatsPerBlock < 1 ? `${(c.beatGas / BLOCK_GAS).toFixed(2)} blocks per run` : `${fmt(c.beatsPerBlock)} beats per block`);
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const md = `# Who Overclock is for: a census of X Layer mainnet

Generated by \`node scripts/census.js\` at block ${fmt(block)} (${summary.at.slice(0, 10)}). Every circuit of all ${fmt(nCpu)} processors
in the TapeOut factory, read through Multicall3.

| | |
|---|---:|
| Circuits on mainnet | ${fmt(circuits.length)} |
| Machines (state plus at least 16 logic gates) | ${fmt(machines.length)} |
| Too big to run even once in a block | ${fmt(tooBig.length)} |
| Machines a block can't run 1,000 beats of | ${fmt(heldBack.length)} |
| Wallets holding those circuits | ${fmt(owners.size)} |

Direct cost is gates × beats × ${fmt(GAS_PER_GATE)} gas, the lowest per-gate figure from our mainnet measurements (2,354 to 2,970
on six circuits), against a ${fmt(BLOCK_GAS / 1e6)}M-gas block. Through Overclock the honest path is a claim
and a finalize whatever the beats: 182K to 2.24M gas for the three jobs we ran on mainnet.

## Processors with circuits out of reach

Each link opens the biggest one on the site, runs it in the browser and checks beat 1 against TapeOut's own
\`eval\`/\`step\` where it fits a call.

| Processor | Circuits out of reach | Biggest | Directly on-chain | Holders | Try it |
|---|---:|---|---|---|---|
${groups.map((g) => `| ${g.name || short(g.processor)} ([${short(g.processor)}](https://www.oklink.com/x-layer/address/${g.processor})) | ${fmt(g.list.length)} | #${g.top.id}: ${fmt(g.top.gates)} gates, ${fmt(g.top.nState)} state bits | ${reach(g.top)} | ${[...g.owners].slice(0, 3).map((o) => `[${short(o)}](https://www.oklink.com/x-layer/address/${o})`).join(', ')}${g.owners.size > 3 ? ` and ${g.owners.size - 3} more` : ''} | [run it](${SITE}/#try?cpu=${g.processor}&id=${g.top.id}&beats=${g.top.nState ? 1000 : 1}) |`).join('\n')}
`;
writeFileSync(OUT.replace(/\.json$/, '.md'), md);
console.log(JSON.stringify(summary, null, 1));
