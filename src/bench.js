// Test-bench generator ("Proof of Design"). Given a design circuit and a reference circuit that
// should behave the same, emit one TAP-02 circuit that runs both side by side on every input,
// compares their outputs each beat and keeps the verdict in LATCHes. It takes no inputs: post it
// as one Overclock job of `beats` beats and read the verdict off the last beat's outputs.
//
// Stateless designs (nState = 0): an n-bit counter steps through all 2^n inputs, 0 .. 2^n-1.
// Stateful designs (either side has state): an n-bit LFSR steps through its 2^n-1 non-zero states
// from reset, so every beat sees a new input and the design's state evolves between beats.
// (The all-zero input is not applied in this mode.) Input i of the design is bit i of the counter
// or LFSR state.
//
// Bench outputs (nOut = n + 2): [mismatch, first[0..n-1], done]
//   mismatch  1 if any beat so far (this one included) had different outputs
//   first     the input of the first failing beat, bit i = input i (all 0 if none)
//   done      1 on the last beat. After `beats` beats the outputs are the verdict.
//
// Bench state (LATCHes, in order): counter/LFSR[n], mismatch, first[n], then the design's state,
// then the reference's. The job's starting state is benchState(): the LFSR seed (1), zeros, and
// each side's reset state.

import { Builder, encode } from './hdl.js';
import { load, beat, decode, NAND, REF } from './tap02.js';

// Maximal-length Fibonacci LFSR taps (1-based bit positions, Xilinx XAPP052). Period 2^n - 1.
const TAPS = {
  1: [1], 2: [2, 1], 3: [3, 2], 4: [4, 3], 5: [5, 3], 6: [6, 5], 7: [7, 6], 8: [8, 6, 5, 4], 9: [9, 5], 10: [10, 7],
  11: [11, 9], 12: [12, 6, 4, 1], 13: [13, 4, 3, 1], 14: [14, 5, 3, 1], 15: [15, 14], 16: [16, 15, 13, 4],
  17: [17, 14], 18: [18, 11], 19: [19, 6, 2, 1], 20: [20, 17], 21: [21, 19], 22: [22, 21], 23: [23, 18], 24: [24, 23, 22, 17],
};

const bitsOf = (v, n) => Array.from({ length: n }, (_, i) => (v >> i) & 1);
const valueOf = (bs) => bs.reduce((v, b, i) => v + b * 2 ** i, 0);

// LFSR in plain JS: state as an n-bit integer, bit 0 is the newest.
export function lfsrNext(s, n) {
  let fb = 0;
  for (const t of TAPS[n]) fb ^= (s >> (t - 1)) & 1;
  return ((s << 1) & (2 ** n - 1)) | fb;
}

// Input applied on beat k (0-based): counter mode k, LFSR mode the k-th state from seed 1.
export function inputAt(mode, n, k) {
  if (mode === 'count') return k;
  let s = 1;
  for (let i = 0; i < k; i++) s = lfsrNext(s, n);
  return s;
}

// desc: { cpu, id, nIn, nOut, nState = 0, reset = [] } for the design and for the reference.
export function benchCircuit(design, reference, { mode } = {}) {
  const n = design.nIn;
  if (!(n >= 1 && n <= 24)) throw new Error('bench needs 1..24 design inputs');
  if (reference.nIn !== n || reference.nOut !== design.nOut) throw new Error('design and reference must have the same inputs and outputs');
  const dState = design.nState ?? 0, rState = reference.nState ?? 0;
  mode ??= dState || rState ? 'lfsr' : 'count';
  const beats = mode === 'count' ? 2 ** n : 2 ** n - 1;

  const b = new Builder(0);
  const L = (k) => Array.from({ length: k }, () => b.latch());
  const cnt = L(n), mm = b.latch(), first = L(n);
  if (mode === 'count') {
    let carry = b.one;
    cnt.forEach((q, i) => { const [s, c] = b.halfAdd(q, carry); b.setLatch(q, s); carry = c; });
  } else {
    let fb = null;
    for (const t of TAPS[n]) fb = fb === null ? cnt[t - 1] : b.xor(fb, cnt[t - 1]);
    cnt.forEach((q, i) => b.setLatch(q, i === 0 ? fb : cnt[i - 1]));
  }
  // done on the beat whose input is the last one of the sequence
  const last = bitsOf(inputAt(mode, n, beats - 1), n);
  const done = cnt.map((q, i) => (last[i] ? q : b.not(q))).reduce((x, y) => b.and(x, y));

  const dOut = b.ref(design.cpu, design.id, design.nOut, cnt);
  const rOut = b.ref(reference.cpu, reference.id, reference.nOut, cnt);
  const diff = dOut.map((x, i) => b.xor(x, rOut[i])).reduce((x, y) => b.or(x, y));
  const mmNext = b.or(mm, diff);
  b.setLatch(mm, mmNext);
  const capture = b.and(diff, b.not(mm)); // the first beat that differs
  const firstNext = first.map((q, i) => {
    const nx = b.nand(b.nand(q, b.not(capture)), b.nand(cnt[i], capture)); // capture ? input : keep
    b.setLatch(q, nx);
    return nx;
  });
  const built = b.build([mmNext, ...firstNext, done]);
  return { ...built, beats, mode, n, design, reference, signals: { diff, mmNext }, layout: { count: 0, mm: n, first: n + 1, design: 2 * n + 1, reference: 2 * n + 1 + dState } };
}

// The job's starting state, as bits: LFSR seed, cleared verdict, each side's reset state.
export function benchState(bench) {
  const { n, mode, design, reference } = bench;
  const dState = design.nState ?? 0, rState = reference.nState ?? 0;
  const pad = (r, k) => Array.from({ length: k }, (_, i) => r?.[i] ?? 0);
  return [...bitsOf(mode === 'lfsr' ? 1 : 0, n), 0, ...new Array(n).fill(0), ...pad(design.reset, dState), ...pad(reference.reset, rState)];
}

// Read a bench's output bits (or the packed result) as a verdict.
export function verdict(outputs, n) {
  return { mismatch: outputs[0] === 1, firstInput: outputs[0] ? valueOf(outputs.slice(1, 1 + n)) : null, done: outputs[n + 1] === 1 };
}

// Off-chain expected verdict, computed with src/tap02.js: run design and reference side by side.
// resolve(cpu, id) -> loaded circuit. Returns { mismatch, firstInput, firstBeat, mismatches, beats, outputs }
// where `outputs` are the bench outputs the job should end with and `mismatches` counts failing beats.
export function expectedVerdict(bench, resolve) {
  const { n, mode, beats, design, reference } = bench;
  const d = resolve(design.cpu, BigInt(design.id)), r = resolve(reference.cpu, BigInt(reference.id));
  let ds = benchState(bench).slice(bench.layout.design, bench.layout.reference);
  let rs = benchState(bench).slice(bench.layout.reference);
  let mismatches = 0, firstBeat = null, firstInput = null, x = mode === 'count' ? 0 : 1;
  for (let k = 0; k < beats; k++) {
    const ins = bitsOf(x, n);
    const [dn, dOut] = beat(d, ds, ins), [rn, rOut] = beat(r, rs, ins);
    ds = dn; rs = rn;
    if (dOut.some((v, i) => v !== rOut[i])) {
      if (!mismatches) { firstBeat = k; firstInput = x; }
      mismatches++;
    }
    x = mode === 'count' ? x + 1 : lfsrNext(x, n);
  }
  const outputs = [mismatches ? 1 : 0, ...bitsOf(mismatches ? firstInput : 0, n), 1];
  return { mismatch: mismatches > 0, firstInput, firstBeat, mismatches, beats, outputs };
}

// Run the bench circuit itself, beat by beat, and return its final outputs (no trace kept).
export function runBench(bench, resolve) {
  const c = load(bench.netlist, 0, bench.nOut, resolve);
  let st = benchState(bench), outs;
  for (let k = 0; k < bench.beats; k++) [st, outs] = beat(c, st, []);
  return { outputs: outs, state: st, circuit: c };
}

// Size of a bench: gates per beat (REFs expanded) and the total steps of the job.
export function benchSize(bench, resolve) {
  const c = load(bench.netlist, 0, bench.nOut, resolve);
  return { gates: c.nGates, ownGates: c.elements.filter((e) => e.op !== REF).length, nState: c.nState, beats: bench.beats, steps: c.nGates * bench.beats };
}

// A copy of a netlist with one NAND's second input tied high, turning that gate into a NOT.
// The caller picks `which`: the index among the NAND records. Used to make a deliberately broken design.
export function breakNand(netlist, nIn, which) {
  const els = decode(netlist, nIn);
  const nands = els.filter((e) => e.op === NAND);
  if (!nands[which]) throw new Error('no such NAND');
  nands[which].ins[1] = 1;
  return encode(els);
}

// Sample w-bit adder (inputs a[0..w-1], b[0..w-1]; outputs sum[0..w-1], carry) for demos and tests.
// alt: a different gate structure with the same function. flawAt: also flips sum bit 0 on exactly that input.
export function adderCircuit(w, { alt = false, flawAt = null } = {}) {
  const b = new Builder(2 * w);
  let c = b.zero;
  const o = [];
  for (let i = 0; i < w; i++) {
    const [x, y] = [b.in[i], b.in[w + i]];
    if (alt) {
      const p = b.xor(x, y);
      o.push(b.xor(p, c));
      c = b.or(b.and(x, y), b.and(p, c));
    } else {
      const [s, co] = b.fullAdd(x, y, c);
      o.push(s);
      c = co;
    }
  }
  if (flawAt !== null) {
    const hit = b.in.map((x, i) => ((flawAt >> i) & 1 ? x : b.not(x))).reduce((x, y) => b.and(x, y));
    o[0] = b.xor(o[0], hit);
  }
  return b.build([...o, c]);
}
