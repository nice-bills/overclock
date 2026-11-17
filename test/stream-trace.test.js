// The streaming trace engine against trace.js's Tree: same roots, nodes, proofs, leaves, results on
// random circuits; checkpoint reuse; and disputes on a local EVM (ganache) driven by the streamed trace.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, parseEther } from 'ethers';
import { load, pack, unpack, hexToBytes, bytesToHex } from '../src/tap02.js';
import { layout, traceJob, Tree } from '../src/trace.js';
import { depsOf, Bisector, revealNodes, span } from '../src/game.js';
import { Builder } from '../src/hdl.js';
import { Operator, Challenger } from '../src/agents.js';
import { cpuCircuit, toState, fibonacciMachine, cpuRun } from '../src/cpu4.js';
import { StreamTrace, buildTable } from '../src/stream-trace.js';
import { keccak_256 } from '@noble/hashes/sha3';

// ---------------------------------------------------------------- random circuits

const CPU = '0x00000000000000000000000000000000000000c1';
const rng = (seed) => () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff);

// A random circuit: NANDs, LATCHes (D wired to any signal), and REFs to a smaller random circuit.
function randomCircuit(r, depth, registry) {
  const nIn = 1 + (r() >> 4) % 4, b = new Builder(nIn);
  const sigs = [0, 1, ...b.in], pick = () => sigs[(r() >> 3) % sigs.length];
  const latches = [];
  const size = 4 + (r() >> 5) % 20;
  for (let i = 0; i < size; i++) {
    const k = (r() >> 2) % 8;
    if (k < 4) sigs.push(b.nand(pick(), pick()));
    else if (k < 6) { const q = b.latch(); latches.push(q); sigs.push(q); }
    else if (depth > 0 && registry.length) {
      const sub = registry[(r() >> 3) % registry.length];
      sigs.push(...b.ref(CPU, sub.id, sub.nOut, Array.from({ length: sub.nIn }, pick)));
    } else sigs.push(b.nand(pick(), pick()));
  }
  for (const q of latches) b.setLatch(q, pick());
  const outs = Array.from({ length: 1 + (r() >> 6) % 3 }, pick);
  const built = b.build(outs);
  const id = BigInt(registry.length + 1);
  const resolve = (cpu, i) => registry.find((x) => cpu === CPU && x.id === i)?.c ?? null;
  const c = load(built.netlist, built.nIn, built.nOut, resolve);
  registry.push({ id, c, nIn: built.nIn, nOut: built.nOut });
  return c;
}

function sameAsTree(c, opts, st, label) {
  const t = traceJob(c, opts);
  const tree = new Tree(t.leaves);
  assert.equal(st.n, t.n, label);
  assert.equal(st.depth, tree.depth, label);
  assert.equal(st.root, tree.root, `${label}: root`);
  assert.deepEqual(st.outputs, t.outputs, `${label}: outputs`);
  assert.deepEqual(st.newState, t.newState, `${label}: newState`);
  const r = rng(99);
  const spots = [0, 1, t.n - 1, t.n >> 1, ...Array.from({ length: 12 }, () => r() % t.n)];
  for (const pos of spots) {
    assert.equal(st.leaf(pos), t.leaves[pos], `${label}: leaf ${pos}`);
    assert.deepEqual(st.proof(pos), tree.proof(pos), `${label}: proof ${pos}`);
  }
  // nodes at every level, inside the trace, straddling its end, and in the padding
  for (let level = 0; level <= tree.depth; level++) {
    const w = 2 ** (tree.depth - level);
    for (const i of new Set([0, 1, w - 1, w >> 1, Math.floor((t.n - 1) / 2 ** level), Math.floor(t.n / 2 ** level), Math.floor(t.n / 2 ** level) + 1].filter((x) => x >= 0 && x < w))) {
      assert.equal(st.node(level, i), tree.node(level, i), `${label}: node ${level}:${i}`);
    }
  }
}

test('the 16-leaf table holds every pattern, left leaf in the low bit', () => {
  const table = buildTable();
  const leaf = (v) => keccak_256(new Uint8Array([v]));
  const pair = (l, r) => keccak_256(Uint8Array.from([...l, ...r]));
  const node = (bits) => (bits.length === 1 ? leaf(bits[0]) : pair(node(bits.slice(0, bits.length / 2)), node(bits.slice(bits.length / 2))));
  const r = rng(5);
  for (const p of [0, 1, 0xffff, 0x8000, 0x5555, ...Array.from({ length: 40 }, () => r() & 0xffff)]) {
    const bits = Array.from({ length: 16 }, (_, j) => (p >> j) & 1);
    assert.equal('0x' + Buffer.from(table.subarray(p * 32, p * 32 + 32)).toString('hex'), '0x' + Buffer.from(node(bits)).toString('hex'), `pattern ${p}`);
  }
});

test('roots, nodes, proofs and leaves match Tree on random circuits (threads, odd sizes, faults)', async () => {
  const r = rng(2024);
  for (let t = 0; t < 40; t++) {
    const registry = [];
    for (let i = 0; i < 3; i++) randomCircuit(r, 2, registry);
    const c = registry.at(-1).c;
    const L = layout(c, 1);
    const beats = 1 + (r() >> 3) % Math.max(1, Math.floor(400 / L.B));
    const perBeat = t % 3 === 0;
    const bit = () => (r() >> 5) & 1;
    const inputs = Array.from({ length: perBeat ? beats * c.nIn : c.nIn }, bit);
    const state = Array.from({ length: c.nState }, bit);
    const n = beats * L.B;
    const fault = t % 2 ? Math.floor((r() >> 2) % n) : -1;
    const chunkBits = 4 + (t % 5); // chunks of 16 .. 256 leaves, so several chunks and a partial last one
    const opts = { state, inputs, beats, perBeat, fault };
    const st = await StreamTrace.build(c, { ...opts, chunkBits, workers: t % 4 === 0 ? 2 : 0, taskChunks: 1 + (t % 3) });
    sameAsTree(c, opts, st, `circuit ${t} (n=${n}, chunkBits=${chunkBits}, fault=${fault})`);
  }
});

test('default 65,536-leaf chunks on a multi-chunk CPU job, threaded, match Tree', async () => {
  const built = cpuCircuit(), c = load(built.netlist, built.nIn, built.nOut);
  const state = toState(fibonacciMachine());
  for (const [beats, fault] of [[100, -1], [200, 3 * 1644 + 52], [333, 332 * 1644 + 1500]]) {
    const opts = { state, beats, fault };
    const st = await StreamTrace.build(c, { ...opts, workers: 3 });
    assert.ok(st.nChunks >= 3 || beats === 100);
    sameAsTree(c, opts, st, `cpu ${beats} beats`);
  }
});

test('a lone leaf and a single beat still agree with Tree', async () => {
  const b = new Builder(1);
  const nl = b.build([b.not(b.in[0])]);
  const c = load(nl.netlist, nl.nIn, nl.nOut);
  for (const beats of [1, 2, 3, 7]) {
    const opts = { inputs: [1], beats };
    sameAsTree(c, opts, await StreamTrace.build(c, { ...opts, workers: 0 }), `tiny ${beats}`);
  }
});

test('checkpoints on disk are reused, and any node is recomputed from them', async () => {
  const built = cpuCircuit(), c = load(built.netlist, built.nIn, built.nOut);
  const dir = mkdtempSync(join(tmpdir(), 'oc-stream-'));
  try {
    const opts = { state: toState(fibonacciMachine()), beats: 150, workers: 2, dir };
    const first = await StreamTrace.build(c, opts);
    assert.ok(!first.resumed && existsSync(join(first.dir, 'meta.json')));
    const again = await StreamTrace.build(c, opts);
    assert.ok(again.resumed, 'second build loads the checkpoints instead of hashing');
    assert.equal(again.root, first.root);
    assert.deepEqual(again.proof(123_456), first.proof(123_456));
    assert.equal(again.leaf(200_000), first.leaf(200_000));
    // a different fault is a different trace and must not pick up the same checkpoints
    const lied = await StreamTrace.build(c, { ...opts, fault: 77_777 });
    assert.ok(!lied.resumed);
    assert.notEqual(lied.root, first.root);
    again.purge();
    assert.ok(!existsSync(again.dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- disputes on a local EVM

const art = (n) => JSON.parse(readFileSync(new URL(`../build/${n}.json`, import.meta.url)));
const BEATS = 40; // 65,760 leaves: two chunks, the second one nearly empty

async function chain(c, built) {
  const provider = new BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, miner: { blockGasLimit: 200_000_000 }, wallet: { totalAccounts: 4, defaultBalance: 1000 } }));
  const [poster, cheatS, honestS, watcherS] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  const deploy = async (name, ...args) => {
    const a = art(name);
    const ct = await new ContractFactory(a.abi, a.bytecode, poster).deploy(...args);
    await ct.waitForDeployment();
    return ct;
  };
  const proc = await deploy('MockProcessor');
  const oc = await deploy('Overclock', parseEther('1'), 3600, '0x0000000000000000000000000000000000000000', await poster.getAddress(), 0, 0, 0, '0x0000000000000000000000000000000000000000');
  await (await proc.store(bytesToHex(built.netlist), 0, built.nOut, c.nState, c.nGates)).wait();
  const m0 = fibonacciMachine();
  const post = async () => {
    const jobId = Number(await oc.jobCount());
    await (await oc.postJob(await proc.getAddress(), 1, '0x', bytesToHex(pack(toState(m0))), BEATS, false, { value: parseEther('0.1') })).wait();
    return jobId;
  };
  const expire = async () => { await provider.send('evm_increaseTime', [3601]); await provider.send('evm_mine', []); };
  return { provider, oc, cheatS, honestS, watcherS, post, expire, m0 };
}

test('cheat caught at the corrupted leaf and the honest result finalizes, all parties on the streamed trace', async () => {
  const built = cpuCircuit(), c = load(built.netlist, built.nIn, built.nOut);
  const { oc, cheatS, honestS, watcherS, post, expire, m0 } = await chain(c, built);
  const dir = mkdtempSync(join(tmpdir(), 'oc-stream-e2e-'));
  const stream = { above: 0, dir, workers: 2 }; // stream every job, however small
  const L = layout(c, BEATS);
  try {
    // three lies: in the first beat, at a state leaf mid-job, and in the very last beat
    for (const lieLeaf of [built.signals.sum[0] + 3, 20 * L.B + L.F + 5, (BEATS - 1) * L.B + built.signals.sum[2]]) {
      const jobId = await post();
      let lied = false;
      const cheat = new Operator({ oc, signer: cheatS, name: 'cheat', stream, lie: () => (lied ? null : ((lied = true), lieLeaf)) });
      const op = new Operator({ oc, signer: honestS, name: 'operator', stream });
      const log = [];
      const watch = new Challenger({ oc, signer: watcherS, name: 'watcher', stream, log: (e) => log.push(e) });
      cheat.only = op.only = watch.only = new Set([jobId]);
      await cheat.tick();
      for (let i = 0; i < 120 && !log.some((e) => e.fn === 'resolveLeaf'); i++) {
        await watch.tick();
        await cheat.tick();
      }
      assert.equal(log.find((e) => e.leaf !== undefined).leaf, lieLeaf, 'the dispute lands on the corrupted leaf');
      assert.equal((await oc.games((await oc.gameCount()) - 1n)).level, 255n, 'game closed');
      await op.tick(); // the slashed claim is gone: the honest operator claims now
      await expire();
      await op.tick();
      const [, st] = await oc.result(jobId);
      assert.deepEqual(unpack(hexToBytes(st), c.nState), toState(cpuRun(m0, BEATS)));
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an honest streamed claim survives a challenge from a griefer who bisects against a doctored trace', async () => {
  const built = cpuCircuit(), c = load(built.netlist, built.nIn, built.nOut);
  const { oc, honestS, watcherS, post, m0 } = await chain(c, built);
  const dir = mkdtempSync(join(tmpdir(), 'oc-stream-e2e-'));
  try {
    const jobId = await post();
    const op = new Operator({ oc, signer: honestS, name: 'operator', stream: { above: 0, dir, workers: 2 } });
    op.only = new Set([jobId]);
    await op.tick();
    const claimed = await StreamTrace.build(c, { state: toState(m0), beats: BEATS, workers: 2, dir });
    assert.equal((await oc.jobs(jobId)).traceRoot, claimed.root, 'the operator claimed the streamed root');
    const fakeLeaf = 25_000;
    const fake = await StreamTrace.build(c, { state: toState(m0), beats: BEATS, fault: fakeLeaf, workers: 2 });
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
    assert.equal(index, fakeLeaf);
    const deps = depsOf(c, index, BEATS).map((pos) => ({ pos, bit: fake.leaf(pos), siblings: bis.siblings(pos, index) }));
    const rc = await (await oc.connect(watcherS).resolveLeaf(gameId, deps)).wait();
    const ev = rc.logs.map((l) => oc.interface.parseLog(l)).find((e) => e?.name === 'Resolved').args;
    assert.equal(ev.winner, await honestS.getAddress(), 'the honest claimant wins');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
