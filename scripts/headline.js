// The pitch's two headline demos, end to end against the real TapeOut contracts.
//
//   node scripts/headline.js --machine cpu    --fork http://127.0.0.1:8545
//   node scripts/headline.js --machine digits --fork http://127.0.0.1:8545
//   PRIVATE_KEY=0x... node scripts/headline.js --machine digits --live https://rpc.xlayer.tech
//
// cpu:    our 4-bit CPU (src/cpu4.js), taped out as one circuit, runs an 8-bit Fibonacci program for
//         10,000 beats as a single Overclock job.
// digits: AlephTape's digit-recognition net, the 161,080-gate circuit #11 already live on their
//         processor, classifies an 8x8 drawing. Nothing new is taped out: Overclock runs a circuit
//         another team published.
//
// Both: a cheat claims a wrong result with one corrupted NAND; the watcher re-runs the job,
// bisects the trace to that gate and proves it wrong in one transaction, taking the cheat's bond.
// An honest operator then claims, the window passes, and the result finalizes. The gas is compared
// with running the same job directly through TapeOut's own step() or eval().
//
// --fork expects `npm run fork` (a local fork of X Layer mainnet). By default it uses the Overclock
// contract already deployed on mainnet (deployments/196.json), as it exists on the fork.
// The direct eval of the digit net is too big for an X Layer block; scripts/measure-eval.js measures it.

import { JsonRpcProvider, ContractFactory, Contract, Wallet, parseEther, formatEther, keccak256, concat, toUtf8Bytes } from 'ethers';
import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { load, pack, unpack, bytesToHex, hexToBytes, beat } from '../src/tap02.js';
import { layout, traceJob, flatSize } from '../src/trace.js';
import { depsOf } from '../src/game.js';
import { loadCircuit, artifact } from '../src/chain.js';
import { Operator, Challenger } from '../src/agents.js';
import { cpuCircuit, toState, fromState, cpuRun, fibonacciMachine, FIBONACCI, disassemble } from '../src/cpu4.js';
import { DIGITS, DIGIT_NET, scores, argmax, drawing } from '../src/digits.js';
import { XLAYER, mint, burnCost, tapeout, CIRCUITS_FULL_ABI, TRANSISTORS_ABI, FACTORY_ABI } from '../src/tapeout.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const MACHINE = arg('machine', 'cpu');
const LIVE = arg('live', null);
const RPC = LIVE ?? arg('fork', 'http://127.0.0.1:8545');
const MODE = LIVE ? 'live' : 'fork';
const OUT = arg('out', `web/${MACHINE}-${MODE}-run.json`);
const FEE = parseEther(arg('fee', '0.0001'));
const BEATS = Number(arg('beats', MACHINE === 'cpu' ? 10_000 : 1));
// OKspace, an open processor anyone can mint transistors for: the Life demo taped out there too
const PROCESSOR = arg('cpu', '0xb00f10bb4b2f32c561bf90e205e543d0a2395971');

const say = (s) => console.log(s);
const log = [];
const record = (e) => {
  log.push(e);
  say(`  ${e.who.padEnd(10)} ${e.what}${e.gas ? `  (${e.gas.toLocaleString()} gas)` : ''}${e.ms ? `  (${e.ms} ms)` : ''}`);
};
const setup = [];
const note = (what, rc, extra = {}) => {
  setup.push({ what, gas: Number(rc.gasUsed), tx: rc.hash, ...extra });
  say(`  setup      ${what}  (${Number(rc.gasUsed).toLocaleString()} gas)`);
};

const provider = new JsonRpcProvider(RPC, undefined, { polling: true, pollingInterval: LIVE ? 1000 : 250, cacheTimeout: -1 });
const net = await provider.getNetwork();
if (Number(net.chainId) !== 196) throw new Error(`expected X Layer (196), got chain ${net.chainId}`);
let deployer, honest, cheat, watcher;
if (LIVE) {
  deployer = new Wallet(process.env.PRIVATE_KEY, provider);
  // Same helper keys as the Life demo. To keep the bonds in flight low, the watcher that catches
  // the cheat is also the operator that then claims honestly.
  [cheat, watcher] = ['cheat', 'watcher'].map((k) => new Wallet(keccak256(concat([deployer.privateKey, toUtf8Bytes(`overclock-demo:${k}`)])), provider));
  honest = watcher;
} else {
  [deployer, honest, cheat, watcher] = [0, 1, 2, 3].map((i) => new Wallet(keccak256(toUtf8Bytes(`overclock-fork:${i}`)), provider));
  for (const w of [deployer, honest, cheat, watcher]) await provider.send('hardhat_setBalance', [w.address, '0x3635c9adc5dea00000']);
}
const settle = async (rc) => {
  if (!LIVE) return;
  while ((await provider.getBlockNumber()) < rc.blockNumber + 1) await new Promise((res) => setTimeout(res, 500));
};
const startBlock = await provider.getBlockNumber();
const balance0 = LIVE ? await provider.getBalance(deployer.address) : null;

// Overclock: the mainnet deployment unless --overclock names another (or --deploy asks for a new one).
let oc;
if (arg('deploy', null) !== null) {
  const a = artifact('Overclock');
  oc = await new ContractFactory(a.abi, a.bytecode, deployer).deploy(parseEther('1'), 3600, XLAYER.factory, deployer.address, 200);
  await oc.waitForDeployment();
  note('deploy Overclock', await oc.deploymentTransaction().wait());
} else {
  const addr = arg('overclock', XLAYER.overclock);
  if ((await provider.getCode(addr)) === '0x') throw new Error(`no Overclock at ${addr}`);
  oc = new Contract(addr, artifact('Overclock').abi, deployer);
}
const ocAddr = await oc.getAddress();
const BOND = await oc.bond(), WINDOW = Number(await oc.window());
say(`\nOverclock headline demo: ${MACHINE}, chain ${net.chainId} at block ${startBlock} (${MODE})`);
say(`Overclock ${ocAddr}: bond ${formatEther(BOND)} OKB, window ${WINDOW} s\n`);

if (LIVE) {
  // Bond plus gas: about 2.5M for the cheat's reveals, 3M for the watcher's dispute and claim.
  const { gasPrice } = await provider.getFeeData();
  for (const [w, gas, name] of [[cheat, 2_500_000n, 'cheat'], [watcher, 4_000_000n, 'watcher']]) {
    const need = BOND + gas * gasPrice * 2n, have = await provider.getBalance(w.address);
    if (have < need) note(`fund ${name} wallet`, await (await deployer.sendTransaction({ to: w.address, value: need - have })).wait(), { account: w.address });
  }
}

const passWindow = async (from) => {
  if (!LIVE) { await provider.send('evm_increaseTime', [WINDOW + 1]); await provider.send('evm_mine', []); return; }
  say(`  waiting ${WINDOW} s for the challenge window to close`);
  for (;;) {
    const ts = Number((await provider.getBlock('latest')).timestamp);
    if (ts >= from + WINDOW) break;
    await new Promise((res) => setTimeout(res, Math.min(30_000, (from + WINDOW - ts) * 1000 + 2000)));
  }
};

// ------------------------------------------------------------------ the machine

let cpuAddr, circuitId, c, jobInputs, jobState, expect, describe, pickLie, direct, checks = {}, machine = {};

if (MACHINE === 'cpu') {
  const circuits = new Contract(PROCESSOR, CIRCUITS_FULL_ABI, deployer);
  if (!(await new Contract(XLAYER.factory, FACTORY_ABI, provider).isCPU(PROCESSOR))) throw new Error(`${PROCESSOR} is not a TapeOut processor`);
  const transistors = new Contract(await circuits.transistors(), TRANSISTORS_ABI, deployer);
  const built = cpuCircuit();
  const cost = burnCost(built.netlist, 0);
  cpuAddr = PROCESSOR.toLowerCase();
  if (arg('circuit-id', null)) {
    circuitId = BigInt(arg('circuit-id'));
    say(`using circuit #${circuitId} taped out earlier`);
  } else {
    const have0 = await transistors.balanceOf(deployer.address, 0), have1 = await transistors.balanceOf(deployer.address, 1);
    if (have0 < cost.nand) note(`mint ${cost.nand - Number(have0)} NAND`, await mint(transistors, 0, cost.nand - Number(have0)));
    if (have1 < cost.latch) note(`mint ${cost.latch - Number(have1)} LATCH`, await mint(transistors, 1, cost.latch - Number(have1)));
    const t = await tapeout(circuits, built);
    circuitId = t.id;
    note(`tapeout the 4-bit CPU as circuit #${t.id}`, t.receipt, { circuit: Number(t.id), burned: cost, netlistBytes: built.netlist.length });
    if (LIVE) await settle(t.receipt);
  }
  c = load(built.netlist, built.nIn, built.nOut);
  const info = await circuits.circuitInfo(circuitId);
  if ((await circuits.netlist(circuitId)).toLowerCase() !== bytesToHex(built.netlist) || Number(info.gateCount) !== c.nGates || Number(info.nState) !== c.nState) throw new Error('TapeOut disagrees about the CPU circuit');
  say(`4-bit CPU: ${c.nGates.toLocaleString()} gates (${cost.nand} NAND, ${cost.latch} LATCH), ${c.nState} state bits; TapeOut's circuitInfo agrees`);

  const m0 = fibonacciMachine();
  jobInputs = '0x';
  jobState = bytesToHex(pack(toState(m0)));
  const ref = cpuRun(m0, BEATS);
  expect = toState(ref);
  machine = { program: FIBONACCI, rom: m0.rom.map(disassemble), ramIn: m0.ram, final: { pc: ref.pc, a: ref.a, c: ref.c, out: ref.out, ram: ref.ram }, fibA: ref.ram[0] | (ref.ram[1] << 4), fibB: ref.ram[2] | (ref.ram[3] << 4), passes: BEATS / 16 };
  describe = (st) => { const m = fromState(st); return `a = ${m.ram[0] | (m.ram[1] << 4)}, b = ${m.ram[2] | (m.ram[3] << 4)}, OUT = ${m.out}, PC = ${m.pc}`; };

  // TapeOut's step() against our evaluator, instruction by instruction, and its gas per beat.
  let st = toState(m0), agree = 0;
  const N = Number(arg('step-checks', 32));
  for (let i = 0; i < N; i++) {
    const [ns] = await circuits.step(circuitId, bytesToHex(pack(st)), '0x');
    const [mine] = beat(c, st, []);
    if (ns.toLowerCase() === bytesToHex(pack(mine))) agree++;
    st = mine;
  }
  checks.stepAgree = { beats: N, agree };
  say(`TapeOut step() vs our evaluator: ${agree}/${N} instructions identical`);
  const perBeat = Number(await circuits.step.estimateGas(circuitId, jobState, '0x'));
  direct = { source: "TapeOut's step(), one call per beat", perBeat, total: perBeat * BEATS };

  // The cheat flips the adder's low sum bit on one ADD, about 60% of the way in.
  pickLie = (L) => {
    const pass = Math.floor((BEATS / 16) * 0.6);
    const k = pass * 16 + 1; // instruction 1 of the loop is ADD 2
    return { beat: k, leaf: k * L.B + built.signals.sum[0], what: `the adder's low sum bit in instruction ${k + 1} (ADD, Fibonacci pass ${pass + 1})` };
  };
} else if (MACHINE === 'digits') {
  cpuAddr = DIGIT_NET.processor.toLowerCase();
  circuitId = DIGIT_NET.id;
  const circuits = new Contract(cpuAddr, CIRCUITS_FULL_ABI, provider);
  c = await loadCircuit(provider, cpuAddr, circuitId);
  const info = await circuits.circuitInfo(circuitId);
  if (Number(info.gateCount) !== c.nGates) throw new Error('TapeOut disagrees about the digit net');
  say(`digit net: AlephTape's circuit #${circuitId} on ${DIGIT_NET.processor}, ${c.nGates.toLocaleString()} gates; TapeOut's circuitInfo agrees`);
  const digit = Number(arg('digit', 7));
  const img = DIGITS[digit];
  jobInputs = img;
  jobState = '0x';
  const [, y] = beat(c, [], unpack(hexToBytes(img), 64));
  expect = y;
  if (argmax(scores(y)) !== digit) throw new Error(`the net reads the drawing of ${digit} as ${argmax(scores(y))}`);
  say(drawing(img));
  say(`the drawing is a ${digit}; the net's scores: ${scores(y).join(', ')}`);
  machine = { digit, image: img, scores: scores(y), read: argmax(scores(y)) };
  describe = (outs) => `reads it as ${argmax(scores(outs))} (scores ${scores(outs).join(', ')})`;

  // Our evaluator against AlephTape's ZK-proven result for their own test image (a 0).
  const [, y0] = beat(c, [], unpack(hexToBytes(DIGIT_NET.fixture.x), 64));
  checks.alephFixture = bytesToHex(pack(y0)) === DIGIT_NET.fixture.y;
  say(`our evaluator vs AlephTape's proven output for their test image: ${checks.alephFixture ? 'identical' : 'DIFFERENT'}`);
  // Direct eval does not fit in a block; scripts/measure-eval.js measured it on a raised-limit fork.
  direct = { source: "TapeOut's eval(), measured by scripts/measure-eval.js on a fork with the gas limit raised (AlephTape measured 396,410,201)", perBeat: DIGIT_NET.measuredEvalGas, total: DIGIT_NET.measuredEvalGas * BEATS };

  // The cheat corrupts one gate of the output layer so the claimed scores pick another digit.
  pickLie = (L) => {
    const outLayer = c.elements.at(-1); // the last REF: the 10 output neurons
    const end = L.F - outLayer.nOut, start = end - flatSize(outLayer.sub);
    let best = null;
    for (let q = end - 1; q > start && q > end - 3000; q--) {
      if (depsOf(c, q).length !== 2) continue; // NANDs only
      const t = traceJob(c, { inputs: unpack(hexToBytes(img), 64), fault: q });
      const s = scores(t.outputs), g = argmax(s);
      if (g !== digit && (!best || s[g] - s[digit] > best.margin)) best = { leaf: q, read: g, margin: s[g] - s[digit] };
    }
    if (!best) throw new Error('no single gate in the output layer changes the answer');
    return { beat: 0, leaf: best.leaf, what: `one NAND in the output layer, so the claimed scores read the ${digit} as a ${best.read}`, claimedDigit: best.read };
  };
} else throw new Error(`unknown machine ${MACHINE}`);

// ------------------------------------------------------------------ the job

const L = layout(c, BEATS);
const depth = Math.ceil(Math.log2(L.n));
say(`direct execution, ${direct.source}: ${direct.perBeat.toLocaleString()} gas per beat; ${direct.total.toLocaleString()} for the job (${(direct.total / 210e6).toFixed(1)} blocks of 210M)`);
say(`trace: ${L.n.toLocaleString()} leaves (${L.B.toLocaleString()} per beat), tree depth ${depth}\n`);

const job0 = Number(await oc.jobCount()), game0 = Number(await oc.gameCount());
const postRc = await (await oc.connect(deployer).postJob(cpuAddr, circuitId, jobInputs, jobState, BEATS, false, { value: FEE })).wait();
await settle(postRc);
record({ who: 'poster', what: `posts job ${job0}: ${BEATS.toLocaleString()} beat${BEATS > 1 ? 's' : ''} of circuit #${circuitId}, fee ${formatEther(FEE)}`, fn: 'postJob', gas: Number(postRc.gasUsed), tx: postRc.hash });

const lie = pickLie(L);
say(`the cheat corrupts ${lie.what}: trace leaf ${lie.leaf.toLocaleString()} of ${L.n.toLocaleString()}\n`);

let lied = false;
const shared = new Map();
const cheater = new Operator({ oc, signer: cheat, name: 'cheat', log: record, settle, circuits: shared, lie: () => (lied ? null : ((lied = true), lie.leaf)) });
const op = new Operator({ oc, signer: honest, name: 'operator', log: record, settle, circuits: shared });
const watch = new Challenger({ oc, signer: watcher, name: 'watcher', log: record, settle, circuits: shared });
for (const a of [cheater, op, watch]) a.only = new Set([job0]);

say('round 1: the cheat claims');
await cheater.tick();
const claimed = await oc.jobs(job0);
const cheatResult = MACHINE === 'cpu' ? unpack(hexToBytes(claimed.newState), c.nState) : unpack(hexToBytes(claimed.outputs), c.nOut);
say(`  the cheat's claim: ${describe(cheatResult)}`);
for (let i = 0; i < 4 * depth + 10; i++) {
  await watch.tick();
  await cheater.tick();
  if (Number(await oc.gameCount()) > game0 && Number((await oc.games(game0)).level) === 255) break;
}
const resolved = log.find((e) => e.fn === 'resolveLeaf');
if (!resolved) throw new Error('the dispute did not resolve');

say('\nround 2: an honest operator claims');
await op.tick();
await watch.tick();
await passWindow(Number((await oc.jobs(job0)).claimedAt));
await op.tick();
const [outs, finalState] = await oc.result(job0);
const got = MACHINE === 'cpu' ? unpack(hexToBytes(finalState), c.nState) : unpack(hexToBytes(outs), c.nOut);
const ok = got.every((v, i) => v === expect[i]);
say(`\nOverclock.result(${job0}): ${describe(got)}`);
say(`matches the plain-JS reference: ${ok}`);

const disputeTx = log.filter((e) => e.gas && ['challenge', 'reveal', 'pick', 'resolveLeaf'].includes(e.fn));
const gas = {
  post: Number(postRc.gasUsed),
  claim: log.find((e) => e.fn === 'claim' && e.who === 'operator').gas,
  finalize: log.find((e) => e.fn === 'finalize').gas,
  disputeTotal: disputeTx.reduce((s, e) => s + e.gas, 0),
  disputeTxs: disputeTx.length,
  disputeMaxTx: Math.max(...disputeTx.map((e) => e.gas)),
  resolveLeaf: resolved.gas,
  directPerBeat: direct.perBeat,
  directTotal: direct.total,
};
gas.honestPath = gas.post + gas.claim + gas.finalize;
gas.ratio = Math.round(gas.directTotal / gas.honestPath);
say(`gas: honest path ${gas.honestPath.toLocaleString()} (post + claim + finalize); whole dispute ${gas.disputeTotal.toLocaleString()} over ${gas.disputeTxs} transactions, largest ${gas.disputeMaxTx.toLocaleString()}`);
say(`     direct execution of the same job: ${gas.directTotal.toLocaleString()}, ${gas.ratio.toLocaleString()}x the honest path`);

const leafRow = log.find((e) => e.leaf !== undefined);
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify({
  machine: MACHINE, mode: MODE, chainId: Number(net.chainId), startBlock, beats: BEATS,
  bond: formatEther(BOND), window: WINDOW, fee: formatEther(FEE),
  addresses: { overclock: ocAddr, processor: cpuAddr, circuitId: Number(circuitId) },
  circuit: { gates: c.nGates, nIn: c.nIn, nOut: c.nOut, nState: c.nState },
  trace: { leaves: L.n, perBeat: L.B, depth },
  jobId: job0, gameId: game0, machineInfo: machine, checks, direct,
  lie: { ...lie, provedLeaf: leafRow?.leaf },
  cheatClaim: bytesToHex(pack(cheatResult)), result: bytesToHex(pack(got)), matches: ok,
  setup, gas,
  spent: LIVE ? formatEther(balance0 - (await provider.getBalance(deployer.address))) : null,
  log: log.map(({ events, ...e }) => e),
}, null, 1));
say(`\nwrote ${OUT}`);
if (LIVE) {
  const { gasPrice } = await provider.getFeeData();
  const cost = 21000n * gasPrice * 2n;
  for (const w of [cheat, watcher]) {
    const bal = await provider.getBalance(w.address);
    if (bal > cost) await (await w.sendTransaction({ to: deployer.address, value: bal - cost, gasLimit: 21000n, gasPrice: gasPrice * 2n })).wait();
  }
  say(`swept the helper wallets back; the deployer spent ${formatEther(balance0 - (await provider.getBalance(deployer.address)))} OKB in all`);
}
process.exit(ok ? 0 : 1);
