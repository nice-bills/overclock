// Off-chain side of a dispute: which earlier leaves a step depends on, and how a challenger
// builds proofs against the claimant's tree from the honest tree plus the nodes the claimant revealed.

import { keccak_256 } from '@noble/hashes/sha3';
import { NAND, LATCH, hexToBytes } from './tap02.js';
import { flatSize, layout } from './trace.js';

// Trace positions of every leaf that the rule for leaf q reads. Mirrors Overclock._expected.
export function depsOf(c, q, beats = 1) {
  const { F, B } = layout(c, beats);
  const b = Math.floor(q / B), r = q % B;
  const prevState = b > 0 ? (b - 1) * B + F : -1;
  if (r < F) return walk(c, b * B, null, q, 0, prevState);
  return [latchDPos(c, b * B, r - F)];
}

function walk(c, p, inPos, q, stOff, prevState) {
  if (q === p || q === p + 1) return [];
  if (q < p + 2 + c.nIn) return inPos ? [inPos[q - p - 2]] : [];
  const sigPos = [];
  for (let s = 0; s < 2 + c.nIn; s++) sigPos[s] = p + s;
  let pos = p + 2 + c.nIn;
  for (let k = 0; k < c.elements.length; k++) {
    const e = c.elements[k];
    if (e.op === NAND) {
      if (pos === q) return [sigPos[e.ins[0]], sigPos[e.ins[1]]];
      sigPos.push(pos++);
    } else if (e.op === LATCH) {
      if (pos === q) return prevState >= 0 ? [prevState + stOff + c.stateBase[k]] : [];
      sigPos.push(pos++);
    } else {
      const fs = flatSize(e.sub);
      if (q < pos + fs) return walk(e.sub, pos, e.ins.map((s) => sigPos[s]), q, stOff + c.stateBase[k], prevState);
      for (let i = 0; i < e.nOut; i++) {
        if (pos + fs + i === q) return [sigPosOf(e.sub, pos, e.sub.nSignals - e.nOut + i)];
      }
      pos += fs;
      for (let i = 0; i < e.nOut; i++) sigPos.push(pos++);
    }
  }
  throw new Error('position outside invocation');
}

// Trace position of the signal that state bit k of the invocation at p latches at the end of the beat.
export function latchDPos(c, p, k) {
  let pos = p + 2 + c.nIn;
  for (let i = 0; i < c.elements.length; i++) {
    const e = c.elements[i], base = c.stateBase[i];
    if (e.op === LATCH) {
      if (base === k) return sigPosOf(c, p, e.ins[0]);
      pos++;
    } else if (e.op === NAND) {
      pos++;
    } else {
      if (k < base + e.sub.nState) return latchDPos(e.sub, pos, k - base);
      pos += flatSize(e.sub) + e.nOut;
    }
  }
  throw new Error('no such state bit');
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

// Trace position of claimed result bit k: output k of the last beat, then the final state bits.
export function resultPos(c, beats, k) {
  const { F, B } = layout(c, beats);
  const p = (beats - 1) * B;
  return k < c.nOut ? sigPosOf(c, p, c.nSignals - c.nOut + k) : p + F + (k - c.nOut);
}

// A dispute descends the trace tree sixteen ways at a time: a move covers four levels, or what is
// left of the tree near the bottom. Mirrors Overclock._span.
export const span = (level) => Math.min(4, level);

// The 2^s nodes a claimant reveals for the node at (level, index) in its tree.
export const revealNodes = (tree, level, index) => {
  const s = span(level);
  return Array.from({ length: 2 ** s }, (_, i) => tree.node(level - s, index * 2 ** s + i));
};

// Rounds (reveal + pick) a dispute over a tree of this depth takes.
export const rounds = (depth) => Math.ceil(depth / 4);

const hashUp = (l, r) => '0x' + Buffer.from(keccak_256(Buffer.concat([hexToBytes(l), hexToBytes(r)]))).toString('hex');

// Tracks what the challenger knows about the claimant's tree during the dispute.
export class Bisector {
  constructor(honest) {
    this.h = honest; // Tree
    this.depth = honest.depth;
    this.known = new Map(); // `${level}:${index}` -> claimant hash
  }

  // Record the claimant's revealed nodes for (level, index), and every node between them and it,
  // then choose the first revealed node that differs from the honest tree.
  choose(level, index, nodes) {
    const s = span(level);
    if (nodes.length !== 2 ** s) throw new Error(`expected ${2 ** s} nodes, got ${nodes.length}`);
    let cur = nodes, lv = level - s, first = index * 2 ** s;
    for (;;) {
      cur.forEach((n, i) => this.known.set(`${lv}:${first + i}`, n));
      if (cur.length === 1) break;
      cur = Array.from({ length: cur.length / 2 }, (_, i) => hashUp(cur[2 * i], cur[2 * i + 1]));
      lv++;
      first /= 2;
    }
    const which = nodes.findIndex((n, i) => n !== this.h.node(level - s, index * 2 ** s + i));
    return which < 0 ? 0 : which;
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
      else if ((s + 1) * 2 ** d <= q) sib.push(this.h.node(d, s));
      else throw new Error(`unknown claimant node ${key}`);
      idx >>= 1;
    }
    return sib;
  }
}
