// Unit tests for the live conformance sweep (scripts/conformance.js): deterministic sampling,
// eligibility and ordering, netlist loading over a real local EVM, and the full comparison
// pipeline (waves, batching fallbacks, minimisation, checkpoint resume, write-up).
//
// MockProcessor has no eval/step of its own, so chain answers come from two independent oracles:
// a JS transliteration of DirectEval.sol's two-pass beat ("slowBeat", written from the Solidity,
// not from src/tap02.js, so agreement is a real cross-check), and the actual DirectEval contract
// deployed on ganache for nIn = 0 circuits. Batching paths use shim evalMany/stepMany because
// ganache has no Multicall3.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, id as keccakId } from 'ethers';
import { beat, load, pack, bytesToHex } from '../src/tap02.js';
import { Builder } from '../src/hdl.js';
import { artifact } from '../src/chain.js';
import {
  makeRng, circuitSeed, planSamplesFor, isEligible, orderRoundRobin, makePacer, NetlistReader,
  checkWave, minimiseMismatch, loadWave, writeCheckpoint, readCheckpoint, summarize,
  calldataFor, mismatchDoc, sweep,
} from '../scripts/conformance.js';

// ---------------------------------------------------------------- independent slowBeat oracle

const u24at = (d, off) => (d[off] << 16) | (d[off + 1] << 8) | d[off + 2];
const refAt = (d, off) => {
  let cpu = '0x';
  for (let i = 1; i <= 20; i++) cpu += d[off + i].toString(16).padStart(2, '0');
  let id = 0n;
  for (let i = 0; i < 8; i++) id = (id << 8n) | BigInt(d[off + 21 + i]);
  return { cpu, id, ni: d[off + 29], no: d[off + 30] };
};
const unpackBits = (hex, n) => {
  const d = hexToBytesLocal(hex);
  return Array.from({ length: n }, (_, i) => ((i >> 3) < d.length ? (d[i >> 3] >> (i & 7)) & 1 : 0));
};
const bytesHex = (d) => '0x' + [...d].map((x) => x.toString(16).padStart(2, '0')).join('');
const flipLastBit = (hex) => { const d = hexToBytesLocal(hex); d[d.length - 1] ^= 1; return bytesHex(d); };
const packHex = (bits) => {
  const out = new Uint8Array((bits.length + 7) >> 3);
  bits.forEach((v, i) => { if (v) out[i >> 3] |= 1 << (i & 7); });
  return bytesHex(out);
};
function hexToBytesLocal(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

// DirectEval.sol's beat: pass 1 fills signals (NAND/LATCH/REF, state read top-down), pass 2
// writes the LATCHes, outputs are the last nOut signals. REF recurses through the table.
function shimBeat(table, addr, id, state, ins) {
  const ent = table.get(`${String(addr).toLowerCase()}:${id}`);
  if (!ent) throw new Error(`slowBeat: unknown circuit ${addr}#${id}`);
  const d = ent.bytes;
  const a = [0, 1, ...ins];
  const ns = new Array(ent.nState).fill(0);
  let st = 0, off = 0;
  while (off < d.length) {
    const op = d[off];
    if (op === 0) { a.push(1 - (a[u24at(d, off + 1)] & a[u24at(d, off + 4)])); off += 7; }
    else if (op === 1) { a.push(state[st++]); off += 4; }
    else {
      const { cpu, id: sid, ni, no } = refAt(d, off);
      const sub = table.get(`${cpu}:${sid}`);
      const si = []; for (let k = 0; k < ni; k++) si.push(a[u24at(d, off + 31 + 3 * k)]);
      const ss = []; for (let k = 0; k < sub.nState; k++) ss.push(state[st + k]);
      const [subNs, subOuts] = shimBeat(table, cpu, sid, ss, si);
      for (let k = 0; k < subNs.length; k++) ns[st + k] = subNs[k];
      for (let k = 0; k < no; k++) a.push(subOuts[k]);
      st += sub.nState;
      off += 31 + 3 * ni;
    }
  }
  st = 0; off = 0;
  while (off < d.length) {
    const op = d[off];
    if (op === 0) off += 7;
    else if (op === 1) { ns[st++] = a[u24at(d, off + 1)]; off += 4; }
    else { const { cpu, id: sid, ni } = refAt(d, off); st += table.get(`${cpu}:${sid}`).nState; off += 31 + 3 * ni; }
  }
  return [ns, a.slice(a.length - ent.nOut)];
}

// The chain stand-in: eval/step (+ optional batch methods) computed by slowBeat. `fault` marks
// answers to corrupt (a bit flip in the last byte), `batch` controls the batch transport.
class ShimOracle {
  constructor(table, { batch = 'ok', failSlots = [0], fault = null } = {}) {
    this.table = table;
    this.batchMode = batch;
    this.failSlots = new Set(failSlots);
    this.fault = fault;
    this.stats = { evals: 0, steps: 0, evalBatches: 0, stepBatches: 0, batchSlots: 0, batchRetries: 0 };
  }
  _faulty(hex, addr, id, kind, state, inputs) {
    return this.fault?.(addr, id, kind, state, inputs) ? flipLastBit(hex) : hex;
  }
  async eval(addr, id, inputsHex) {
    this.stats.evals++;
    const ent = this.table.get(`${String(addr).toLowerCase()}:${id}`);
    const ins = unpackBits(inputsHex, ent?.nIn ?? 0);
    const [, outs] = shimBeat(this.table, addr, id, [], ins);
    return this._faulty(packHex(outs), addr, id, 'eval', [], ins);
  }
  async step(addr, id, stateHex, inputsHex) {
    this.stats.steps++;
    const ent = this.table.get(`${String(addr).toLowerCase()}:${id}`);
    const sb = unpackBits(stateHex, ent?.nState ?? 0);
    const ib = unpackBits(inputsHex, ent?.nIn ?? 0);
    const [ns, outs] = shimBeat(this.table, addr, id, sb, ib);
    return [packHex(ns), this._faulty(packHex(outs), addr, id, 'step', sb, ib)];
  }
  async evalMany(list) {
    this.stats.evalBatches++; this.stats.batchSlots += list.length;
    if (this.batchMode === 'throw') throw new Error('shim batch exploded');
    const out = [];
    for (let k = 0; k < list.length; k++) {
      const j = list[k];
      if (this.batchMode === 'failSlots' && this.failSlots.has(k)) { this.stats.batchRetries++; out.push({ ok: false, error: 'shim slot failed' }); continue; }
      out.push({ ok: true, hex: String(await this.eval(j.addr, j.id, j.inputsHex)).toLowerCase() });
    }
    return out;
  }
  async stepMany(list) {
    this.stats.stepBatches++; this.stats.batchSlots += list.length;
    if (this.batchMode === 'throw') throw new Error('shim batch exploded');
    const out = [];
    for (let k = 0; k < list.length; k++) {
      const j = list[k];
      if (this.batchMode === 'failSlots' && this.failSlots.has(k)) { this.stats.batchRetries++; out.push({ ok: false, error: 'shim slot failed' }); continue; }
      const [ns, outs] = await this.step(j.addr, j.id, j.stateHex, j.inputsHex);
      out.push({ ok: true, state: String(ns).toLowerCase(), outs: String(outs).toLowerCase() });
    }
    return out;
  }
}

// The real Solidity oracle: DirectEval.run(cpu, id, state, beats) is one beat with no inputs, so
// it only covers nIn = 0 circuits — which is all we feed it here. run() is a write method, so the
// return values come back through a simulated call (staticCall), not a mined transaction.
class DirectEvalOracle {
  constructor(de, cpuAddr) { this.de = de; this.cpu = cpuAddr; this.stats = { evals: 0, steps: 0 }; }
  async eval(addr, id, inputsHex) { this.stats.evals++; return (await this.de.run.staticCall(this.cpu, id, '0x', 1))[0]; }
  async step(addr, id, stateHex, inputsHex) { this.stats.steps++; const r = await this.de.run.staticCall(this.cpu, id, stateHex, 1); return [r[1], r[0]]; }
}

// ---------------------------------------------------------------- shared ganache fixture

const S = { info: {}, built: {} };
let provider, mock, de, mockAddr, mockLow, table, C;

async function deploy(name, signer, ...args) {
  const a = artifact(name);
  const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}
const infoFor = (c) => ({ nIn: c.nIn, nOut: c.nOut, nState: c.nState, gates: c.nGates });
const rowOf = (id) => ({ processor: mockAddr, id, ...S.info[id] });
const waveOf = (id, c, samples, seed = 0xC10C) => ({ row: { processor: mockAddr, id, ...infoFor(c) }, circuit: c, planned: planSamplesFor(c, samples, seed, mockAddr, id) });

before(async () => {
  provider = new BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, wallet: { totalAccounts: 2, defaultBalance: 1000 } }), undefined, { cacheTimeout: -1 });
  const [owner] = await Promise.all([0, 1].map((i) => provider.getSigner(i)));
  mock = await deploy('MockProcessor', owner);
  de = await deploy('DirectEval', owner);
  mockAddr = await mock.getAddress();
  mockLow = mockAddr.toLowerCase();

  // xor (stateless, nIn 2), toggle (nState 1, nIn 0), constant one (nIn 0), a REF of xor with a
  // third input, a stateful REF wrapper of toggle, and a 1-input latch (nIn 1, nState 1). REF
  // ids below assume the store order; nextId() is asserted to prove the layout.
  const bx = new Builder(2);
  S.built.xor = bx.build([bx.xor(bx.in[0], bx.in[1])]);
  const bt = new Builder(0);
  const q = bt.latch();
  bt.setLatch(q, bt.not(q));
  S.built.toggle = bt.build([q]);
  const b1 = new Builder(0);
  S.built.one = b1.build([b1.not(b1.zero)]);
  const br = new Builder(3);
  const r = br.ref(mockAddr, 1, 1, [br.in[0], br.in[1]]);
  S.built.ref = br.build([br.xor(r[0], br.in[2])]);
  const bs = new Builder(0);
  const t = bs.ref(mockAddr, 2, 1, []);
  const qs = bs.latch();
  bs.setLatch(qs, t[0]);
  S.built.refState = bs.build([t[0]]);
  const bl = new Builder(1);
  const ql = bl.latch();
  bl.setLatch(ql, bl.in[0]);
  S.built.latch = bl.build([ql]);

  const resolveLocal = (a, i) => {
    const k = `${String(a).toLowerCase()}:${BigInt(i)}`;
    if (k === `${mockLow}:1`) return C.xor;
    if (k === `${mockLow}:2`) return C.toggle;
    return null;
  };
  C = {
    xor: load(S.built.xor.netlist, 2, 1),
    toggle: load(S.built.toggle.netlist, 0, 1),
    one: load(S.built.one.netlist, 0, 1),
  };
  C.ref = load(S.built.ref.netlist, 3, 1, resolveLocal);
  C.refState = load(S.built.refState.netlist, 0, 1, resolveLocal);
  C.latch = load(S.built.latch.netlist, 1, 1);
  S.info = { 1: infoFor(C.xor), 2: infoFor(C.toggle), 3: infoFor(C.one), 4: infoFor(C.ref), 5: infoFor(C.refState), 6: infoFor(C.latch) };

  const store = async (built, info) => (await (await mock.store(built.netlist, info.nIn, info.nOut, info.nState, info.gates)).wait());
  await store(S.built.xor, S.info[1]);
  await store(S.built.toggle, S.info[2]);
  await store(S.built.one, S.info[3]);
  await store(S.built.ref, S.info[4]);
  await store(S.built.refState, S.info[5]);
  assert.equal(await mock.nextId(), 6n); // ids 1..5 as the REF records assume

  table = new Map([1, 2, 3, 4, 5, 6].map((id) => [`${mockLow}:${id}`, {
    bytes: S.built[id === 1 ? 'xor' : id === 2 ? 'toggle' : id === 3 ? 'one' : id === 4 ? 'ref' : id === 5 ? 'refState' : 'latch'].netlist,
    nIn: S.info[id].nIn, nOut: S.info[id].nOut, nState: S.info[id].nState,
  }]));

  // pin the built circuits' semantics once, so every later cross-check is meaningful
  // (toggle: out = current state, state flips each beat — the NOT-NOT buffer cancels the inversion)
  assert.deepEqual(beat(C.toggle, [0], []), [[1], [0]]);
  assert.deepEqual(beat(C.toggle, [1], []), [[0], [1]]);
  assert.deepEqual(beat(C.one, [], []), [[], [1]]);
  assert.deepEqual(beat(C.xor, [], [1, 0]), [[], [1]]);
});

// ---------------------------------------------------------------- sampling

test('mulberry32 is deterministic, seed-sensitive and balanced', () => {
  const seqA = Array.from({ length: 256 }, makeRng(42));
  assert.deepEqual(seqA, Array.from({ length: 256 }, makeRng(42)));
  assert.notDeepEqual(seqA, Array.from({ length: 256 }, makeRng(43)));
  const ones = Array.from({ length: 10_000 }, makeRng(7)).reduce((s, x) => s + x, 0);
  assert.ok(ones > 4400 && ones < 5600, `bit balance off: ${ones}/10000`);
});

test('circuitSeed is stable across address casing and id types, distinct per circuit', () => {
  assert.equal(circuitSeed(0xC10C, mockAddr, 1), circuitSeed(0xC10C, mockLow, '1'));
  assert.notEqual(circuitSeed(0xC10C, mockAddr, 1), circuitSeed(0xC10C, mockAddr, 2));
  assert.notEqual(circuitSeed(0xC10C, mockAddr, 1), circuitSeed(0xC10C + 1, mockAddr, 1));
});

test('planSamplesFor reproduces identical samples and records what beat() expects', () => {
  const p1 = planSamplesFor(C.xor, 4, 0xC10C, mockAddr, 1);
  assert.deepEqual(p1, planSamplesFor(C.xor, 4, 0xC10C, mockAddr, 1));
  assert.notDeepEqual(p1, planSamplesFor(C.xor, 4, 0xC10C + 1, mockAddr, 1));
  assert.equal(p1.length, 4);
  for (const pl of p1) {
    assert.equal(pl.inputs.length, 2);
    assert.equal(pl.state.length, 0);
    assert.equal(pl.inputsHex, bytesToHex(pack(pl.inputs)));
    assert.equal(pl.stateHex, '0x');
    const [, outs] = beat(C.xor, pl.state, pl.inputs);
    assert.equal(pl.expectedOuts, bytesToHex(pack(outs)));
  }
});

// ---------------------------------------------------------------- eligibility and ordering

test('isEligible skips only what cannot fit one eval/step call or cannot be evaluated', () => {
  assert.equal(isEligible({ nOut: 1, gates: 18_000, nState: 0, nIn: 2 }, 18_000), null);
  assert.equal(isEligible({ nOut: 1, gates: 18_001, nState: 0, nIn: 2 }, 18_000), 'more than 18000 gates');
  assert.equal(isEligible(null, 18_000), 'circuitInfo unavailable');
  assert.equal(isEligible({ nOut: 0, gates: 1, nState: 0, nIn: 2 }, 18_000), 'no outputs');
  assert.equal(isEligible({ nOut: 1, gates: 1, nState: 1 << 25, nIn: 2 }, 18_000), 'pins or state out of TAP-02 range');
  assert.equal(isEligible({ nOut: 1, gates: 1, nState: 0, nIn: (1 << 16) + 1 }, 18_000), 'pins or state out of TAP-02 range');
});

test('orderRoundRobin interleaves processors, ids ascending within each', () => {
  const rows = [
    { processor: '0xaaa', id: 2 }, { processor: '0xAAA', id: 1 }, { processor: '0xbbb', id: 1 },
    { processor: '0xccc', id: 3 }, { processor: '0xccc', id: 1 }, { processor: '0xccc', id: 2 },
  ];
  // grouping is case-insensitive, but rows keep their original casing
  assert.deepEqual(orderRoundRobin(rows).map((r) => `${r.processor}:${r.id}`), [
    '0xAAA:1', '0xbbb:1', '0xccc:1', '0xaaa:2', '0xccc:2', '0xccc:3',
  ]);
});

// ---------------------------------------------------------------- loading circuits over the local EVM

test('loadWave reads netlists (individual fallback on ganache), closes REFs and memoises sub-circuits', async () => {
  const rows = [1, 2, 3, 4, 5].map((id) => ({ processor: mockAddr, id }));
  const infoMap = new Map([[`${mockLow}:1`, S.info[1]]]); // only #1 known: the rest come from the chain
  const reader = new NetlistReader(provider, { pacer: makePacer(0) });
  const loaded = await loadWave(rows, reader, infoMap, new Map());
  assert.equal(loaded.length, 5);
  for (const l of loaded) assert.equal(l.error, undefined);
  const [lx, lt, lc, lr, ls] = loaded;
  assert.equal(lx.circuit.nIn, 2); assert.equal(lx.circuit.nGates, 4); assert.equal(lx.refs, 0); assert.equal(lx.gates, 4);
  assert.equal(lt.circuit.nState, 1); assert.equal(lt.gates, 4);
  assert.equal(lc.circuit.nIn, 0); assert.equal(lc.gates, 1);
  assert.equal(lr.refs, 1); assert.equal(lr.circuit.nGates, 8); assert.equal(lr.gates, 8);
  // top-level circuits are not cached, but REF targets are: the closure is structurally the same
  // circuit, loaded once for every parent that refs it
  assert.deepEqual(lr.circuit.elements[0].sub, lx.circuit);
  assert.equal(ls.refs, 1); assert.equal(ls.circuit.nState, 2); assert.equal(ls.circuit.elements[0].sub.nState, 1);
  assert.equal(infoMap.size, 5); // #2..#5 auto-fetched via circuitInfo
  assert.deepEqual(infoMap.get(`${mockLow}:4`), S.info[4]);
  assert.equal(reader.stats.netlistsRead, 5);
  assert.equal(reader.stats.individualFallbacks, 5); // no Multicall3 on ganache: all individual
  assert.ok(reader.stats.rpcCalls > 0);
});

// ---------------------------------------------------------------- the comparison pipeline

test('checkWave agrees with the slowBeat oracle: eval for stateless, step for stateful', async () => {
  const shim = new ShimOracle(table);
  const results = await checkWave([waveOf(1, C.xor, 4), waveOf(2, C.toggle, 4)], shim);
  assert.equal(results.length, 2);
  assert.deepEqual(results[0], { processor: mockAddr, id: 1, nIn: 2, nOut: 1, nState: 0, gates: 4, samples: 4, matches: 4 });
  assert.deepEqual(results[1], { processor: mockAddr, id: 2, nIn: 0, nOut: 1, nState: 1, gates: 4, samples: 4, matches: 4 });
  assert.equal(shim.stats.evals, 4);
  assert.equal(shim.stats.steps, 4);
  // mixed-case oracle answers are normalised before comparing
  const pl = planSamplesFor(C.xor, 1, 0xC10C, mockAddr, 1);
  const loud = { async eval() { return '0X' + pl[0].expectedOuts.slice(2).toUpperCase(); } };
  const r = await checkWave([{ row: { processor: mockAddr, id: 1, ...infoFor(C.xor) }, circuit: C.xor, planned: pl }], loud);
  assert.equal(r[0].matches, 1);
});

test('batch failures fall back per slot, and whole-batch failures fall back per call', async () => {
  const thrower = new ShimOracle(table, { batch: 'throw' });
  const r1 = await checkWave([waveOf(1, C.xor, 3)], thrower);
  assert.equal(r1[0].matches, 3);
  assert.equal(thrower.stats.evalBatches, 1);
  assert.equal(thrower.stats.evals, 3); // every slot re-run individually

  const slotter = new ShimOracle(table, { batch: 'failSlots', failSlots: [0] });
  const r2 = await checkWave([waveOf(1, C.xor, 3)], slotter);
  assert.equal(r2[0].matches, 3);
  assert.equal(slotter.stats.batchRetries, 1);
  assert.equal(slotter.stats.evals, 3); // 2 non-failed slots inside the batch + 1 individual re-check

  const slotStep = new ShimOracle(table, { batch: 'failSlots', failSlots: [1] });
  const r3 = await checkWave([waveOf(2, C.toggle, 2)], slotStep);
  assert.equal(r3[0].matches, 2);
  assert.equal(slotStep.stats.stepBatches, 1);
  assert.equal(slotStep.stats.steps, 2); // 1 non-failed slot inside the batch + 1 individual re-check
});

test('corrupted oracle answers are recorded as mismatches with full detail; errors keep sample/error', async () => {
  const faulty = new ShimOracle(table, { fault: (a, id, kind) => id === 1 && kind === 'eval' });
  const planned = planSamplesFor(C.xor, 3, 0xC10C, mockAddr, 1);
  const [r] = await checkWave([{ row: { processor: mockAddr, id: 1, ...infoFor(C.xor) }, circuit: C.xor, planned }], faulty);
  assert.equal(r.matches, 0);
  assert.equal(r.mismatches.length, 3);
  r.mismatches.forEach((m, i) => {
    assert.equal(m.sample, i);
    assert.equal(m.inputs, planned[i].inputsHex);
    assert.equal(m.expected, planned[i].expectedOuts);
    assert.equal(m.got, flipLastBit(m.expected));
  });

  const failing = { async eval() { throw new Error('boom'); }, async step() { throw new Error('kaboom'); } };
  const rs = await checkWave([waveOf(1, C.xor, 2), waveOf(2, C.toggle, 1)], failing);
  assert.deepEqual(rs[0].errors, [{ sample: 0, error: 'boom' }, { sample: 1, error: 'boom' }]);
  assert.deepEqual(rs[1].errors, [{ sample: 0, error: 'kaboom' }]);
  assert.equal(rs[0].matches, 0);
  assert.equal(rs[1].matches, 0);
});

test('DirectEval.sol (independent Solidity evaluator) agrees with beat() through checkWave', async () => {
  const oracle = new DirectEvalOracle(de, mockAddr);
  const wave = [
    { row: rowOf(3), circuit: C.one, planned: [{ inputs: [], state: [], inputsHex: '0x', stateHex: '0x', expectedOuts: '0x01', expectedState: '0x' }] },
    { row: rowOf(2), circuit: C.toggle, planned: [
      { inputs: [], state: [0], inputsHex: '0x', stateHex: '0x00', expectedOuts: '0x00', expectedState: '0x01' },
      { inputs: [], state: [1], inputsHex: '0x', stateHex: '0x01', expectedOuts: '0x01', expectedState: '0x00' },
    ] },
    { row: rowOf(5), circuit: C.refState, planned: planSamplesFor(C.refState, 3, 0xC10C, mockAddr, 5) },
  ];
  const results = await checkWave(wave, oracle);
  assert.deepEqual(results.map((r) => r.matches), [1, 2, 3]);
  for (const r of results) assert.equal(r.mismatches, undefined);
  assert.equal(oracle.stats.evals, 1);
  assert.equal(oracle.stats.steps, 5); // toggle 2 + stateful REF 3
});

test('minimiseMismatch drives the greedy zero-descent to a minimal failing input', async () => {
  // fault fires only when the third input bit is 1: bits 0 and 1 zero out, bit 2 must survive.
  // state is [] (as planSamples produces for stateless circuits) — minimise must treat that as
  // stateless and use eval, not step.
  const in2 = new ShimOracle(table, { fault: (a, id, kind, st, ins) => ins?.[2] === 1 });
  const m1 = await minimiseMismatch(C.ref, in2, { addr: mockAddr, id: 4, inputs: [1, 1, 1], state: [] });
  assert.deepEqual(m1.inputs, [0, 0, 1]);
  assert.equal(m1.attempts, 3);
  assert.equal(m1.state, null);

  // fault fires on input OR state: the input zeroes (failure survives), the state restores
  const either = new ShimOracle(table, { fault: (a, id, kind, st, ins) => ins?.[0] === 1 || st?.[0] === 1 });
  const m2 = await minimiseMismatch(C.latch, either, { addr: mockAddr, id: 6, inputs: [1], state: [1] });
  assert.deepEqual(m2.inputs, [0]);
  assert.deepEqual(m2.state, [1]);
  assert.equal(m2.attempts, 2);
});

// ---------------------------------------------------------------- sweep loop, checkpoint, write-up

test('writeCheckpoint is atomic and readCheckpoint tolerates missing files', () => {
  const dir = mkdtempSync(join(tmpdir(), 'conformance-test-'));
  const p = join(dir, 'cp.json');
  writeCheckpoint(p, { a: 1 });
  assert.deepEqual(readCheckpoint(p), { a: 1 });
  assert.equal(existsSync(`${p}.tmp`), false);
  assert.equal(readCheckpoint(join(dir, 'missing.json')), null);
  rmSync(dir, { recursive: true, force: true });
});

test('sweep resumes from prefilled results, honors the limit, flushes per wave and reports mismatches', async () => {
  const todo = [1, 2, 3, 4, 5].map((id) => rowOf(id));
  const infoMap = new Map([1, 2, 3, 4, 5].map((id) => [`${mockLow}:${id}`, S.info[id]]));
  const options = { samples: 2, wave: 2, seed: 0xC10C, chunk: 400, netlistBytes: 524_288, budgetGas: 40_000_000, maxGates: 18_000 };
  const results = [{ ...rowOf(1), samples: 0, matches: 0, errors: [{ sample: 0, error: 'previous run' }], _i: 0 }];
  const reader = new NetlistReader(provider, { pacer: makePacer(0) });
  const dir = mkdtempSync(join(tmpdir(), 'conformance-test-'));
  const cpPath = join(dir, 'cp.json');
  let flushes = 0;
  const logs = [];
  const ret1 = await sweep({
    todo, results, options, provider, pacer: makePacer(0), infoMap,
    log: (m) => logs.push(m),
    flush: () => { flushes++; writeCheckpoint(cpPath, { results: results.length }); },
    limit: 2, onMismatch: null, shouldStop: null, stats: {},
    reader, oracle: new ShimOracle(table),
  });
  assert.equal(ret1.checkedThisRun, 2);
  assert.equal(results.length, 3);
  assert.equal(results[0].errors[0].error, 'previous run'); // prefilled row passed through untouched
  assert.deepEqual(results.slice(1).map((r) => r.id), [2, 3]);
  assert.equal(results[1].matches, 2);
  assert.equal(results[2].matches, 2);
  assert.equal(flushes, 1);
  assert.equal(readCheckpoint(cpPath).results, 3);
  assert.equal(logs.length, 1);
  assert.match(logs[0], /\+2 \(3\/5 done, 4\/4 samples match, 0 mismatch, 0 error/);

  const stats = {};
  const seen = [];
  const ret2 = await sweep({
    todo, results, options, provider, pacer: makePacer(0), infoMap,
    log: () => {},
    flush: () => { flushes++; },
    limit: 0, onMismatch: (e) => seen.push(e), shouldStop: null, stats,
    reader, oracle: new ShimOracle(table, { fault: (a, id, kind) => id === 4 && kind === 'eval' }),
  });
  assert.equal(ret2.checkedThisRun, 2);
  assert.equal(results.length, 5);
  assert.deepEqual(results.map((r) => r.id), [1, 2, 3, 4, 5]);
  assert.equal(ret2.mismatchCircuits, 1);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].row.id, 4);
  assert.match(seen[0].row.netlistHex, /^0x[0-9a-f]+$/);
  assert.equal(seen[0].circuit.nGates, 8);
  // the ganache address is random, so the sampler seed (and the planned inputs) vary per run;
  // derive the expectations from the plan: an unconditional fault zeroes every 1-bit, one
  // chain call each, and never touches the (empty) state of this stateless circuit
  const pl0 = planSamplesFor(C.ref, 2, options.seed, mockAddr, 4)[seen[0].detail.sample];
  assert.deepEqual(seen[0].minimised.inputs, pl0.inputs.map(() => 0));
  assert.deepEqual(seen[0].minimised.state, null);
  assert.equal(seen[0].attempts, pl0.inputs.filter((b) => b === 1).length);
  assert.ok(results[3].mismatches.length >= 1);
  assert.equal(results[3].refs, 1);
  assert.equal(results[4].matches, 2);
  assert.ok(stats.reader && stats.oracle);
  rmSync(dir, { recursive: true, force: true });
});

test('summarize counts checked circuits and sums matches, mismatches and errors', () => {
  const results = [
    { samples: 4, matches: 4, nState: 0, refs: 0 },
    { samples: 4, matches: 3, mismatches: [{ sample: 1 }], nState: 1, refs: 2 },
    { samples: 2, matches: 0, errors: [{ sample: 0, error: 'x' }, { sample: 1, error: 'y' }], nState: 0, refs: 0 },
  ];
  const meta = { chainId: 196, rpc: 'http://x', block: 100, startedAtMs: Date.now() - 5000, processors: [{}, {}], circuits: 10, eligible: 9, skipped: { 'no outputs': 1 }, census: { block: 1 } };
  const s = summarize(results, meta, { seed: 7, samples: 4, maxGates: 100, budgetGas: 1, wave: 2 }, { state: 'complete' });
  assert.equal(s.checked, 2); // row 3 attempted nothing
  assert.equal(s.circuitsWithMismatches, 1);
  assert.equal(s.circuitsErrored, 1);
  assert.equal(s.samples, 10);
  assert.equal(s.compared, 8); // row 2: 3 matches + 1 mismatch
  assert.equal(s.matches, 7);
  assert.equal(s.mismatches, 1);
  assert.equal(s.erroredSamples, 2);
  assert.equal(s.stateful, 1);
  assert.equal(s.withRefs, 1);
  assert.equal(s.state, 'complete');
  assert.equal(s.chainId, 196);
  assert.equal(s.eligible, 9);
  assert.deepEqual(s.skipped, { 'no outputs': 1 });
  assert.equal(s.census.block, 1);
  assert.ok(s.elapsedS >= 4);
});

test('calldataFor and mismatchDoc produce exact, independent reproductions', () => {
  const selEval = keccakId('eval(uint256,bytes)').slice(0, 10);
  const selStep = keccakId('step(uint256,bytes,bytes)').slice(0, 10);
  const d1 = calldataFor('eval', 7, undefined, '0xab');
  const d2 = calldataFor('step', 7, '0x01', '0xab');
  assert.ok(d1.startsWith(selEval));
  assert.ok(d2.startsWith(selStep));
  assert.ok(d2.length > d1.length); // the state word is included for step

  const entries = [
    {
      row: { processor: mockAddr, id: 4, nIn: 3, nOut: 1, nState: 0, gates: 8, netlistHex: bytesHex(S.built.ref.netlist) },
      circuit: C.ref, detail: { sample: 0, inputs: '0xe0', expected: '0x01', got: '0x00' },
      minimised: { inputs: [0, 0, 1], state: null }, block: 123, attempts: 3,
    },
    {
      row: { processor: mockAddr, id: 2, nIn: 0, nOut: 1, nState: 1, gates: 4, netlistHex: bytesHex(S.built.toggle.netlist) },
      circuit: C.toggle, detail: { sample: 1, inputs: '0x', expected: '0x01', got: '0x00', expectedState: '0x01', gotState: '0x00' },
      minimised: { inputs: [], state: [1] }, block: 123, attempts: 2,
    },
  ];
  const doc = mismatchDoc(entries, { rpc: 'https://rpc.xlayer.tech', seed: 788604, samples: 4 });
  assert.match(doc, /^# Conformance mismatch/);
  assert.match(doc, new RegExp(`--only ${mockAddr} --id 4`));
  assert.match(doc, /--seed 788604 --samples 4/);
  assert.match(doc, /https:\/\/rpc\.xlayer\.tech/);
  assert.match(doc, /inputs `0x04`/); // pack([0,0,1]) is LSB-first
  assert.match(doc, /, state `0x01`/);
  assert.match(doc, /\| new state \| `0x01` \| `0x00` \|/);
  assert.match(doc, /netlist \(\d+ bytes\)/);
  const bodies = [...doc.matchAll(/```json\n(.+?)\n```/gs)].map((m) => JSON.parse(m[1]));
  assert.equal(bodies.length, 2);
  assert.equal(bodies[0].method, 'eth_call');
  assert.equal(bodies[0].params[0].to, mockAddr);
  assert.ok(bodies[0].params[0].data.startsWith(selEval));
  assert.ok(bodies[1].params[0].data.startsWith(selStep));
});
