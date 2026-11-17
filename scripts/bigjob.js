// A billion-step job on one machine, end to end on a local EVM (ganache), every party streaming.
//
//   node scripts/compile.js && node scripts/bigjob.js [--steps 1000000000] [--workers N] [--dir DIR]
//                                                      [--scenario lie|honest|both] [--keep]
//
// The job is the 4-bit CPU (src/cpu4.js) running its Fibonacci program, as many beats as it takes
// to pass --steps trace leaves (a step is one leaf: one wire value in one beat).
//
//   lie:    a cheat claims a result with one corrupted gate deep in the job. The watcher re-runs the
//           job, sees the root differ, descends the 30 levels (16 ways at a time) to the leaf and proves it with resolveLeaf.
//           Then an honest operator claims the same job, the window passes, and it finalizes to the
//           result the reference emulator gives.
//   honest: an honest claim is challenged by a griefer who bisects against a doctored trace, and wins.
//
// Nothing here touches a real network and no key is used: ganache's throwaway accounts only.

import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir, availableParallelism } from 'node:os';
import { join } from 'node:path';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, parseEther } from 'ethers';
import { load, pack, unpack, hexToBytes, bytesToHex } from '../src/tap02.js';
import { layout } from '../src/trace.js';
import { depsOf, Bisector, revealNodes, span } from '../src/game.js';
import { Operator, Challenger } from '../src/agents.js';
import { artifact } from '../src/chain.js';
import { cpuCircuit, toState, fibonacciMachine, cpuRun } from '../src/cpu4.js';
import { StreamTrace } from '../src/stream-trace.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const STEPS = Number(arg('steps', 1_000_000_000));
const WORKERS = Number(arg('workers', availableParallelism()));
const SCENARIO = arg('scenario', 'both');
const KEEP = process.argv.includes('--keep');
const dir = arg('dir', null) ?? mkdtempSync(join(tmpdir(), 'overclock-bigjob-'));
const T0 = Date.now();
const rss = () => Math.round(process.resourceUsage().maxRSS / 1024);
const say = (s) => console.log(`[${((Date.now() - T0) / 1000).toFixed(1).padStart(7)}s ${String(rss()).padStart(5)}MB] ${s}`);
const summary = { stages: {} };
const stage = async (name, fn) => { const t = Date.now(); const r = await fn(); summary.stages[name] = Date.now() - t; say(`${name}: ${((Date.now() - t) / 1000).toFixed(1)} s`); return r; };

const built = cpuCircuit();
const c = load(built.netlist, built.nIn, built.nOut);
const L1 = layout(c, 1);
const BEATS = Math.ceil(STEPS / L1.B);
const L = layout(c, BEATS);
const m0 = fibonacciMachine();
say(`job: ${BEATS.toLocaleString()} beats x ${L1.B} leaves = ${L.n.toLocaleString()} steps, ${WORKERS} workers`);

const provider = new BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, miner: { blockGasLimit: 200_000_000 }, wallet: { totalAccounts: 4, defaultBalance: 1000 } }));
const [poster, cheatS, honestS, watcherS] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
const deploy = async (name, ...args) => {
  const a = artifact(name);
  const ct = await new ContractFactory(a.abi, a.bytecode, poster).deploy(...args);
  await ct.waitForDeployment();
  return ct;
};
const proc = await deploy('MockProcessor');
const oc = await deploy('Overclock', parseEther('1'), 3600, '0x0000000000000000000000000000000000000000', await poster.getAddress(), 0, 0, 0, '0x0000000000000000000000000000000000000000');
await (await proc.store(bytesToHex(built.netlist), 0, built.nOut, c.nState, c.nGates)).wait();
const post = async () => {
  const jobId = Number(await oc.jobCount());
  await (await oc.postJob(await proc.getAddress(), 1, '0x', bytesToHex(pack(toState(m0))), BEATS, false, { value: parseEther('0.1') })).wait();
  return jobId;
};
const expire = async () => { await provider.send('evm_increaseTime', [3601]); await provider.send('evm_mine', []); };
const stream = { above: 0, dir, workers: WORKERS };
const log = (e) => {
  if (e.what?.startsWith('computed')) say(`${e.who}: ${e.what} in ${(e.ms / 1000).toFixed(1)} s`);
  else if (e.fn) say(`${e.who}: ${e.what}${e.gas ? ` (${e.gas.toLocaleString()} gas)` : ''}`);
  else say(`${e.who}: ${e.what}`);
};

try {
  if (SCENARIO === 'lie' || SCENARIO === 'both') {
    const jobId = await post();
    const lieLeaf = Math.floor(BEATS * 0.37) * L.B + built.signals.sum[0];
    say(`scenario lie: job ${jobId}, the cheat corrupts leaf ${lieLeaf.toLocaleString()} (beat ${Math.floor(lieLeaf / L.B).toLocaleString()})`);
    let lied = false;
    const cheat = new Operator({ oc, signer: cheatS, name: 'cheat', stream, log, lie: () => (lied ? null : ((lied = true), lieLeaf)) });
    const op = new Operator({ oc, signer: honestS, name: 'operator', stream, log });
    const watch = new Challenger({ oc, signer: watcherS, name: 'watcher', stream, log });
    cheat.only = op.only = watch.only = new Set([jobId]);
    const events = [];
    watch.log = (e) => { events.push(e); log(e); };
    await stage('cheat claims (streams the doctored trace)', () => cheat.tick());
    await stage('watcher re-runs, challenges, bisects and proves the leaf', async () => {
      for (let i = 0; i < 400 && !events.some((e) => e.fn === 'resolveLeaf'); i++) {
        await watch.tick();
        await cheat.tick();
      }
    });
    const hit = events.find((e) => e.leaf !== undefined)?.leaf;
    if (hit !== lieLeaf) throw new Error(`the dispute landed on ${hit}, not ${lieLeaf}`);
    if ((await oc.games((await oc.gameCount()) - 1n)).level !== 255n) throw new Error('game not closed');
    summary.lieLeaf = lieLeaf;
    say(`the dispute landed on leaf ${hit.toLocaleString()}: resolveLeaf slashed the cheat`);
    await stage('honest operator claims (checkpoints reused from the watcher)', () => op.tick());
    await expire();
    await op.tick();
    const [outs, st] = await oc.result(jobId);
    const ref = toState(cpuRun(m0, BEATS));
    if (JSON.stringify(unpack(hexToBytes(st), c.nState)) !== JSON.stringify(ref)) throw new Error('finalized state differs from the reference emulator');
    say(`finalized: final state matches the reference emulator after ${BEATS.toLocaleString()} beats`);
  }

  if (SCENARIO === 'honest' || SCENARIO === 'both') {
    const jobId = await post();
    say(`scenario honest: job ${jobId}`);
    const op = new Operator({ oc, signer: honestS, name: 'operator', stream, log });
    op.only = new Set([jobId]);
    await stage('honest operator claims', () => op.tick());
    const claimed = await StreamTrace.build(c, { state: toState(m0), beats: BEATS, workers: WORKERS, dir });
    if ((await oc.jobs(jobId)).traceRoot !== claimed.root) throw new Error('claimed root differs from the streamed root');
    const fakeLeaf = Math.floor(BEATS * 0.81) * L.B + 100;
    const fake = await stage('griefer builds a doctored trace', () => StreamTrace.build(c, { state: toState(m0), beats: BEATS, fault: fakeLeaf, workers: WORKERS, dir }));
    await stage('griefer challenges, bisects and loses', async () => {
      const rc0 = await (await oc.connect(watcherS).challenge(jobId, { value: await oc.bondFor(jobId) })).wait();
      const gameId = rc0.logs.map((l) => oc.interface.parseLog(l)).find((e) => e?.name === 'Challenged').args.gameId;
      const bis = new Bisector(fake);
      let level = claimed.depth, index = 0;
      while (level > 0) {
        await (await oc.connect(honestS).reveal16(gameId, revealNodes(claimed, level, index))).wait();
        const which = bis.choose(level, index, [...(await oc.pending(gameId))]);
        await (await oc.connect(watcherS).pick16(gameId, which)).wait();
        index = index * 2 ** span(level) + which;
        level -= span(level);
      }
      if (index !== fakeLeaf) throw new Error(`bisection landed on ${index}, not ${fakeLeaf}`);
      const deps = depsOf(c, index, BEATS).map((pos) => ({ pos, bit: fake.leaf(pos), siblings: bis.siblings(pos, index) }));
      const rc = await (await oc.connect(watcherS).resolveLeaf(gameId, deps)).wait();
      const ev = rc.logs.map((l) => oc.interface.parseLog(l)).find((e) => e?.name === 'Resolved').args;
      if (ev.winner !== (await honestS.getAddress())) throw new Error('the griefer won');
      say(`bisected to leaf ${index.toLocaleString()}: the honest claimant won (${ev.reason})`);
    });
    await expire();
    await op.tick();
    const [, st] = await oc.result(jobId);
    if (JSON.stringify(unpack(hexToBytes(st), c.nState)) !== JSON.stringify(toState(cpuRun(m0, BEATS)))) throw new Error('finalized state differs from the reference emulator');
    say('finalized after the dispute: the honest result stands');
  }
  Object.assign(summary, { steps: L.n, beats: BEATS, workers: WORKERS, wallSeconds: (Date.now() - T0) / 1000, peakRssMB: rss() });
  say(`done. ${L.n.toLocaleString()} steps, wall ${summary.wallSeconds.toFixed(1)} s, peak RSS ${summary.peakRssMB} MB (all threads)`);
  console.log(JSON.stringify(summary));
} finally {
  if (!KEEP) rmSync(dir, { recursive: true, force: true });
}
process.exit(0);
