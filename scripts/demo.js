// End-to-end demo on a local EVM: Game of Life as TapeOut circuits, run by Overclock.
//
//   node scripts/demo.js [--w 16] [--h 16] [--beats 100] [--out web/demo-run.json]
//
// A cheating operator claims a result with one corrupted gate deep in the run. The watcher
// re-runs the job, bisects to that gate and proves it wrong in a single transaction. An honest
// operator then claims, the window passes, and any contract can read the final board.

import ganache from 'ganache';
import { BrowserProvider, ContractFactory, parseEther, formatEther } from 'ethers';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { load, pack, unpack, bytesToHex, hexToBytes } from '../src/tap02.js';
import { layout, flatSize } from '../src/trace.js';
import { cellCircuit, boardCircuit, lifeStep, board, PATTERNS, render } from '../src/life.js';
import { Operator, Challenger } from '../src/agents.js';
import { artifact } from '../src/chain.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const W = Number(arg('w', 16)), H = Number(arg('h', 16)), BEATS = Number(arg('beats', 100));
const OUT = arg('out', 'web/demo-run.json');
const BOND = parseEther('1'), WINDOW = 3600, FEE = parseEther('0.1');

const say = (s) => console.log(s);
const log = [];
const record = (e) => {
  log.push(e);
  say(`  ${e.who.padEnd(10)} ${e.what}${e.gas ? `  (${e.gas.toLocaleString()} gas)` : ''}${e.ms ? `  (${e.ms} ms)` : ''}`);
};

const provider = new BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, miner: { blockGasLimit: 2_000_000_000, callGasLimit: 2_000_000_000 }, wallet: { totalAccounts: 4, defaultBalance: 1000 } }));
const [deployer, honest, cheat, watcher] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
const deploy = async (name, ...args) => {
  const a = artifact(name);
  const c = await new ContractFactory(a.abi, a.bytecode, deployer).deploy(...args);
  await c.waitForDeployment();
  return c;
};

say(`\nOverclock demo: Game of Life, ${W}x${H} board, ${BEATS} generations\n`);
const cpu = await deploy('MockProcessor');
const oc = await deploy('Overclock', BOND, WINDOW);
const direct = await deploy('DirectEval');
const cpuAddr = (await cpu.getAddress()).toLowerCase();

// "Tape out" the two circuits.
const cell = cellCircuit();
const cellC = load(cell.netlist, cell.nIn, cell.nOut);
await (await cpu.store(cell.netlist, cell.nIn, cell.nOut, 0, cellC.nGates)).wait();
const cellId = 1;
const bd = boardCircuit(W, H, cpuAddr, cellId);
const bdC = load(bd.netlist, bd.nIn, bd.nOut, (a, i) => (a === cpuAddr && i === BigInt(cellId) ? cellC : null));
await (await cpu.store(bd.netlist, bd.nIn, bd.nOut, bdC.nState, bdC.nGates)).wait();
const boardId = 2;
say(`circuits: cell rule ${cellC.nGates} gates; board ${bdC.nGates.toLocaleString()} gates per generation (${W * H} REFs to the cell, ${bdC.nState} LATCHes)`);

// Starting board.
const start = board(W, H, [[PATTERNS.glider, 1, 1], [PATTERNS.lwss, 3, 9], [PATTERNS.blinker, 11, 3], [PATTERNS.toad, 9, 12], [PATTERNS.glider, 9, 6]].filter(([, x, y]) => x < W && y < H));
const gens = [start];
for (let g = 0; g < BEATS; g++) gens.push(lifeStep(gens.at(-1), W, H));

// Baseline: running it directly on-chain.
const directRc = await (await direct.run(cpuAddr, boardId, bytesToHex(pack(start)), 1, { gasLimit: 1_000_000_000 })).wait();
const directGas1 = Number(directRc.gasUsed);
const perGen = directGas1; // per-call overhead is tiny next to 14,848 gates
say(`direct on-chain evaluation: ${directGas1.toLocaleString()} gas for one generation; about ${(perGen * BEATS).toLocaleString()} gas for ${BEATS}`);

// Post the job.
const postRc = await (await oc.connect(deployer).postJob(cpuAddr, boardId, '0x', bytesToHex(pack(start)), BEATS, false, { value: FEE })).wait();
record({ who: 'poster', what: `posts the job: ${BEATS} generations, fee ${formatEther(FEE)}`, fn: 'postJob', gas: Number(postRc.gasUsed) });
const L = layout(bdC, BEATS);
const depth = Math.ceil(Math.log2(L.n));
say(`trace: ${L.n.toLocaleString()} leaves (${L.B.toLocaleString()} per generation), tree depth ${depth}\n`);

// The cheat flips the output gate of one cell's rule in one generation, picked so the final board changes.
const lieBeat = Math.floor(BEATS * 0.6);
const cellFlat = flatSize(cellC);
let lieCell = -1, most = 0;
for (let k = 0; k < W * H; k++) {
  let s = lifeStep(gens[lieBeat], W, H);
  s[k] ^= 1;
  for (let g = lieBeat + 1; g < BEATS; g++) s = lifeStep(s, W, H);
  const diff = s.reduce((n, v, i) => n + (v !== gens[BEATS][i]), 0);
  if (diff > most) [lieCell, most] = [k, diff];
}
const cellStart = lieBeat * L.B + 2 + bdC.nState + lieCell * (cellFlat + 1);
const lieLeaf = cellStart + cellFlat - 1; // the cell rule's last NAND
const lie = { beat: lieBeat, generation: lieBeat + 1, cell: lieCell, x: lieCell % W, y: Math.floor(lieCell / W), leaf: lieLeaf };
say(`the cheat corrupts one NAND: generation ${lie.generation}, cell (${lie.x}, ${lie.y}), trace leaf ${lieLeaf.toLocaleString()}\n`);

let lied = false;
const cheater = new Operator({ oc, signer: cheat, name: 'cheat', log: record, lie: () => (lied ? null : ((lied = true), lieLeaf)) });
const op = new Operator({ oc, signer: honest, name: 'operator', log: record });
const watch = new Challenger({ oc, signer: watcher, name: 'watcher', log: record });

say('round 1: the cheat claims');
await cheater.tick();
const claimed = await oc.jobs(0);
const cheatBoard = unpack(hexToBytes(claimed.newState), W * H);
for (let i = 0; i < 4 * depth + 10; i++) {
  await watch.tick();
  await cheater.tick();
  if (Number(await oc.gameCount()) > 0 && Number((await oc.games(0)).level) === 255) break;
}

say('\nround 2: an honest operator claims');
await op.tick();
await watch.tick();
await provider.send('evm_increaseTime', [WINDOW + 1]);
await provider.send('evm_mine', []);
await op.tick();
const [outs, finalState] = await oc.result(0);
const finalBoard = unpack(hexToBytes(finalState), W * H);
const ok = finalBoard.every((v, i) => v === gens[BEATS][i]);
say(`\nfinal board from Overclock.result() matches plain-JS Life: ${ok}`);
say(render(finalBoard, W));

const gasOf = (fn, who) => log.filter((e) => e.fn === fn && (!who || e.who === who)).reduce((s, e) => s + e.gas, 0);
const disputeTx = log.filter((e) => e.gas && ['challenge', 'reveal', 'pick', 'resolveLeaf'].includes(e.fn));
const summary = {
  directPerGeneration: perGen,
  directOneGeneration: directGas1,
  directTotal: perGen * BEATS,
  claim: gasOf('claim', 'operator'),
  finalize: gasOf('finalize'),
  disputeTotal: disputeTx.reduce((s, e) => s + e.gas, 0),
  disputeTxs: disputeTx.length,
  disputeMaxTx: Math.max(...disputeTx.map((e) => e.gas)),
  resolveLeaf: gasOf('resolveLeaf'),
};
say(`gas: honest path ${(summary.claim + summary.finalize).toLocaleString()} (claim + finalize); dispute ${summary.disputeTotal.toLocaleString()} over ${summary.disputeTxs} transactions, largest ${summary.disputeMaxTx.toLocaleString()}`);
say(`      direct evaluation of the same job: ${summary.directTotal.toLocaleString()} (${Math.round(summary.directTotal / (summary.claim + summary.finalize)).toLocaleString()}x the honest path)`);

const steps = log.filter((e) => e.fn === 'pick').map((e) => {
  const p = e.events.find((x) => x.name === 'Picked').args;
  const level = Number(p.level), index = Number(p.index);
  return { level, from: index * 2 ** level, to: Math.min((index + 1) * 2 ** level, L.n) - 1 };
});
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  w: W, h: H, beats: BEATS, bond: formatEther(BOND), fee: formatEther(FEE),
  circuits: { cellGates: cellC.nGates, boardGates: bdC.nGates, latches: bdC.nState, refs: W * H, cellNetlistBytes: cell.netlist.length, boardNetlistBytes: bd.netlist.length },
  trace: { leaves: L.n, perGeneration: L.B, depth },
  lie, steps, gas: summary, matches: ok,
  generations: gens.map((g) => bytesToHex(pack(g))),
  cheatFinal: bytesToHex(pack(cheatBoard)),
  log: log.map(({ events, ...e }) => e),
}, null, 1));
say(`\nwrote ${OUT}`);
process.exit(ok ? 0 : 1);
