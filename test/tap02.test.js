import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { load, beat, pack, unpack, hexToBytes, bytesToHex, IllFormed } from '../src/tap02.js';
import { traceBeat, flatSize, buildTree, root, proof, LEAF } from '../src/trace.js';
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
  const levels = buildTree([0, 1, 1, 0, 1]);
  for (let i = 0; i < 5; i++) {
    let h = levels[0][i], idx = i;
    for (const s of proof(levels, i)) {
      h = idx & 1 ? keccak256('0x' + s.slice(2) + h.slice(2)) : keccak256('0x' + h.slice(2) + s.slice(2));
      idx >>= 1;
    }
    assert.equal(h, root(levels));
  }
  assert.equal(levels[0][1], LEAF[1]);
});
