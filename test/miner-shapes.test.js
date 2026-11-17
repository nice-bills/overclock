import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  describeNetlist,
  familyKey,
  shapeKey,
  groupShapes,
  groupFamilies,
  diffNetlists,
  verifyNetlist,
  verifyBeats,
  vectorsAreExhaustive,
  vectorsAreDegenerate,
  taskVerdict,
  shapeVerdict,
} from '../scripts/miner-shapes.js';
import { decode, hexToBytes } from '../src/tap02.js';

const vectors = JSON.parse(readFileSync(new URL('../vendor-tap02/vectors.json', import.meta.url)));
const byName = Object.fromEntries(vectors.valid.map((v) => [v.name, v]));

// A 2-in/1-out/0-state netlist with three NAND gates, and a one-gate edit of it.
// Inputs are signals 2 and 3, so the three gates produce signals 4, 5 and 6.
const nand3 = '0x000000020000030000000200000300000004000005';
const nand3Variant = '0x000000020000030000000200000300000004000003';

// Local records mimic what scripts/miner-shapes.js reads from a processor.
const record = (v, processor = '0xlocal', id = 1, extra = {}) => {
  const d = describeNetlist(v.netlist, v.nIn);
  return {
    processor,
    id,
    nIn: v.nIn,
    nOut: v.nOut,
    nState: v.nState,
    gates: v.nState + d.nand + d.ref,
    netlist: v.netlist,
    ...d,
    taskId: null,
    ...extra,
  };
};

test('describeNetlist counts gates and hashes the exact bytes', () => {
  const nand = describeNetlist(byName.nand.netlist, byName.nand.nIn);
  assert.equal(nand.nand, 1);
  assert.equal(nand.latch, 0);
  assert.equal(nand.ref, 0);
  assert.equal(nand.elements, 1);
  assert.match(nand.structHash, /^0x[0-9a-f]{64}$/);
  assert.match(nand.topoHash, /^0x[0-9a-f]{64}$/);

  const toggle = describeNetlist(byName.toggle.netlist, byName.toggle.nIn);
  const decoded = decode(hexToBytes(byName.toggle.netlist), byName.toggle.nIn);
  assert.equal(toggle.elements, decoded.length);
  assert.equal(toggle.nand + toggle.latch + toggle.ref, decoded.length);
  assert.equal(toggle.latch, 1);
});

test('the same netlist always hashes the same; different netlists differ', () => {
  const a = describeNetlist(byName.nand.netlist, 2);
  const b = describeNetlist(byName.nand.netlist, 2);
  assert.equal(a.structHash, b.structHash);
  assert.equal(a.topoHash, b.topoHash);

  const c = describeNetlist(byName.constants.netlist, 1);
  assert.notEqual(a.structHash, c.structHash);
  assert.notEqual(a.topoHash, c.topoHash);
});

test('shape keys combine pins, state, gate count and structural hash', () => {
  const nand = record(byName.nand, '0xaaa', 1);
  const constants = record(byName.constants, '0xaaa', 2);
  assert.equal(familyKey(nand), '2/1/0/1');
  assert.equal(shapeKey(nand), `2/1/0/1/${nand.structHash}`);
  assert.notEqual(shapeKey(nand), shapeKey(constants));
});

test('groupShapes counts identical copies and separate hashes in one family', () => {
  // Both netlists are 2-in/1-out/0-state with three gates, so they share a family
  // but not a structural hash. The second one only changes its last gate.
  const base = { netlist: nand3, nIn: 2, nOut: 1, nState: 0 };
  const variant = { ...base, netlist: nand3Variant };
  const records = [
    record(base, '0xp', 1, { taskId: 2, isReference: true }),
    record(base, '0xp', 2, { taskId: 2, isReference: true }),
    record(base, '0xp', 3, { taskId: 2, isReference: true }),
    record(variant, '0xp', 4, { taskId: 2 }),
    record(byName.constants, '0xp', 5),
    record(byName.popcount8_3151, '0xp', 6),
  ];
  const shapes = groupShapes(records);
  const families = groupFamilies(records);

  const nandShape = shapes.find((s) => s.structHash === records[0].structHash);
  assert.equal(nandShape.count, 3);
  assert.equal(nandShape.refCopies, 3);
  assert.deepEqual(nandShape.tasks, [[2, 3]]);
  assert.equal(shapes.find((s) => s.structHash === records[3].structHash).count, 1);

  const nandFamily = families.find((f) => f.key === '2/1/0/3');
  assert.equal(nandFamily.count, 4);
  assert.equal(nandFamily.hashes, 2);
  assert.equal(nandFamily.miners, 4);
  assert.equal(shapes.length, 4);
  assert.equal(families.length, 3);
});

test('diffNetlists separates identical, one-gate edits and independent designs', () => {
  assert.equal(diffNetlists(nand3, nand3, 2).class, 'identical');

  // Same first two gates, same length, one different last gate.
  const d = diffNetlists(nand3, nand3Variant, 2);
  assert.equal(d.changedA, 1);
  assert.equal(d.class, 'derived');

  assert.equal(diffNetlists(byName.nand.netlist, byName.toggle.netlist, 2, 1).class, 'independent');
});

test('verifyNetlist runs the published truth tables', () => {
  for (const name of ['nand', 'constants', 'popcount8_3151']) {
    const v = byName[name];
    const vs = v.truthTable.map((row) => ({ input: `0x${row.inputs}`, expectedOut: `0x${row.outputs}` }));
    const res = verifyNetlist(v.netlist, v.nIn, v.nOut, vs);
    assert.equal(res.passed, vs.length, name);
    assert.equal(res.firstFailure, null, name);
  }
});

test('verifyNetlist reports the first failing vector', () => {
  const v = byName.nand;
  const vs = v.truthTable.map((row) => ({ input: `0x${row.inputs}`, expectedOut: `0x${row.outputs}` }));
  vs[2] = { ...vs[2], expectedOut: '0x02' }; // wrong output pin
  const res = verifyNetlist(v.netlist, v.nIn, v.nOut, vs);
  assert.equal(res.passed, vs.length - 1);
  assert.equal(res.firstFailure.index, 2);
  assert.equal(res.firstFailure.input, '0x02');
});

test('verifyBeats carries state and checks every beat', () => {
  const v = byName.toggle;
  assert.equal(verifyBeats(v.netlist, v.nIn, v.nOut, v.beats).passed, v.beats.length);

  const broken = v.beats.map((b) => ({ ...b }));
  broken[3] = { ...broken[3], outputs: '02' };
  const res = verifyBeats(v.netlist, v.nIn, v.nOut, broken);
  assert.equal(res.passed, broken.length - 1);
  assert.equal(res.firstFailure.index, 3);
});

test('vector coverage and verdict rules', () => {
  const comb = { taskId: 2, kind: 0, cycles: 1, nIn: 2, nOut: 1, refCircuits: '0xref', refCircuitId: 2n };
  const full = ['00', '01', '02', '03'].map((i) => ({ input: `0x${i}`, expectedOut: '0x01' }));
  assert.equal(vectorsAreExhaustive(comb, full), true);
  assert.equal(vectorsAreExhaustive(comb, full.slice(0, 2)), false);
  assert.deepEqual(taskVerdict(comb, full).verdict, 'YES-vectors');
  assert.deepEqual(taskVerdict(comb, full.slice(0, 2)).verdict, 'YES-ref');
  assert.deepEqual(taskVerdict({ ...comb, refCircuits: null }, full).verdict, 'NO-ref');

  const zero = full.map((v) => ({ ...v, expectedOut: '0x00' }));
  assert.equal(vectorsAreDegenerate(zero), true);
  assert.equal(vectorsAreDegenerate(full), false);
  assert.deepEqual(taskVerdict({ ...comb, nIn: 18 }, zero).verdict, 'NO-degenerate');

  const yes = { taskId: 1, verdict: { verdict: 'YES-vectors' } };
  const dead = { taskId: 98, verdict: { verdict: 'NO-degenerate' } };
  assert.equal(shapeVerdict([]).verdict, 'NO-unclaimed');
  assert.equal(shapeVerdict([yes]).verdict, 'YES-vectors');
  assert.equal(shapeVerdict([yes, dead]).verdict, 'NO-degenerate');
  assert.match(shapeVerdict([yes, dead]).reason, /GC-098:NO-degenerate GC-001:YES-vectors/);
});
