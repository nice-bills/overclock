// Streaming trace engine: the same traceRoot and the same proofs as trace.js's Tree, without ever
// holding the trace in memory.
//
// How it stays small and fast:
//   - The trace is cut into chunks of 2^chunkBits leaves (65,536 by default). A chunk is hashed to
//     one subtree root and thrown away; only the chunk roots (32 bytes each) and a LATCH-state
//     checkpoint per chunk (the state at the start of the beat the chunk begins in) are kept, in
//     memory and in `dir`. The tree above the chunks is built from the roots.
//   - The bottom four tree levels come from a lookup table: all 2^16 patterns of 16 one-bit leaves,
//     precomputed to their subtree root. That is 1 table read where there were 15 hashes.
//   - Chunks are hashed in worker threads. The state each worker starts from comes from one fast
//     serial pass over the beats (a compiled evaluator, no hashing), pipelined with the workers.
//   - Any node or proof path is recomputed on demand: re-run the one chunk it lives in from its
//     checkpoint. Nodes above the chunks come straight from the kept roots.
//
// Positions, leaf hashes and padding are exactly trace.js's: leaf = keccak256(uint8 bit), padding
// leaves past the trace are bytes32(0), depth = ceil(log2 n).

import { createHash, hash as cryptoHash } from 'node:crypto';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { availableParallelism, tmpdir } from 'node:os';
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { keccak_256 } from '@noble/hashes/sha3';
import { NAND, LATCH } from './tap02.js';
import { flatSize } from './trace.js';

// ------------------------------------------------------------------ hashing

// OpenSSL's keccak-256 is about 5x faster than noble's; fall back to noble if node lacks it.
const nativeOK = (() => {
  try { return Buffer.from(cryptoHash('keccak-256', new Uint8Array(64), 'buffer')).equals(Buffer.from(keccak_256(new Uint8Array(64)))); } catch { return false; }
})();
const H = nativeOK ? (b) => cryptoHash('keccak-256', b, 'buffer') : (b) => Buffer.from(keccak_256(b));

const SCRATCH = Buffer.alloc(64);
const hp = (l, r) => { SCRATCH.set(l, 0); SCRATCH.set(r, 32); return H(SCRATCH); };
const LEAF = [H(new Uint8Array([0])), H(new Uint8Array([1])), Buffer.alloc(32)]; // 0, 1, padding
const toHex = (b) => '0x' + Buffer.from(b.buffer, b.byteOffset, b.length).toString('hex');

// Node of `w` leaves whose values (0, 1 or 2 = padding) are bits[off .. off + w).
function smallNode(bits, off, w) {
  if (w === 1) return LEAF[bits[off]];
  const h = w >> 1;
  return Buffer.from(hp(smallNode(bits, off, h), smallNode(bits, off + h, h)));
}

// Level-4 table: bit j of the index is leaf j of the 16-leaf pattern (leaf 0 is leftmost).
let TABLE = null;
export function buildTable() {
  if (TABLE) return TABLE;
  const up = (prev, bitsPerHalf) => {
    const half = 1 << bitsPerHalf, out = Buffer.alloc((half * half) * 32);
    for (let i = 0; i < half * half; i++) out.set(hp(prev.subarray((i & (half - 1)) * 32, (i & (half - 1)) * 32 + 32), prev.subarray((i >> bitsPerHalf) * 32, (i >> bitsPerHalf) * 32 + 32)), i * 32);
    return out;
  };
  const l0 = Buffer.concat([LEAF[0], LEAF[1]]); // the two possible leaves
  const l1 = up(l0, 1), l2 = up(l1, 2), l3 = up(l2, 4); // every pattern of 2, 4, 8 leaves: 4, 16, 256 nodes
  return (TABLE = up(l3, 8)); // every pattern of 16 leaves: 65,536 nodes
}

// ------------------------------------------------------------------ compiled beat

const K = { ZERO: 0, ONE: 1, IN: 2, NAND: 3, LATCH: 4, COPY: 5 };

// Flatten one beat (the circuit with every REF inlined) into three typed arrays, one entry per
// leaf of the beat's block: what it is, and where in the block (or in the state / inputs) its
// operands are. Mirrors trace.js's run() leaf for leaf.
export function compile(c) {
  if (c._prog) return c._prog;
  const F = flatSize(c), S = c.nState, B = F + S;
  const kind = new Uint8Array(B), X = new Uint32Array(B), Y = new Uint32Array(B), D = new Uint32Array(S);
  const inv = (cc, p, inPos, stOff) => {
    kind[p] = K.ZERO;
    kind[p + 1] = K.ONE;
    const sig = [p, p + 1];
    for (let i = 0; i < cc.nIn; i++) {
      kind[p + 2 + i] = inPos ? K.COPY : K.IN;
      X[p + 2 + i] = inPos ? inPos[i] : i;
      sig.push(p + 2 + i);
    }
    let pos = p + 2 + cc.nIn;
    cc.elements.forEach((e, k) => {
      if (e.op === NAND) {
        kind[pos] = K.NAND; X[pos] = sig[e.ins[0]]; Y[pos] = sig[e.ins[1]];
        sig.push(pos++);
      } else if (e.op === LATCH) {
        kind[pos] = K.LATCH; X[pos] = stOff + cc.stateBase[k];
        sig.push(pos++);
      } else {
        const sub = inv(e.sub, pos, e.ins.map((s) => sig[s]), stOff + cc.stateBase[k]);
        pos += flatSize(e.sub);
        for (let i = 0; i < e.nOut; i++) {
          kind[pos] = K.COPY; X[pos] = sub[sub.length - e.nOut + i];
          sig.push(pos++);
        }
      }
    });
    cc.elements.forEach((e, k) => { if (e.op === LATCH) D[stOff + cc.stateBase[k]] = sig[e.ins[0]]; });
    return sig;
  };
  const top = inv(c, 0, null, 0);
  for (let k = 0; k < S; k++) { kind[F + k] = K.COPY; X[F + k] = D[k]; }
  c._prog = { F, S, B, nIn: c.nIn, kind, X, Y, outPos: Uint32Array.from(top.slice(top.length - c.nOut)) };
  return c._prog;
}

function evalRange(P, buf, st, ins, from, to) {
  const { kind, X, Y } = P;
  for (let j = from; j < to; j++) {
    switch (kind[j]) {
      case 3: buf[j] = 1 - (buf[X[j]] & buf[Y[j]]); break;
      case 5: buf[j] = buf[X[j]]; break;
      case 4: buf[j] = st[X[j]]; break;
      case 2: buf[j] = ins[X[j]]; break;
      case 1: buf[j] = 1; break;
      default: buf[j] = 0;
    }
  }
}

// Walks a job beat by beat. buf holds the current beat's whole block (leaves, then new state).
class Runner {
  constructor(P, { inputs, perBeat, fault, nIn }) {
    this.P = P;
    this.inputs = inputs;
    this.perBeat = perBeat;
    this.fault = fault;
    this.nIn = nIn;
    this.buf = new Uint8Array(P.B);
    this.stIn = new Uint8Array(P.S); // state at the start of beat `cur`
    this.ins = new Uint8Array(nIn);
    this.cur = -1;
  }

  seek(beat, state) {
    this.stIn.set(state);
    this.cur = beat;
    this._eval();
  }

  next() {
    this.stIn.set(this.buf.subarray(this.P.F, this.P.B));
    this.cur++;
    this._eval();
  }

  _eval() {
    const { P, buf, ins, cur } = this;
    if (this.perBeat) for (let i = 0; i < this.nIn; i++) ins[i] = this.inputs[cur * this.nIn + i] ?? 0;
    else ins.set(this.inputs);
    const f = this.fault - cur * P.B;
    if (f >= 0 && f < P.B) {
      evalRange(P, buf, this.stIn, ins, 0, f + 1);
      buf[f] ^= 1;
      evalRange(P, buf, this.stIn, ins, f + 1, P.B);
    } else evalRange(P, buf, this.stIn, ins, 0, P.B);
  }

  // Leaves [start, end) of the trace into dst[0 ..]; start must not be before the current beat.
  fill(dst, start, end) {
    const B = this.P.B;
    for (let g = start; g < end;) {
      const b = Math.floor(g / B);
      while (this.cur < b) this.next();
      const off = g - b * B, m = Math.min(end - g, B - off);
      dst.set(this.buf.subarray(off, off + m), g - start);
      g += m;
    }
  }
}

// ------------------------------------------------------------------ chunks

// Subtree roots of every level from 4 up to chunkBits for the chunk whose leaves are cb
// (values 0, 1, or 2 = past the trace) starting at trace position `start`. Returns an array
// indexed by level - 4 when keep is set, else just the chunk root.
function chunkTree(cb, start, n, chunkBits, table, pad4, keep) {
  const n4 = 1 << (chunkBits - 4);
  let cur = Buffer.allocUnsafe(n4 * 32);
  const whole = start + cb.length <= n;
  for (let blk = 0; blk < n4; blk++) {
    const o = blk * 16, s = start + o;
    if (whole || s + 16 <= n) {
      const p = cb[o] | (cb[o + 1] << 1) | (cb[o + 2] << 2) | (cb[o + 3] << 3) | (cb[o + 4] << 4) | (cb[o + 5] << 5) | (cb[o + 6] << 6) | (cb[o + 7] << 7)
        | (cb[o + 8] << 8) | (cb[o + 9] << 9) | (cb[o + 10] << 10) | (cb[o + 11] << 11) | (cb[o + 12] << 12) | (cb[o + 13] << 13) | (cb[o + 14] << 14) | (cb[o + 15] << 15);
      cur.set(table.subarray(p * 32, p * 32 + 32), blk * 32);
    } else cur.set(s >= n ? pad4 : smallNode(cb, o, 16), blk * 32);
  }
  const levels = [cur];
  for (let count = n4 >> 1; count >= 1; count >>= 1) {
    const out = keep ? Buffer.allocUnsafe(count * 32) : cur;
    for (let i = 0; i < count; i++) out.set(H(cur.subarray(64 * i, 64 * i + 64)), 32 * i);
    cur = out;
    if (keep) levels.push(cur);
  }
  return keep ? levels : cur.subarray(0, 32);
}

const padNodes = (() => { const p = [LEAF[2]]; return (l) => { while (p.length <= l) p.push(Buffer.from(hp(p.at(-1), p.at(-1)))); return p[l]; }; })();

// One task: chunks [c0, c1), starting from the state at the start of the beat chunk c0 begins in.
function runTask(ctx, t) {
  const { P, runner, CH, n, chunkBits, table, pad4 } = ctx;
  const nc = t.c1 - t.c0;
  const roots = new Uint8Array(nc * 32), states = new Uint8Array(nc * P.S), cb = new Uint8Array(CH);
  runner.seek(t.beat, t.state);
  for (let c = t.c0; c < t.c1; c++) {
    const start = c * CH, end = Math.min(start + CH, n);
    while (runner.cur < Math.floor(start / P.B)) runner.next();
    states.set(runner.stIn, (c - t.c0) * P.S);
    runner.fill(cb, start, end);
    cb.fill(2, end - start);
    roots.set(chunkTree(cb, start, n, chunkBits, table, pad4, false), (c - t.c0) * 32);
  }
  return { roots, states };
}

const mkCtx = (w) => ({
  P: w.P, CH: 2 ** w.chunkBits, n: w.n, chunkBits: w.chunkBits, table: w.table, pad4: padNodes(4),
  runner: new Runner(w.P, w),
});

if (!isMainThread && workerData?.overclockStream) {
  const ctx = mkCtx(workerData);
  parentPort.on('message', (t) => {
    const r = runTask(ctx, t);
    parentPort.postMessage({ id: t.id, ...r }, [r.roots.buffer, r.states.buffer]);
  });
}

// ------------------------------------------------------------------ the trace

const VERSION = 1;

export class StreamTrace {
  // c: loaded circuit. opts: { state, inputs, beats, perBeat, fault } as for traceJob, plus
  //   dir      where checkpoints are kept, one folder per distinct trace (an identical build is reused)
  //   workers  worker threads (default: one per core; 0 = run in this thread)
  //   chunkBits  log2 of the chunk size (default 16 = 65,536 leaves)
  //   taskChunks chunks handed to a worker at a time
  //   onProgress(doneChunks, totalChunks)
  static async build(c, opts = {}) {
    const { state = [], inputs = [], beats = 1, perBeat = false, fault = -1, chunkBits = 16, dir = null, workers = availableParallelism(), taskChunks = 8, onProgress } = opts;
    if (chunkBits < 4) throw new Error('chunkBits must be at least 4');
    const P = compile(c);
    const st0 = new Uint8Array(P.S);
    for (let i = 0; i < P.S; i++) st0[i] = state[i] ?? 0;
    const inp = new Uint8Array(perBeat ? beats * P.nIn : P.nIn);
    for (let i = 0; i < inp.length; i++) inp[i] = inputs[i] ?? 0;
    const n = beats * P.B, CH = 2 ** chunkBits, nChunks = Math.ceil(n / CH);
    const key = createHash('sha256')
      .update(JSON.stringify([VERSION, beats, perBeat, fault, chunkBits, P.F, P.S, P.nIn]))
      .update(P.kind).update(P.X).update(P.Y).update(inp).update(st0).digest('hex');
    const self = new StreamTrace();
    Object.assign(self, { c, P, n, beats, perBeat, fault, chunkBits, CH, nChunks, inp, key, st0, dir: dir && join(dir, key.slice(0, 16)) });
    self.depth = 0;
    while (2 ** self.depth < n) self.depth++;
    self.table = buildTable();
    self.cache = new Map();
    self.runner = new Runner(P, { inputs: inp, perBeat, fault, nIn: P.nIn });
    if (self.dir && self._load()) return self;
    await self._compute({ workers, taskChunks, onProgress });
    self._upper();
    if (self.dir) self._save();
    return self;
  }

  async _compute({ workers, taskChunks, onProgress }) {
    const { P, n, CH, chunkBits, nChunks, beats } = this;
    const roots = this.roots = Buffer.alloc(nChunks * 32);
    const states = this.states = new Uint8Array(nChunks * P.S);
    const w = { P, n, chunkBits, table: this.table, inputs: this.inp, perBeat: this.perBeat, fault: this.fault, nIn: P.nIn, overclockStream: true };
    const nTasks = Math.ceil(nChunks / taskChunks);
    let done = 0, failure = null;
    const store = (t, r) => {
      roots.set(r.roots, t.c0 * 32);
      states.set(r.states, t.c0 * P.S);
      done += t.c1 - t.c0;
      onProgress?.(done, nChunks);
    };
    const pool = [], free = [], pending = new Map();
    let wake = null;
    const nWorkers = Math.min(workers, nTasks);
    for (let i = 0; i < nWorkers; i++) {
      const wk = new Worker(new URL(import.meta.url), { workerData: w });
      wk.on('message', (m) => { store(pending.get(m.id), m); pending.delete(m.id); free.push(wk); wake?.(); });
      wk.on('error', (e) => { failure = e; wake?.(); });
      pool.push(wk);
      free.push(wk);
    }
    const inline = nWorkers === 0 ? mkCtx(w) : null;
    // the serial pass: a fast evaluator, no hashing, handing each task its starting state
    const r = new Runner(P, { inputs: this.inp, perBeat: this.perBeat, fault: this.fault, nIn: P.nIn });
    try {
      for (let id = 0; id < nTasks; id++) {
        const c0 = id * taskChunks, c1 = Math.min(c0 + taskChunks, nChunks), beat = Math.floor((c0 * CH) / P.B);
        if (r.cur < 0) r.seek(beat, this.st0);
        while (r.cur < beat) r.next();
        const t = { id, c0, c1, beat, state: r.stIn.slice() };
        if (inline) { store(t, runTask(inline, t)); continue; }
        while (!free.length && !failure) await new Promise((res) => { wake = res; });
        if (failure) throw failure;
        pending.set(id, t);
        free.pop().postMessage(t);
      }
      while (r.cur < beats - 1) r.next();
      this.outputs = Array.from(P.outPos, (p) => r.buf[p]);
      this.newState = Array.from(r.buf.subarray(P.F, P.B));
      while (pending.size && !failure) await new Promise((res) => { wake = res; });
      if (failure) throw failure;
    } finally {
      await Promise.all(pool.map((wk) => wk.terminate()));
    }
  }

  // The tree above the chunks: levels chunkBits .. depth, kept whole (2^(depth - chunkBits) nodes).
  _upper() {
    const { chunkBits, depth, nChunks, roots } = this;
    if (depth < chunkBits) { this.up = null; return; }
    let cur = Buffer.alloc(2 ** (depth - chunkBits) * 32);
    cur.set(roots);
    for (let i = nChunks; i < cur.length / 32; i++) cur.set(padNodes(chunkBits), i * 32);
    this.up = [cur];
    for (let l = chunkBits + 1; l <= depth; l++) {
      const next = Buffer.allocUnsafe(cur.length / 2);
      for (let i = 0; i < next.length / 32; i++) next.set(H(cur.subarray(64 * i, 64 * i + 64)), 32 * i);
      this.up.push(cur = next);
    }
  }

  _save() {
    mkdirSync(this.dir, { recursive: true });
    const meta = { version: VERSION, key: this.key, n: this.n, beats: this.beats, chunkBits: this.chunkBits, nChunks: this.nChunks, depth: this.depth, outputs: this.outputs, newState: this.newState };
    writeFileSync(join(this.dir, 'roots.bin'), this.roots);
    writeFileSync(join(this.dir, 'states.bin'), this.states);
    writeFileSync(join(this.dir, 'meta.json'), JSON.stringify(meta)); // last: its presence means the rest is whole
  }

  _load() {
    try {
      const m = JSON.parse(readFileSync(join(this.dir, 'meta.json'), 'utf8'));
      if (m.key !== this.key) return false;
      this.roots = readFileSync(join(this.dir, 'roots.bin'));
      this.states = new Uint8Array(readFileSync(join(this.dir, 'states.bin')));
      if (this.roots.length !== this.nChunks * 32 || this.states.length !== this.nChunks * this.P.S) return false;
      this.outputs = m.outputs;
      this.newState = m.newState;
      this.resumed = true;
      this._upper();
      return true;
    } catch { return false; }
  }

  // Delete the checkpoints on disk.
  purge() { if (this.dir) rmSync(this.dir, { recursive: true, force: true }); }

  // Drop the in-memory chunk cache (the checkpoints stay).
  release() { this.cache.clear(); }

  // Leaves of chunk c, re-run from its checkpoint; levels 4.. built when asked.
  _chunk(c, levels = false) {
    let e = this.cache.get(c);
    if (!e) {
      const { P, CH, n, runner } = this;
      const start = c * CH, end = Math.min(start + CH, n);
      runner.seek(Math.floor(start / P.B), this.states.subarray(c * P.S, (c + 1) * P.S));
      const bits = new Uint8Array(CH);
      runner.fill(bits, start, end);
      bits.fill(2, end - start);
      e = { bits, levels: null };
      if (this.cache.size >= 8) this.cache.delete(this.cache.keys().next().value);
    } else this.cache.delete(c);
    this.cache.set(c, e);
    if (levels && !e.levels) e.levels = chunkTree(e.bits, c * this.CH, this.n, this.chunkBits, this.table, padNodes(4), true);
    return e;
  }

  // Leaf bit at trace position pos.
  leaf(pos) {
    if (!(pos >= 0 && pos < this.n)) throw new RangeError(`leaf ${pos} outside the trace`);
    return this._chunk(Math.floor(pos / this.CH)).bits[pos % this.CH];
  }

  _node(level, index) {
    if (level > this.depth) throw new RangeError(`level ${level} above the root (${this.depth})`);
    const first = index * 2 ** level;
    if (first >= this.n) return padNodes(level);
    if (level >= this.chunkBits) return this.up[level - this.chunkBits].subarray(index * 32, index * 32 + 32);
    const c = Math.floor(first / this.CH);
    if (level < 4) return smallNode(this._chunk(c).bits, first - c * this.CH, 2 ** level);
    const e = this._chunk(c, true), local = index - c * 2 ** (this.chunkBits - level);
    return e.levels[level - 4].subarray(local * 32, local * 32 + 32);
  }

  node(level, index) { return toHex(this._node(level, index)); }

  get root() { return this.node(this.depth, 0); }

  proof(index) {
    const sib = [];
    for (let d = 0; d < this.depth; d++) {
      sib.push(this.node(d, index % 2 === 0 ? index + 1 : index - 1));
      index = Math.floor(index / 2);
    }
    return sib;
  }
}

// What Operator/Challenger in agents.js expect from a trace: { t, tree, c, ms }, where t has
// n, outputs, newState and leaves[pos].
export async function streamedTrace(c, job, opts = {}) {
  const started = Date.now();
  const { fault = -1, ...rest } = opts;
  const tree = await StreamTrace.build(c, { state: job.stateBits, inputs: job.inputBits, beats: job.beats, perBeat: job.perBeat, fault, dir: join(tmpdir(), 'overclock-stream'), ...rest });
  const leaves = new Proxy({}, { get: (_, k) => (typeof k === 'string' && /^\d+$/.test(k) ? tree.leaf(Number(k)) : undefined) });
  return { t: { n: tree.n, outputs: tree.outputs, newState: tree.newState, leaves }, tree, c, ms: Date.now() - started };
}

