import { test } from 'node:test';
import assert from 'node:assert/strict';
import { load, beat } from '../src/tap02.js';
import { traceJob } from '../src/trace.js';
import { colourCellCircuit, worldCircuit, worldStep, toWorldState, fromWorldState } from '../src/world.js';

const CPU = '0x00000000000000000000000000000000000000c2';

function loadWorld(w, h) {
  const cell = colourCellCircuit();
  const cc = load(cell.netlist, cell.nIn, cell.nOut);
  const wd = worldCircuit(w, h, CPU, 9);
  return load(wd.netlist, wd.nIn, wd.nOut, (cpu, id) => (cpu === CPU && id === 9n ? cc : null));
}

// Deterministic pseudo-random worlds.
function randomCells(n, seed, density = 0.35) {
  let s = seed;
  const r = () => ((s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  return Array.from({ length: n }, () => (r() < density ? (r() < 0.5 ? 1 : 2) : 0));
}

test('colour cell matches the Immigration rule on every neighbourhood', () => {
  const cell = colourCellCircuit();
  const c = load(cell.netlist, 18, 2);
  // every self state (dead, red, blue) x every 3^8 colouring of the neighbours
  for (let self = 0; self < 3; self++) {
    for (let m = 0; m < 6561; m++) {
      const nb = [];
      for (let k = 0, v = m; k < 8; k++, v = Math.floor(v / 3)) nb.push(v % 3);
      const ins = [self ? 1 : 0, self === 2 ? 1 : 0, ...nb.map((v) => (v ? 1 : 0)), ...nb.map((v) => (v === 2 ? 1 : 0))];
      const live = nb.filter(Boolean).length, blues = nb.filter((v) => v === 2).length;
      const want = self && (live === 2 || live === 3) ? self : !self && live === 3 ? (blues >= 2 ? 2 : 1) : 0;
      const [, [a, b]] = beat(c, [], ins);
      assert.equal(a ? (b ? 2 : 1) : 0, want, `self ${self}, neighbours ${nb}`);
    }
  }
  assert.ok(c.nGates <= 130, `colour cell has ${c.nGates} gates`);
});

test('world circuit runs Red vs Blue: 30 generations of a random 12x10 torus', () => {
  const w = 12, h = 10;
  const c = loadWorld(w, h);
  assert.equal(c.nState, 2 * w * h);
  let ref = randomCells(w * h, 7);
  const t = traceJob(c, { state: toWorldState(ref), beats: 30 });
  for (let g = 0; g < 30; g++) ref = worldStep(ref, w, h);
  assert.deepEqual(fromWorldState(t.newState), ref);
  assert.deepEqual(t.outputs, toWorldState(ref));
});

test('a blue glider stays blue and a red one stays red', () => {
  const w = 8, h = 8;
  const glider = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2]];
  for (const colour of [1, 2]) {
    let cells = new Array(w * h).fill(0);
    for (const [x, y] of glider) cells[y * w + x] = colour;
    for (let g = 0; g < 16; g++) cells = worldStep(cells, w, h);
    assert.equal(cells.filter(Boolean).length, 5);
    assert.ok(cells.every((v) => v === 0 || v === colour));
  }
});

test('the 16x16 world is ~28K gates a generation', () => {
  const c = loadWorld(16, 16);
  assert.equal(c.nState, 512);
  assert.ok(c.nGates > 20000 && c.nGates < 40000, `${c.nGates} gates`);
});
