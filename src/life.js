// Conway's Game of Life as TapeOut circuits: a 57-gate cell rule, and a board that REFs it once
// per cell and keeps the board in LATCHes. One beat = one generation.

import { Builder } from './hdl.js';

// Inputs: self, then the 8 neighbours. Output: self in the next generation.
export function cellCircuit() {
  const b = new Builder(9);
  const [self, ...n] = b.in;
  const [s1, c1] = b.fullAdd(n[0], n[1], n[2]);
  const [s2, c2] = b.fullAdd(n[3], n[4], n[5]);
  const [s3, c3] = b.halfAdd(n[6], n[7]);
  const [b0, c4] = b.fullAdd(s1, s2, s3); // bit 0 of the neighbour count
  const [t0, t1] = b.fullAdd(c1, c2, c3);
  const [b1, t2] = b.halfAdd(t0, c4); // bit 1
  const ge4 = b.or(t1, t2); // count >= 4
  // alive next = count is 2 or 3, and (count is 3 or self is alive)
  return b.build([b.and(b.and(b.not(ge4), b1), b.or(b0, self))]);
}

// A w x h board on a torus. State and outputs are the cells, row-major.
export function boardCircuit(w, h, cpu, cellId) {
  const b = new Builder(0);
  const cells = Array.from({ length: w * h }, () => b.latch());
  const at = (x, y) => cells[((y + h) % h) * w + ((x + w) % w)];
  const next = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nb = [];
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) nb.push(at(x + dx, y + dy));
      next.push(b.ref(cpu, cellId, 1, [at(x, y), ...nb])[0]);
    }
  }
  cells.forEach((q, i) => b.setLatch(q, next[i]));
  return b.build(next);
}

// Plain-JS reference.
export function lifeStep(cells, w, h) {
  const out = new Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let n = 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) if (dx || dy) n += cells[((y + dy + h) % h) * w + ((x + dx + w) % w)];
      out[y * w + x] = n === 3 || (n === 2 && cells[y * w + x]) ? 1 : 0;
    }
  }
  return out;
}

// Place patterns ('.' dead, 'O' alive, rows separated by '/') on an empty board.
export function board(w, h, placements) {
  const cells = new Array(w * h).fill(0);
  for (const [pattern, x0, y0] of placements) {
    pattern.split('/').forEach((row, dy) => {
      [...row].forEach((ch, dx) => { if (ch === 'O') cells[((y0 + dy) % h) * w + ((x0 + dx) % w)] = 1; });
    });
  }
  return cells;
}

export const PATTERNS = {
  glider: '.O./..O/OOO',
  blinker: 'OOO',
  toad: '.OOO/OOO.',
  lwss: '.O..O/O..../O...O/OOOO.',
  rpentomino: '.OO/OO./.O.',
};

export const render = (cells, w) => cells.reduce((s, v, i) => s + (v ? '█' : '·') + ((i + 1) % w === 0 ? '\n' : ''), '');
