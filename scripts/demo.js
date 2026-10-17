// End-to-end demo: Game of Life as TapeOut circuits, run by Overclock.
//
//   node scripts/demo.js [--w 16] [--h 16] [--beats 100] [--more 50] [--out web/demo-run.json]
//   node scripts/demo.js --fork http://127.0.0.1:8545     # against the real TapeOut contracts
//
// Without --fork it runs on an in-process EVM with contracts/TapeOutLocal.sol standing in for
// TapeOut. With --fork it expects a local fork of X Layer mainnet (npm run fork) and uses the real
// TapeOut factory, transistors, circuits and circuit accounts at their mainnet addresses.
//
// The flow: create a processor, mint transistors, tape out the cell rule and the board (which REFs
// the cell once per cell), then post a job. A cheating operator claims a result with one corrupted
// gate deep in the run; the watcher bisects to that gate and proves it wrong in one transaction. An
// honest operator then claims and finalizes. Finally the board circuit's own wallet pays to continue
// the run from where the first job ended.

import ganache from 'ganache';
import { BrowserProvider, JsonRpcProvider, ContractFactory, Contract, parseEther, formatEther } from 'ethers';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { load, pack, unpack, bytesToHex, hexToBytes, beat } from '../src/tap02.js';
import { layout, flatSize } from '../src/trace.js';
import { cellCircuit, boardCircuit, lifeStep, board, PATTERNS, render } from '../src/life.js';
import { Operator, Challenger } from '../src/agents.js';
import { artifact } from '../src/chain.js';
import { XLAYER, createCPU, mint, burnCost, tapeout, OPENER_ABI, ACCOUNT_ABI } from '../src/tapeout.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const W = Number(arg('w', 16)), H = Number(arg('h', 16)), BEATS = Number(arg('beats', 100)), MORE = Number(arg('more', 50));
const FORK = arg('fork', null);
const OUT = arg('out', FORK ? 'web/fork-run.json' : 'web/demo-run.json');
const BOND = parseEther('1'), WINDOW = 3600, FEE = parseEther('0.1'), FEE_BPS = 200;

const say = (s) => console.log(s);
const log = [];
const record = (e) => {
  log.push(e);
  say(`  ${e.who.padEnd(10)} ${e.what}${e.gas ? `  (${e.gas.toLocaleString()} gas)` : ''}${e.ms ? `  (${e.ms} ms)` : ''}`);
};
const setup = []; // processor, mints and tapeouts, with gas and tx hashes
const note = (what, rc, extra = {}) => {
  setup.push({ what, gas: Number(rc.gasUsed), tx: rc.hash, ...extra });
  say(`  setup      ${what}  (${Number(rc.gasUsed).toLocaleString()} gas)`);
};

const provider = FORK
  ? new JsonRpcProvider(FORK, undefined, { polling: true, pollingInterval: 250 })
  : new BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, miner: { blockGasLimit: 2_000_000_000, callGasLimit: 2_000_000_000 }, wallet: { totalAccounts: 4, defaultBalance: 1000 } }));
const [deployer, honest, cheat, watcher] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
const net = await provider.getNetwork();
const startBlock = await provider.getBlockNumber();
const deploy = async (name, ...args) => {
  const a = artifact(name);
  const c = await new ContractFactory(a.abi, a.bytecode, deployer).deploy(...args);
  await c.waitForDeployment();
  note(`deploy ${name}`, await c.deploymentTransaction().wait(), { address: await c.getAddress() });
  return c;
};

say(`\nOverclock demo: Game of Life, ${W}x${H} board, ${BEATS} + ${MORE} generations`);
say(FORK ? `chain ${net.chainId} at block ${startBlock} via ${FORK}\n` : 'in-process EVM, TapeOut stand-in (contracts/TapeOutLocal.sol)\n');

// 1. A processor of our own, through the TapeOut factory.
let factoryAddr = arg('factory', FORK ? XLAYER.factory : null);
if (factoryAddr && (await provider.getCode(factoryAddr)) === '0x') {
  say(`no TapeOut factory at ${factoryAddr} on this chain: using the local stand-in instead`);
  factoryAddr = null;
}
if (!factoryAddr) factoryAddr = await (await deploy('TapeOutFactoryLocal')).getAddress();
const realTapeOut = factoryAddr.toLowerCase() === XLAYER.factory;
const cpuSetup = await createCPU(deployer, factoryAddr, { name: 'Overclock Life', symbol: 'OCLIFE', story: 'Game of Life, run by Overclock.', supply: 1_000_000, mintPrice: parseEther('0.00001') });
note('createCPU "Overclock Life"', cpuSetup.receipt);
const { transistors, circuits } = cpuSetup;
const cpuAddr = (await circuits.getAddress()).toLowerCase();

// 2. Tape out the cell rule, then the board, which REFs the cell once per cell.
const cell = cellCircuit();
const cellCost = burnCost(cell.netlist, cell.nIn);
const probe = boardCircuit(W, H, cpuAddr, 1);
const boardCost = burnCost(probe.netlist, 0);
note(`mint ${cellCost.nand} NAND`, await mint(transistors, 0, cellCost.nand + boardCost.nand));
note(`mint ${boardCost.latch} LATCH`, await mint(transistors, 1, cellCost.latch + boardCost.latch));
const cellT = await tapeout(circuits, cell);
note(`tapeout cell rule as circuit #${cellT.id}`, cellT.receipt, { circuit: Number(cellT.id), burned: cellCost });
const cellC = load(cell.netlist, cell.nIn, cell.nOut);
const bd = boardCircuit(W, H, cpuAddr, Number(cellT.id));
const boardT = await tapeout(circuits, bd);
note(`tapeout ${W}x${H} board as circuit #${boardT.id} (${W * H} REFs)`, boardT.receipt, { circuit: Number(boardT.id), burned: boardCost });
const cellId = Number(cellT.id), boardId = Number(boardT.id);
const bdC = load(bd.netlist, bd.nIn, bd.nOut, (a, i) => (a === cpuAddr && i === BigInt(cellId) ? cellC : null));

// TapeOut's own view of the circuits must match ours.
const info = await circuits.circuitInfo(boardId);
const stored = await circuits.netlist(boardId);
if (stored.toLowerCase() !== bytesToHex(bd.netlist) || Number(info.gateCount) !== bdC.nGates || Number(info.nState) !== bdC.nState) throw new Error('TapeOut disagrees about the board circuit');
say(`circuits: cell rule ${cellC.nGates} gates; board ${bdC.nGates.toLocaleString()} gates per generation (TapeOut's circuitInfo agrees), ${bdC.nState} LATCHes`);

// Starting board and the reference run.
const start = board(W, H, [[PATTERNS.glider, 1, 1], [PATTERNS.lwss, 3, 9], [PATTERNS.blinker, 11, 3], [PATTERNS.toad, 9, 12], [PATTERNS.glider, 9, 6]].filter(([, x, y]) => x < W && y < H));
const gens = [start];
for (let g = 0; g < BEATS + MORE; g++) gens.push(lifeStep(gens.at(-1), W, H));

// 3. Baseline: one generation evaluated directly on-chain. On real TapeOut that is step() itself.
let directGas1, directSource, stepChecks = null;
const hasStep = await circuits.step.estimateGas(boardId, bytesToHex(pack(start)), '0x').then(Number).catch(() => 0);
if (hasStep) {
  directGas1 = hasStep;
  directSource = "TapeOut's own step()";
  // and our evaluator against TapeOut's, generation by generation
  let st = start, agree = 0;
  for (let g = 0; g < 3; g++) {
    const [ns] = await circuits.step(boardId, bytesToHex(pack(st)), '0x');
    const [mine] = beat(bdC, st, []);
    if (bytesToHex(pack(mine)) === ns.toLowerCase()) agree++;
    st = mine;
  }
  stepChecks = { generations: 3, agree };
  say(`TapeOut step() vs our evaluator: ${agree}/3 generations identical`);
} else {
  const direct = await deploy('DirectEval');
  directGas1 = Number((await (await direct.run(cpuAddr, boardId, bytesToHex(pack(start)), 1, { gasLimit: FORK ? 200_000_000 : 1_000_000_000 })).wait()).gasUsed);
  directSource = 'our reference TAP-02 evaluator (contracts/DirectEval.sol)';
}
const perGen = directGas1;
say(`direct evaluation, ${directSource}: ${directGas1.toLocaleString()} gas per generation; about ${(perGen * BEATS).toLocaleString()} for ${BEATS}\n`);

const oc = await deploy('Overclock', BOND, WINDOW, factoryAddr, await deployer.getAddress(), FEE_BPS);
const ocAddr = await oc.getAddress();

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

// 4. Keep the machine running: the board circuit's own account continues from the final state.
const openerAddr = realTapeOut ? XLAYER.opener : await (await deploy('OpenerLocal', factoryAddr)).getAddress();
say(`\nround 3: the board circuit's own wallet pays for ${MORE} more generations`);
const opener = new Contract(openerAddr, OPENER_ABI, deployer);
note(`open circuit #${boardId}'s ERC-6551 account`, await (await opener.open(cpuAddr, boardId, { value: await opener.FEE() })).wait());
const poster = await opener.accountOf(cpuAddr, boardId);
note('fund the circuit account with the job fee', await (await deployer.sendTransaction({ to: poster, value: FEE })).wait(), { account: poster });
const contData = oc.interface.encodeFunctionData('continueJob', [0, '0x', MORE, false]);
const contRc = await (await new Contract(poster, ACCOUNT_ABI, deployer).execute(ocAddr, FEE, contData, 0, { value: parseEther('0.002') })).wait();
record({ who: 'circuit', what: `circuit #${boardId}'s own account calls continueJob(0, ${MORE} generations)`, fn: 'continueJob', gas: Number(contRc.gasUsed), tx: contRc.hash });
const job1 = await oc.jobs(1);
if (job1.poster.toLowerCase() !== poster.toLowerCase()) throw new Error('job 1 was not posted by the circuit account');
await op.tick();
await watch.tick();
await provider.send('evm_increaseTime', [WINDOW + 1]);
await provider.send('evm_mine', []);
await op.tick();
const [, state2] = await oc.result(1);
const board2 = unpack(hexToBytes(state2), W * H);
const ok2 = board2.every((v, i) => v === gens[BEATS + MORE][i]);
say(`generation ${BEATS + MORE} from Overclock.result(1) matches plain-JS Life: ${ok2}`);

const gasOf = (fn, who) => log.filter((e) => e.fn === fn && (!who || e.who === who)).reduce((s, e) => s + e.gas, 0);
const disputeTx = log.filter((e) => e.gas && ['challenge', 'reveal', 'pick', 'resolveLeaf'].includes(e.fn));
const summary = {
  directPerGeneration: perGen,
  directOneGeneration: directGas1,
  directTotal: perGen * BEATS,
  claim: log.find((e) => e.fn === 'claim' && e.who === 'operator').gas,
  finalize: log.find((e) => e.fn === 'finalize').gas,
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
  mode: realTapeOut ? 'fork' : 'local', realTapeOut, chainId: Number(net.chainId), startBlock, more: MORE,
  addresses: { factory: factoryAddr, circuits: cpuAddr, transistors: await transistors.getAddress(), overclock: ocAddr, cellId, boardId, circuitAccount: poster },
  setup, stepChecks, directSource, continued: ok2,
  circuits: { cellGates: cellC.nGates, boardGates: bdC.nGates, latches: bdC.nState, refs: W * H, cellNetlistBytes: cell.netlist.length, boardNetlistBytes: bd.netlist.length },
  trace: { leaves: L.n, perGeneration: L.B, depth },
  lie, steps, gas: summary, matches: ok,
  generations: gens.slice(0, BEATS + 1).map((g) => bytesToHex(pack(g))),
  generationsMore: gens.slice(BEATS + 1).map((g) => bytesToHex(pack(g))),
  cheatFinal: bytesToHex(pack(cheatBoard)),
  log: log.map(({ events, ...e }) => e),
}, null, 1));
say(`\nwrote ${OUT}`);
process.exit(ok && ok2 ? 0 : 1);
