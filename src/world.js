// Overclock World: Red vs Blue, a two-colour Game of Life (Immigration rules) as TapeOut circuits.
//
// Each cell is alive or dead, and a live cell is red or blue. Life's rules decide who lives; a cell that
// survives keeps its colour, and a cell that is born takes the colour most of its three parents have.
// The world is a w x h torus. Its state is every cell's "alive" bit (row-major), then every cell's "blue"
// bit, so a blue bit is only ever set on a live cell. One beat = one generation.

import { Builder } from './hdl.js';

// popcount of 8 bits: [bit 0, bit 1, count >= 4], the adder tree of the Life cell in src/life.js.
function count8(b, n) {
  const [s1, c1] = b.fullAdd(n[0], n[1], n[2]);
  const [s2, c2] = b.fullAdd(n[3], n[4], n[5]);
  const [s3, c3] = b.halfAdd(n[6], n[7]);
  const [b0, c4] = b.fullAdd(s1, s2, s3);
  const [t0, t1] = b.fullAdd(c1, c2, c3);
  const [b1, t2] = b.halfAdd(t0, c4);
  return [b0, b1, b.or(t1, t2)];
}

// Inputs: self alive, self blue, the 8 neighbours' alive bits, then their 8 blue bits.
// Outputs: alive next, blue next.
export function colourCellCircuit() {
  const b = new Builder(18);
  const [alive, blue] = b.in;
  const live = b.in.slice(2, 10), blues = b.in.slice(10, 18);
  const [n0, n1, ge4] = count8(b, live);
  const next = b.and(b.and(b.not(ge4), n1), b.or(n0, alive)); // 2 or 3 neighbours, and 3 or already alive
  const [, m1, mge4] = count8(b, blues);
  const blueParents = b.or(m1, mge4); // at least 2 of the (exactly 3) parents are blue
  const colour = b.or(b.and(alive, blue), b.and(b.not(alive), blueParents));
  return b.build([next, b.and(next, colour)]);
}

// The w x h world: one REF to the colour cell per cell, 2 LATCHes per cell. Outputs are the next state.
export function worldCircuit(w, h, cpu, cellId) {
  const b = new Builder(0);
  const n = w * h;
  const alive = Array.from({ length: n }, () => b.latch());
  const blue = Array.from({ length: n }, () => b.latch());
  const at = (arr, x, y) => arr[((y + h) % h) * w + ((x + w) % w)];
  const nextAlive = [], nextBlue = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const na = [], nb = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) { na.push(at(alive, x + dx, y + dy)); nb.push(at(blue, x + dx, y + dy)); }
      const [a, bl] = b.ref(cpu, cellId, 2, [at(alive, x, y), at(blue, x, y), ...na, ...nb]);
      nextAlive.push(a);
      nextBlue.push(bl);
    }
  }
  alive.forEach((q, i) => b.setLatch(q, nextAlive[i]));
  blue.forEach((q, i) => b.setLatch(q, nextBlue[i]));
  return b.build([...nextAlive, ...nextBlue]);
}

// Plain-JS reference. cells: array of 0 (dead), 1 (red), 2 (blue).
export function worldStep(cells, w, h) {
  const out = new Array(w * h).fill(0);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let live = 0, blues = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dy) continue;
        const v = cells[((y + dy + h) % h) * w + ((x + dx + w) % w)];
        if (v) live++;
        if (v === 2) blues++;
      }
      const self = cells[y * w + x];
      if (self && (live === 2 || live === 3)) out[y * w + x] = self;
      else if (!self && live === 3) out[y * w + x] = blues >= 2 ? 2 : 1;
    }
  }
  return out;
}

// cells (0/1/2) <-> circuit state bits (alive bits, then blue bits).
export const toWorldState = (cells) => [...cells.map((v) => (v ? 1 : 0)), ...cells.map((v) => (v === 2 ? 1 : 0))];
export const fromWorldState = (bits) => {
  const n = bits.length / 2;
  return Array.from({ length: n }, (_, i) => (bits[i] ? (bits[n + i] ? 2 : 1) : 0));
};
export const score = (cells) => ({ red: cells.filter((v) => v === 1).length, blue: cells.filter((v) => v === 2).length });
