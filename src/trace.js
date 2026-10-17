// Execution-order trace of one beat, and its Merkle commitment.
//
// Layout of the trace for one invocation of circuit C starting at position P:
//   P+0 = constant 0, P+1 = constant 1, P+2 .. P+1+nIn = inputs,
//   then each element in record order:
//     NAND / LATCH -> one leaf (its output)
//     REF          -> the child invocation's whole block, then nOut leaves copying the child's outputs
// flatSize(C) = 2 + nIn + sum(NAND/LATCH: 1, REF: flatSize(sub) + nOut).
//
// Every leaf depends only on earlier leaves (or on the job's inputs and state), so the
// first leaf where an honest trace and a claimed trace differ is always a single checkable step.

import { keccak256 } from 'ethers';
import { NAND, LATCH } from './tap02.js';

export function flatSize(c) {
  if (c._flat !== undefined) return c._flat;
  let n = 2 + c.nIn;
  for (const e of c.elements) n += e.op === NAND || e.op === LATCH ? 1 : flatSize(e.sub) + e.nOut;
  c._flat = n;
  return n;
}

// Returns { leaves: number[], outputs, newState }
export function traceBeat(c, state, inputs) {
  const leaves = [];
  const [newState, outputs] = run(c, state, inputs, leaves);
  return { leaves, outputs, newState };
}

function run(c, state, inputs, leaves) {
  const a = [0, 1, ...inputs];
  leaves.push(0, 1, ...inputs);
  const newState = state.slice();
  c.elements.forEach((e, k) => {
    const base = c.stateBase[k];
    if (e.op === NAND) {
      const v = 1 - (a[e.ins[0]] & a[e.ins[1]]);
      a.push(v); leaves.push(v);
    } else if (e.op === LATCH) {
      const v = state[base];
      a.push(v); leaves.push(v);
    } else {
      const [ns, outs] = run(e.sub, state.slice(base, base + e.sub.nState), e.ins.map((s) => a[s]), leaves);
      for (let i = 0; i < ns.length; i++) newState[base + i] = ns[i];
      a.push(...outs); leaves.push(...outs);
    }
  });
  c.elements.forEach((e, k) => { if (e.op === LATCH) newState[c.stateBase[k]] = a[e.ins[0]]; });
  return [newState, a.slice(a.length - c.nOut)];
}

// Leaf hash: keccak256(uint8 bit). Padding leaves past the trace are bytes32(0).
export const LEAF = [keccak256('0x00'), keccak256('0x01')];
export const PAD = '0x' + '00'.repeat(32);

const hashPair = (l, r) => keccak256('0x' + l.slice(2) + r.slice(2));

// Full tree as levels[0] = leaves .. levels[depth] = [root]. Size padded to a power of two.
export function buildTree(bits) {
  let size = 1;
  while (size < bits.length) size <<= 1;
  let level = [];
  for (let i = 0; i < size; i++) level.push(i < bits.length ? LEAF[bits[i]] : PAD);
  const levels = [level];
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) next.push(hashPair(level[i], level[i + 1]));
    levels.push(next);
    level = next;
  }
  return levels;
}

export const root = (levels) => levels[levels.length - 1][0];

export function proof(levels, index) {
  const sib = [];
  for (let d = 0; d < levels.length - 1; d++) {
    sib.push(levels[d][index ^ 1]);
    index >>= 1;
  }
  return sib;
}
