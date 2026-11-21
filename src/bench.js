// Test-bench generator ("Proof of Design"). Given a design circuit and a reference circuit that
// should behave the same, emit one TAP-02 circuit that runs both side by side on every input,
// compares their outputs each beat and keeps the verdict in LATCHes. It takes no inputs: post it
// as one Overclock job of `beats` beats and read the verdict off the last beat's outputs.
//
// Three input schedules:
//
//   count   (stateless designs)  an n-bit counter steps through all 2^n inputs, 0 .. 2^n-1.
//   lfsr    (stateful designs)   an n-bit LFSR steps through its 2^n-1 non-zero states from reset,
//                                so every beat sees a new input and the design's state evolves
//                                between beats. (The all-zero input is not applied in this mode.)
//   frames  (official vectors)   a caller-supplied list of vectors, each a sequence of per-cycle
//                                input frames starting from reset. The design's state is reset at
//                                the first frame of every vector, so vectors do not leak state into
//                                each other. This is how FabX's per-cycle official vectors are
//                                replayed: vector 17 cycle 4, not just "some input", is the
//                                failure a stateful miner is caught on.
//
// Input i of the design is bit i of the counter or LFSR state, or bit i of the current frame.
//
// Bench outputs:
//   count/lfsr (nOut = n + 2): [mismatch, firstInput[0..n-1], done]
//   frames    (nOut = 2 + v + c): [mismatch, firstVector[0..v-1], firstCycle[0..c-1], done]
//   mismatch  1 if any beat so far (this one included) had different outputs
//   first     the input (count/lfsr) or the vector index and cycle (frames) of the first failing
//             beat (all 0 if none)
//   done      1 on the last beat. After `beats` beats the outputs are the verdict.
//
// Bench state (LATCHes, in order):
//   count/lfsr: counter/LFSR[n], mismatch, firstInput[n], design state, reference state.
//   frames:     one frame-selection latch per beat, mismatch, vectorIndex[v], cycleIndex[c],
//               design state, reference state (or no reference state with expected-output vectors).
// The job's starting state is benchState(): the LFSR seed (1) or the one-hot first frame, zeros,
// and each side's reset state. Frames mode inlines the design and reference logic so their state
// can be reset at a vector boundary; a REF's state cannot be overwritten from the outside.

import { Builder, encode } from './hdl.js';
import { load, beat, decode, LATCH, NAND, REF } from './tap02.js';

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

// desc: { cpu, id, nIn, nOut, nState = 0, reset = [], circuit? } for the design and the reference.
// `circuit` is a loaded circuit (src/tap02.js load) used by frames mode, which inlines the logic so
// state can be reset between vectors. Other modes use the REF (cpu, id).
export function benchCircuit(design, reference, { mode, vectors } = {}) {
  const n = design.nIn;
  if (!(n >= 1 && n <= 24)) throw new Error('bench needs 1..24 design inputs');
  if (reference.nIn !== n || reference.nOut !== design.nOut) throw new Error('design and reference must have the same inputs and outputs');
  const dState = design.nState ?? 0, rState = reference.nState ?? 0;
  mode ??= vectors ? 'frames' : dState || rState ? 'lfsr' : 'count';
  if (mode === 'frames') return framesBenchCircuit(design, reference, vectors);

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

// Acceptance 2d: inline a loaded circuit into the bench. REFs would keep their own state opaque,
// and frames mode has to overwrite that state at every vector boundary, so the design and reference
// are flattened into the bench instead. State is consumed in the same order as load()'s stateBase.
function inlineCircuit(b, c, inputs, reset, resetSel, cursor) {
  const map = new Array(c.nSignals);
  map[0] = 0; map[1] = 1;
  inputs.forEach((s, i) => { map[2 + i] = s; });
  const pending = [];
  for (const e of c.elements) {
    if (e.op === NAND) map[e.firstOut] = b.nand(map[e.ins[0]], map[e.ins[1]]);
    else if (e.op === LATCH) {
      const q = b.latch();
      map[e.firstOut] = q;
      // A LATCH may read a signal produced later in the same block (feedback), so resolve its D
      // input after every element has been emitted.
      pending.push({ q, src: e.ins[0], reset: reset?.[cursor.i] ?? 0 });
      cursor.i++;
    } else {
      const sub = inlineCircuit(b, e.sub, e.ins.map((s) => map[s]), reset, resetSel, cursor);
      sub.outs.forEach((s, i) => { map[e.firstOut + i] = s; });
    }
  }
  for (const p of pending) b.setLatch(p.q, mux(b, resetSel, p.reset, map[p.src]));
  const outs = Array.from({ length: c.nOut }, (_, i) => map[c.nSignals - c.nOut + i]);
  return { outs, nState: cursor.i };
}

const mux = (b, sel, a, c) => b.nand(b.nand(a, sel), b.nand(c, b.not(sel))); // sel ? a : c

// frames mode: replay a list of vectors, each a sequence of per-cycle frames from reset.
// vectors: [{ frames: [[bit...], ...], expected?: [[bit...], ...] }] or a bare array of frames.
// With no expected outputs the design is compared with the reference every cycle; when every
// vector carries expected outputs those are the oracle instead (the reference is then not run).
function framesBenchCircuit(design, reference, vectors) {
  const n = design.nIn, nOut = design.nOut;
  if (!(n >= 1 && n <= 24)) throw new Error('bench needs 1..24 design inputs');
  if (!Array.isArray(vectors) || vectors.length === 0) throw new Error('frames mode needs at least one vector');
  const norm = vectors.map((v, i) => {
    const frames = Array.isArray(v) ? v : v?.frames;
    const expected = Array.isArray(v) ? null : v?.expected ?? null;
    if (!Array.isArray(frames) || frames.length === 0) throw new Error(`frames vector ${i} needs at least one frame`);
    frames.forEach((f, k) => {
      if (!Array.isArray(f) || f.length !== n) throw new Error(`frames vector ${i} frame ${k} must have ${n} input bits`);
      if (f.some((x) => x !== 0 && x !== 1)) throw new Error(`frames vector ${i} frame ${k} has a non-bit input`);
    });
    if (expected !== null) {
      if (!Array.isArray(expected) || expected.length !== frames.length) throw new Error(`frames vector ${i} needs ${frames.length} expected frames`);
      expected.forEach((f, k) => {
        if (!Array.isArray(f) || f.length !== nOut) throw new Error(`frames vector ${i} expected frame ${k} must have ${nOut} output bits`);
        if (f.some((x) => x !== 0 && x !== 1)) throw new Error(`frames vector ${i} expected frame ${k} has a non-bit output`);
      });
    }
    return { index: Array.isArray(v) ? i : v?.index ?? i, frames, expected };
  });
  const withExpected = norm.filter((v) => v.expected).length;
  if (withExpected && withExpected !== norm.length) throw new Error('frames mode needs expected outputs on every vector or on none');
  const oracle = withExpected ? 'expected' : 'reference';
  const total = norm.reduce((s, v) => s + v.frames.length, 0);
  if (total > 2 ** 16) throw new Error('frames bench needs a short frame sequence');
  const maxFrames = Math.max(...norm.map((v) => v.frames.length));
  const vectorBits = Math.max(1, Math.ceil(Math.log2(norm.length)));
  const cycleBits = Math.max(1, Math.ceil(Math.log2(maxFrames)));

  const b = new Builder(0);
  const L = (k) => Array.from({ length: k }, () => b.latch());
  // One-hot frame selector: sel[s] is 1 on beat s. A shift register is much cheaper than a
  // counter-plus-address-decoder ROM once the vector list is hundreds of frames long.
  const sel = L(total);
  sel.forEach((q, s) => b.setLatch(q, total === 1 ? b.one : s === 0 ? b.zero : sel[s - 1]));
  const orAll = (terms) => (terms.length ? terms.reduce((x, y) => b.or(x, y)) : b.zero);

  const starts = [];
  const bitsOn = Array.from({ length: n }, () => []);
  const expectsOn = oracle === 'expected' ? Array.from({ length: nOut }, () => []) : null;
  let step = 0;
  for (const v of norm) {
    starts.push(step);
    v.frames.forEach((f, k) => {
      f.forEach((bit, i) => { if (bit) bitsOn[i].push(step); });
      if (expectsOn) v.expected[k].forEach((bit, i) => { if (bit) expectsOn[i].push(step); });
      step++;
    });
  }
  const ins = bitsOn.map((steps) => orAll(steps.map((s) => sel[s])));
  const first = orAll(starts.map((s) => sel[s])); // first frame of a vector, including step 0
  const stepZero = sel[0];
  const notFirst = b.not(first);
  // The design's state is loaded with its reset value on the beat BEFORE a vector starts, so the
  // boundary beat itself computes from reset state while still advancing that state normally.
  const resetNext = orAll(starts.filter((s) => s > 0).map((s) => sel[s - 1]));

  // Vector/cycle indices of the current beat. The state latches hold the *next* beat's indices;
  // at a boundary beat the current index is the corrected (incremented or zeroed) value.
  const vc = L(vectorBits), cc = L(cycleBits);
  const inc = (bits) => { let carry = b.one; return bits.map((q) => { const [s, c] = b.halfAdd(q, carry); carry = c; return s; }); };
  const vcInc = inc(vc), ccInc = inc(cc);
  const curVec = vc.map((q, i) => mux(b, first, b.and(vcInc[i], b.not(stepZero)), q));
  const curCycle = cc.map((q) => b.and(q, notFirst));
  // The state holds the NEXT beat's cycle: the boundary beat is cycle 0 and the next one cycle 1.
  const nextCycle = ccInc.map((x, i) => mux(b, first, i === 0 ? b.one : b.zero, x));
  vc.forEach((q, i) => b.setLatch(q, curVec[i]));
  cc.forEach((q, i) => b.setLatch(q, nextCycle[i]));

  const dState = design.nState ?? 0, rState = reference.nState ?? 0;
  if (!design.circuit || (oracle === 'reference' && !reference.circuit)) {
    throw new Error('frames mode needs loaded `circuit` descriptors so it can reset design state');
  }
  // Harness state latches come before the inlined design/reference state, matching `layout`.
  const mm = b.latch(), firstVecQ = L(vectorBits), firstCycleQ = L(cycleBits);
  const dSide = inlineCircuit(b, design.circuit, ins, design.reset, resetNext, { i: 0 });
  if (dSide.nState !== dState) throw new Error(`design inlined ${dSide.nState} state bits, descriptor says ${dState}`);
  let rOut = null;
  if (oracle === 'reference') {
    const rSide = inlineCircuit(b, reference.circuit, ins, reference.reset, resetNext, { i: 0 });
    if (rSide.nState !== rState) throw new Error(`reference inlined ${rSide.nState} state bits, descriptor says ${rState}`);
    rOut = rSide.outs;
  } else {
    rOut = expectsOn.map((steps) => orAll(steps.map((s) => sel[s])));
  }

  const diff = dSide.outs.map((x, i) => b.xor(x, rOut[i])).reduce((x, y) => b.or(x, y));
  const mmNext = b.or(mm, diff);
  b.setLatch(mm, mmNext);
  const capture = b.and(diff, b.not(mm)); // the first beat that differs
  const latchIndex = (bits, current) => bits.map((q, i) => {
    const nx = mux(b, capture, current[i], q);
    b.setLatch(q, nx);
    return nx;
  });
  const firstVec = latchIndex(firstVecQ, curVec);
  const firstCycle = latchIndex(firstCycleQ, curCycle);
  const done = sel[total - 1];
  const built = b.build([mmNext, ...firstVec, ...firstCycle, done]);
  const layout = {
    sel: 0,
    mm: total,
    vector: total + 1,
    cycle: total + 1 + vectorBits,
    firstVector: total + 1 + vectorBits + cycleBits,
    firstCycle: total + 1 + 2 * vectorBits + cycleBits,
    design: total + 1 + 2 * (vectorBits + cycleBits),
  };
  if (oracle === 'reference') layout.reference = layout.design + dState;
  return {
    ...built,
    beats: total,
    mode: 'frames',
    n: vectorBits,
    nIn: 0,
    inputBits: n,
    counterBits: vectorBits,
    vectorBits,
    cycleBits,
    vectors: norm,
    oracle,
    design,
    reference,
    signals: { diff, mmNext },
    layout,
  };
}

// The job's starting state, as bits: LFSR seed / one-hot first frame, cleared verdict, each side's
// reset state (frames mode has no reference state when expected outputs are the oracle).
export function benchState(bench) {
  const { n, mode, design, reference, layout } = bench;
  const dState = design.nState ?? 0, rState = reference.nState ?? 0;
  const pad = (r, k) => Array.from({ length: k }, (_, i) => r?.[i] ?? 0);
  if (mode === 'frames') {
    const sel = Array.from({ length: bench.beats }, (_, i) => (i === 0 ? 1 : 0));
    return [
      ...sel, 0,
      ...new Array(bench.vectorBits).fill(0), ...new Array(bench.cycleBits).fill(0),
      ...new Array(bench.vectorBits).fill(0), ...new Array(bench.cycleBits).fill(0),
      ...pad(design.reset, dState), ...(bench.oracle === 'reference' ? pad(reference.reset, rState) : []),
    ];
  }
  return [...bitsOf(mode === 'lfsr' ? 1 : 0, n), 0, ...new Array(n).fill(0), ...pad(design.reset, dState), ...pad(reference.reset, rState)];
}

// Read a bench's output bits (or the packed result) as a verdict.
export function verdict(outputs, n) {
  return { mismatch: outputs[0] === 1, firstInput: outputs[0] ? valueOf(outputs.slice(1, 1 + n)) : null, done: outputs[n + 1] === 1 };
}

// The frames-mode verdict: the first failing vector index and cycle within that vector.
export function framesVerdict(outputs, bench) {
  const v = bench.vectorBits, c = bench.cycleBits;
  return {
    mismatch: outputs[0] === 1,
    firstVector: outputs[0] ? valueOf(outputs.slice(1, 1 + v)) : null,
    firstCycle: outputs[0] ? valueOf(outputs.slice(1 + v, 1 + v + c)) : null,
    done: outputs[v + c + 1] === 1,
  };
}

// Off-chain expected verdict, computed with src/tap02.js: run design and reference side by side.
// resolve(cpu, id) -> loaded circuit. Returns { mismatch, firstInput, firstBeat, mismatches, beats, outputs }
// where `outputs` are the bench outputs the job should end with and `mismatches` counts failing beats.
export function expectedVerdict(bench, resolve) {
  const { n, mode, beats, design, reference } = bench;
  if (mode === 'frames') return expectedFramesVerdict(bench, resolve);
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

// Off-chain replay of the frames bench: reset both sides at every vector, compare per cycle.
function expectedFramesVerdict(bench, resolve) {
  const { design, reference, layout, oracle, vectors } = bench;
  const d = design.circuit ?? resolve(design.cpu, BigInt(design.id));
  const r = oracle === 'reference' ? reference.circuit ?? resolve(reference.cpu, BigInt(reference.id)) : null;
  const start = benchState(bench);
  const dReset = start.slice(layout.design, oracle === 'reference' ? layout.reference : start.length);
  const rReset = oracle === 'reference' ? start.slice(layout.reference) : null;
  let mismatches = 0, firstVector = null, firstCycle = null;
  for (const [j, v] of vectors.entries()) {
    let ds = dReset.slice(), rs = rReset?.slice();
    for (const [k, frames] of v.frames.entries()) {
      const [dn, dOut] = beat(d, ds, frames);
      ds = dn;
      let ok;
      if (oracle === 'expected') ok = v.expected[k].every((x, i) => x === dOut[i]);
      else {
        const [rn, rOut] = beat(r, rs, frames);
        rs = rn;
        ok = dOut.every((x, i) => x === rOut[i]);
      }
      if (!ok) {
        if (!mismatches) { firstVector = j; firstCycle = k; }
        mismatches++;
      }
    }
  }
  const outputs = [
    mismatches ? 1 : 0,
    ...bitsOf(firstVector ?? 0, bench.vectorBits),
    ...bitsOf(firstCycle ?? 0, bench.cycleBits),
    1,
  ];
  return { mismatch: mismatches > 0, firstVector, firstCycle, firstBeat: firstCycle, mismatches, beats: bench.beats, vectors: vectors.length, outputs };
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
