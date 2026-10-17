// Execution-order trace of a job, and its Merkle commitment.
//
// Layout of the trace for one invocation of circuit C starting at position P:
//   P+0 = constant 0, P+1 = constant 1, P+2 .. P+1+nIn = inputs,
//   then each element in record order:
//     NAND / LATCH -> one leaf (its output)
//     REF          -> the child invocation's whole block, then nOut leaves copying the child's outputs
// flatSize(C) = 2 + nIn + sum(NAND/LATCH: 1, REF: flatSize(sub) + nOut).
//
// A job runs `beats` beats. Its trace is one block of B = F + S leaves per beat: the beat's
// invocation (F = flatSize leaves) followed by the S = nState bits of the new state. A LATCH in
// beat b > 0 reads the state leaves of beat b - 1; beat 0 reads the job's starting state.
//
// Every leaf depends only on earlier leaves (or on the job's inputs and state), so the
// first leaf where an honest trace and a claimed trace differ is always a single checkable step.

import { keccak_256 } from '@noble/hashes/sha3';
import { NAND, LATCH } from './tap02.js';

export function flatSize(c) {
  if (c._flat !== undefined) return c._flat;
  let n = 2 + c.nIn;
  for (const e of c.elements) n += e.op === NAND || e.op === LATCH ? 1 : flatSize(e.sub) + e.nOut;
  c._flat = n;
  return n;
}

export function layout(c, beats = 1) {
  const F = flatSize(c), S = c.nState;
  return { F, S, B: F + S, beats, n: beats * (F + S) };
}

// One beat on its own (no state leaves). Returns { leaves: number[], outputs, newState }.
export function traceBeat(c, state, inputs) {
  const t = { buf: [], n: 0, fault: -1 };
  const [newState, outputs] = run(c, state, inputs, t);
  return { leaves: t.buf, outputs, newState };
}

// A whole job. inputs: one beat's bits (repeated every beat) or, with perBeat, beats * nIn bits.
// fault: a leaf index whose value is flipped while computing, with everything after it computed
// from the flipped value. That is the hardest lie to catch: the trace is consistent everywhere
// except at one step.
export function traceJob(c, { state = [], inputs = [], beats = 1, perBeat = false, fault = -1, onBeat } = {}) {
  const L = layout(c, beats);
  const t = { buf: new Uint8Array(L.n), n: 0, fault };
  let st = state.slice(0, c.nState);
  while (st.length < c.nState) st.push(0);
  let outputs;
  for (let b = 0; b < beats; b++) {
    const ins = perBeat ? inputs.slice(b * c.nIn, (b + 1) * c.nIn) : inputs.slice(0, c.nIn);
    while (ins.length < c.nIn) ins.push(0);
    const [ns, outs] = run(c, st, ins, t);
    st = ns.map((v) => emit(t, v));
    outputs = outs;
    if (onBeat) onBeat(b, st, outs);
  }
  return { leaves: t.buf, outputs, newState: st, ...L };
}

function emit(t, v) {
  if (t.n === t.fault) v ^= 1;
  t.buf[t.n++] = v;
  return v;
}

function run(c, state, inputs, t) {
  const a = [emit(t, 0), emit(t, 1)];
  for (const v of inputs) a.push(emit(t, v));
  const newState = state.slice();
  const els = c.elements;
  for (let k = 0; k < els.length; k++) {
    const e = els[k];
    const base = c.stateBase[k];
    if (e.op === NAND) {
      a.push(emit(t, 1 - (a[e.ins[0]] & a[e.ins[1]])));
    } else if (e.op === LATCH) {
      a.push(emit(t, state[base]));
    } else {
      const [ns, outs] = run(e.sub, state.slice(base, base + e.sub.nState), e.ins.map((s) => a[s]), t);
      for (let i = 0; i < ns.length; i++) newState[base + i] = ns[i];
      for (const v of outs) a.push(emit(t, v));
    }
  }
  for (let k = 0; k < els.length; k++) if (els[k].op === LATCH) newState[c.stateBase[k]] = a[els[k].ins[0]];
  return [newState, a.slice(a.length - c.nOut)];
}

// ------------------------------------------------------------------ Merkle tree

// Leaf hash: keccak256(uint8 bit). Padding leaves past the trace are bytes32(0).
const LEAF_B = [keccak_256(new Uint8Array([0])), keccak_256(new Uint8Array([1]))];
const PAD_B = new Uint8Array(32);
const toHex = (b) => '0x' + Buffer.from(b).toString('hex');
export const LEAF = LEAF_B.map(toHex);
export const PAD = toHex(PAD_B);

function hashPair(l, r) {
  const m = new Uint8Array(64);
  m.set(l, 0);
  m.set(r, 32);
  return keccak_256(m);
}

// Level-1 nodes take only nine values; memoize them.
const L1 = new Map();
function level1(a, b) {
  const key = a * 3 + b;
  let h = L1.get(key);
  if (!h) {
    const leaf = (x) => (x === 2 ? PAD_B : LEAF_B[x]);
    h = hashPair(leaf(a), leaf(b));
    L1.set(key, h);
  }
  return h;
}

// Keeps the leaf bits plus the upper levels of the tree (at most ~2^20 nodes per level);
// nodes below the cached levels are recomputed from the leaves on demand.
export class Tree {
  constructor(bits, n = bits.length) {
    this.bits = bits;
    this.n = n;
    let depth = 0;
    while (1 << depth < n) depth++;
    this.depth = depth;
    this.cacheFrom = Math.max(0, depth - 20);
    this.levels = [];
    const count = 1 << (depth - this.cacheFrom);
    let lvl = new Array(count);
    for (let i = 0; i < count; i++) lvl[i] = this._compute(this.cacheFrom, i);
    this.levels[this.cacheFrom] = lvl;
    for (let d = this.cacheFrom + 1; d <= depth; d++) {
      const next = new Array(lvl.length >> 1);
      for (let i = 0; i < next.length; i++) next[i] = hashPair(lvl[2 * i], lvl[2 * i + 1]);
      this.levels[d] = lvl = next;
    }
  }

  _bit(i) {
    return i < this.n ? this.bits[i] : 2;
  }

  _compute(level, index) {
    if (level === 0) {
      const b = this._bit(index);
      return b === 2 ? PAD_B : LEAF_B[b];
    }
    if (level === 1) return level1(this._bit(2 * index), this._bit(2 * index + 1));
    const cached = this.levels[level];
    if (cached) return cached[index];
    if (index * 2 ** level >= this.n) return this._padNode(level);
    return hashPair(this._compute(level - 1, 2 * index), this._compute(level - 1, 2 * index + 1));
  }

  _padNode(level) {
    this._pads ??= [PAD_B];
    while (this._pads.length <= level) this._pads.push(hashPair(this._pads.at(-1), this._pads.at(-1)));
    return this._pads[level];
  }

  node(level, index) {
    return toHex(this._compute(level, index));
  }

  get root() {
    return this.node(this.depth, 0);
  }

  proof(index) {
    const sib = [];
    for (let d = 0; d < this.depth; d++) {
      sib.push(this.node(d, index ^ 1));
      index >>= 1;
    }
    return sib;
  }
}

export const buildTree = (bits) => new Tree(bits);
