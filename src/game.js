// Off-chain side of a dispute: which earlier leaves a step depends on, and how a challenger
// builds proofs against the claimant's tree from the honest tree plus the nodes the claimant revealed.

import { NAND, LATCH } from './tap02.js';
import { flatSize } from './trace.js';

// Trace positions of every leaf that the rule for leaf q reads. Mirrors Overclock._bitAt.
export function depsOf(c, q) {
  return walk(c, 0, null, q);
}

function walk(c, p, inPos, q) {
  if (q === p || q === p + 1) return [];
  if (q < p + 2 + c.nIn) return inPos ? [inPos[q - p - 2]] : [];
  const sigPos = [];
  for (let s = 0; s < 2 + c.nIn; s++) sigPos[s] = p + s;
  let pos = p + 2 + c.nIn;
  for (const e of c.elements) {
    if (e.op === NAND) {
      if (pos === q) return [sigPos[e.ins[0]], sigPos[e.ins[1]]];
      sigPos.push(pos++);
    } else if (e.op === LATCH) {
      if (pos === q) return [];
      sigPos.push(pos++);
    } else {
      const fs = flatSize(e.sub);
      if (q < pos + fs) return walk(e.sub, pos, e.ins.map((s) => sigPos[s]), q);
      for (let k = 0; k < e.nOut; k++) {
        if (pos + fs + k === q) return [sigPosOf(e.sub, pos, e.sub.nSignals - e.nOut + k)];
      }
      pos += fs;
      for (let k = 0; k < e.nOut; k++) sigPos.push(pos++);
    }
  }
  throw new Error('position outside invocation');
}

export function sigPosOf(c, p, s) {
  if (s < 2 + c.nIn) return p + s;
  let pos = p + 2 + c.nIn, sig = 2 + c.nIn;
  for (const e of c.elements) {
    if (e.op === NAND || e.op === LATCH) {
      if (sig === s) return pos;
      pos++; sig++;
    } else {
      pos += flatSize(e.sub);
      for (let k = 0; k < e.nOut; k++) {
        if (sig === s) return pos;
        pos++; sig++;
      }
    }
  }
  throw new Error('no such signal');
}

// Tracks what the challenger knows about the claimant's tree during bisection.
export class Bisector {
  constructor(honestLevels) {
    this.h = honestLevels;
    this.depth = honestLevels.length - 1;
    this.known = new Map(); // `${level}:${index}` -> claimant hash
  }

  // Record the claimant's two children of (level, index) and choose the one to dispute.
  choose(level, index, left, right) {
    this.known.set(`${level - 1}:${2 * index}`, left);
    this.known.set(`${level - 1}:${2 * index + 1}`, right);
    return left !== this.h[level - 1][2 * index]; // true -> go left
  }

  // Merkle siblings for leaf pos in the claimant's tree. Only valid for leaves before the
  // disputed leaf q: every sibling is either fully left of q (same as honest) or was revealed.
  siblings(pos, q) {
    const sib = [];
    let idx = pos;
    for (let d = 0; d < this.depth; d++) {
      const s = idx ^ 1;
      const key = `${d}:${s}`;
      if (this.known.has(key)) sib.push(this.known.get(key));
      else if (((s + 1) << d) <= q) sib.push(this.h[d][s]);
      else throw new Error(`unknown claimant node ${key}`);
      idx >>= 1;
    }
    return sib;
  }
}
