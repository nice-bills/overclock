import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load, beat, pack, unpack, hexToBytes, bytesToHex, IllFormed } from '../src/tap02.js';
import { traceBeat, traceJob, flatSize, buildTree, Tree, LEAF } from '../src/trace.js';
import { keccak256 } from 'ethers';

const vectors = JSON.parse(readFileSync(new URL('../vendor-tap02/vectors.json', import.meta.url)));

function loadVector(v) {
  const subs = new Map();
  for (const r of v.refs) subs.set(`${r.cpu.toLowerCase()}:${r.id}`, load(hexToBytes(r.netlist), r.nIn, r.nOut, null));
  const resolve = (cpu, id) => subs.get(`${cpu.toLowerCase()}:${id}`) ?? null;
  return load(hexToBytes(v.netlist), v.nIn, v.nOut, resolve);
}

const hex = (bits) => bytesToHex(pack(bits)).slice(2);

for (const v of vectors.valid) {
  test(`valid: ${v.name}`, () => {
    const c = loadVector(v);
    assert.equal(c.nState, v.nState);
    for (const row of v.truthTable ?? []) {
      const [, outs] = beat(c, [], unpack(hexToBytes(row.inputs), c.nIn));
      assert.equal(hex(outs), row.outputs, `inputs ${row.inputs}`);
    }
    for (const b of v.beats ?? []) {
      const [ns, outs] = beat(c, unpack(hexToBytes(b.state), c.nState), unpack(hexToBytes(b.inputs), c.nIn));
      assert.equal(hex(outs), b.outputs);
      assert.equal(hex(ns), b.newState);
    }
  });
}

for (const v of vectors.illFormed) {
  test(`ill-formed: ${v.name}`, () => {
    assert.throws(() => loadVector(v), (e) => e instanceof IllFormed && e.message === v.reason);
  });
}

test('packing edge cases match the deployed evaluator', () => {
  const v = vectors.valid.find((x) => x.name === vectors.packingEdgeCases.circuit);
  const c = loadVector(v);
  for (const k of vectors.packingEdgeCases.cases) {
    const [, outs] = beat(c, [], unpack(hexToBytes(k.inputs), c.nIn));
    assert.equal(hex(outs), k.outputs, k.case);
  }
});

test('trace agrees with beat() and has flatSize leaves', () => {
  for (const v of vectors.valid) {
    const c = loadVector(v);
    const rows = v.truthTable?.map((r) => ({ state: '', inputs: r.inputs })) ?? v.beats;
    for (const r of rows) {
      const st = unpack(hexToBytes(r.state), c.nState), ins = unpack(hexToBytes(r.inputs), c.nIn);
      const t = traceBeat(c, st, ins);
      const [ns, outs] = beat(c, st, ins);
      assert.deepEqual(t.outputs, outs);
      assert.deepEqual(t.newState, ns);
      assert.equal(t.leaves.length, flatSize(c));
    }
  }
});

test('merkle proofs verify', () => {
  const tree = buildTree([0, 1, 1, 0, 1]);
  for (let i = 0; i < 5; i++) {
    let h = tree.node(0, i), idx = i;
    for (const s of tree.proof(i)) {
      h = idx & 1 ? keccak256('0x' + s.slice(2) + h.slice(2)) : keccak256('0x' + h.slice(2) + s.slice(2));
      idx >>= 1;
    }
    assert.equal(h, tree.root);
  }
  assert.equal(tree.node(0, 1), LEAF[1]);
});

test('multi-beat trace: state leaves chain beats together', () => {
  const v = vectors.valid.find((x) => x.name === 'ref_with_state');
  const c = loadVector(v);
  let st = [0, 1];
  const t = traceJob(c, { state: st, inputs: [1], beats: 5 });
  for (let b = 0; b < 5; b++) {
    const one = traceBeat(c, st, [1]);
    assert.deepEqual(Array.from(t.leaves.subarray(b * t.B, b * t.B + t.F)), one.leaves);
    assert.deepEqual(Array.from(t.leaves.subarray(b * t.B + t.F, (b + 1) * t.B)), one.newState);
    st = one.newState;
  }
  assert.deepEqual(t.newState, st);
});

test('cached tree levels agree with a fully built tree', () => {
  const bits = new Uint8Array(3000).map((_, i) => (i * 7919) % 3 === 0 ? 1 : 0);
  const full = new Tree(bits);
  const part = new Tree(bits);
  part.levels = []; part.cacheFrom = full.depth; part.levels[full.depth] = full.levels[full.depth]; // only the root cached
  for (const [l, i] of [[0, 5], [1, 1499], [3, 300], [7, 20], [11, 1]]) assert.equal(part.node(l, i), full.node(l, i));
});
