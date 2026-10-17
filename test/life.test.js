import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, beat } from '../src/tap02.js';
import { traceJob } from '../src/trace.js';
import { cellCircuit, boardCircuit, lifeStep, board, PATTERNS } from '../src/life.js';

const CPU = '0x00000000000000000000000000000000000000c1';

function loadBoard(w, h) {
  const cell = cellCircuit();
  const cc = load(cell.netlist, cell.nIn, cell.nOut);
  const bd = boardCircuit(w, h, CPU, 7);
  return load(bd.netlist, bd.nIn, bd.nOut, (cpu, id) => (cpu === CPU && id === 7n ? cc : null));
}

test('cell circuit matches the Life rule on all 512 neighbourhoods', () => {
  const cell = cellCircuit();
  const c = load(cell.netlist, 9, 1);
  for (let m = 0; m < 512; m++) {
    const ins = Array.from({ length: 9 }, (_, i) => (m >> i) & 1);
    const n = ins.slice(1).reduce((a, b) => a + b, 0);
    const want = n === 3 || (n === 2 && ins[0]) ? 1 : 0;
    assert.equal(beat(c, [], ins)[1][0], want, `mask ${m}`);
  }
  assert.ok(c.nGates <= 60, `cell has ${c.nGates} gates`);
});

test('board circuit runs Life: 40 generations of a glider and friends on a 12x10 torus', () => {
  const w = 12, h = 10;
  const c = loadBoard(w, h);
  assert.equal(c.nState, w * h);
  let ref = board(w, h, [[PATTERNS.glider, 1, 1], [PATTERNS.blinker, 8, 6], [PATTERNS.toad, 6, 2]]);
  const t = traceJob(c, { state: ref, beats: 40 });
  for (let g = 0; g < 40; g++) ref = lifeStep(ref, w, h);
  assert.deepEqual(t.newState, ref);
  assert.deepEqual(t.outputs, ref);
});
