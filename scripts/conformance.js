// Conformance sweep: our TAP-02 evaluator (src/tap02.js) against TapeOut's own eval()/step() on
// EVERY X Layer mainnet circuit that fits one eval/step call. Read-only: free RPC reads only, no
// transactions, no keys. Extends the idea of scripts/verify-live.js (which samples 86 circuits)
// to the whole chain, the way scripts/census.js walks it.
//
//   node scripts/conformance.js [--samples 4] [--max-gates 18000] [--limit N] [--fresh]
//        [--out docs/conformance.json] [--rpc https://rpc.xlayer.tech] [--budget 40000000]
//        [--wave 40] [--netlist-bytes 524288] [--delay 50] [--chunk 400] [--seed 788604]
//        [--only 0xADDR --id N]   re-check one circuit verbosely, for minimising a mismatch
//
// The circuit universe is enumerated live the same way census.js does it (factory -> processors ->
// nextId -> circuitInfo) through Multicall3, in a few dozen eth_calls. docs/census.json is used for
// processor names and as a staleness cross-check only: it stores just the featured/tooBig/heldBack
// subsets and is stale by the time this runs. Sample inputs come from a per-circuit seeded LCG, so
// any circuit's samples are reproducible in isolation (--only sees exactly what the sweep saw).
//
// Batching: every read goes through Multicall3 (0xcA11...CA11) in gas-budgeted groups. A sub-call
// that the eth_call gas cap cuts off looks identical to a revert (success=false), so every failed
// slot is re-checked individually before it is recorded as an error. The free RPC's eth_call cap
// measured ~46-57M gas on 17 Nov 2026 (a batch of 4 x 11.4M-gate steps passes, 5 does not), so a
// single eval/step tops out around 18K gates: circuits above --max-gates are skipped with a reason,
// not silently.
//
// Resumable: the checkpoint is docs/conformance.json itself, written atomically (tmp + rename)
// after every wave and on SIGINT/SIGTERM. A rerun continues where the last one stopped; --fresh
// starts over; --limit caps how many NEW circuits this run checks.
//
// Results (docs/conformance.json): { summary, results: [{ processor, id, nIn, nOut, nState, gates,
// refs, samples, matches, mismatches?: [{sample, inputs, state?, expected, got, expectedState?,
// gotState?}], errors?: [{sample, error}] }] }. Any mismatch also writes docs/conformance-mismatch.md
// with a greedy-minimised failing input and the exact JSON-RPC reproduction.

import { JsonRpcProvider, Contract, Interface } from 'ethers';
import { readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { beat, pack, decode, load, hexToBytes, bytesToHex, REF } from '../src/tap02.js';
import { XLAYER, FACTORY_ABI } from '../src/tapeout.js';

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const AGGREGATE3_ABI = ['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) view returns ((bool success, bytes returnData)[])'];
export const GAS_PER_GATE = 2400; // census.js's cheapest measured per flattened gate
export const CALL_GAS_PER_GATE = 2500; // tapeout-notes.md: step is ~50K + 2.5K gas per flattened gate
export const CALL_BASE_GAS = 50_000;
export const BLOCK_GAS = 210_000_000;
const EVAL = 'eval', STEP = 'step';
export const IFACES = {
  [EVAL]: new Interface(['function eval(uint256 id, bytes inputs) view returns (bytes)']),
  [STEP]: new Interface(['function step(uint256 id, bytes state, bytes inputs) view returns (bytes newState, bytes outputs)']),
  netlist: new Interface(['function netlist(uint256 id) view returns (bytes)']),
  circuitInfo: new Interface(['function circuitInfo(uint256 id) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)']),
  nextId: new Interface(['function nextId() view returns (uint256)']),
  name: new Interface(['function name() view returns (string)']),
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const norm = (h) => String(h ?? '').toLowerCase();
export const errText = (e) => String(e?.shortMessage ?? e?.message ?? e).slice(0, 300);
const RATE_RE = /rate|429|too many|limit|timeout|timed out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|fetch failed|network|bad response|SERVER_ERROR|missing revert data/i;
const retryable = (e) => RATE_RE.test(errText(e)) || e?.statusCode === 429 || e?.statusCode === 503 || e?.code === 'TIMEOUT' || e?.code === 'SERVER_ERROR';

// ---------------------------------------------------------------- deterministic sampling

// Per-bit PRNG. scripts/verify-live.js used an LCG whose low bits collapse to all-zeros for large
// seeds (JS float precision: s*1103515245 exceeds 2^53), which would make nearly every sampled
// input all-zero across the whole sweep. mulberry32 is just as tiny, deterministic, and properly
// balanced (measured: 0.498 bit balance, 195/200 unique 12-bit prefixes across seeds vs 8/200).
export function makeRng(seed = 0x0c10c) {
  let s = ((Number(seed) | 0) + 0x6d2b79f5) | 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) & 1;
  };
}
export function rngBits(rng, n) { return Array.from({ length: n }, rng); }

// Per-circuit seed: samples for (addr, id) are the same no matter when or in what order we check
// them, so a resumed sweep and a standalone --only repro see identical inputs.
export function circuitSeed(baseSeed, addr, id) {
  let h = 2166136261 >>> 0;
  for (const c of `${String(addr).toLowerCase()}:${BigInt(id)}`) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619) >>> 0; }
  return (Number(baseSeed) ^ h) & 0x7fffffff;
}

// What we feed the chain and what our evaluator says must come back, for one circuit.
export function planSamples(circuit, samples, rng) {
  const planned = [];
  for (let s = 0; s < samples; s++) {
    const inputs = rngBits(rng, circuit.nIn);
    const state = rngBits(rng, circuit.nState);
    const [ns, outs] = beat(circuit, state, inputs);
    planned.push({
      inputs, state,
      inputsHex: bytesToHex(pack(inputs)),
      stateHex: bytesToHex(pack(state)),
      expectedOuts: bytesToHex(pack(outs)),
      expectedState: bytesToHex(pack(ns)),
    });
  }
  return planned;
}
export const planSamplesFor = (circuit, samples, seed, addr, id) => planSamples(circuit, samples, makeRng(circuitSeed(seed, addr, id)));

// ---------------------------------------------------------------- eligibility and ordering

export const callGasEstimate = (gates) => CALL_BASE_GAS + gates * CALL_GAS_PER_GATE;

// null = check it; a string = skip it, with the reason recorded in the summary.
export function isEligible(info, maxGates) {
  if (!info) return 'circuitInfo unavailable';
  if (!(info.nOut >= 1)) return 'no outputs';
  if (info.gates > maxGates) return `more than ${maxGates} gates`;
  if (info.nState > 1 << 24 || info.nIn > 1 << 16) return 'pins or state out of TAP-02 range';
  return null;
}

// Order so a partial run covers every processor early: everyone's first circuit, then everyone's
// second, and so on. Within a processor, ids ascending.
export function orderRoundRobin(rows) {
  const byCpu = new Map();
  for (const r of rows) {
    const k = String(r.processor).toLowerCase();
    if (!byCpu.has(k)) byCpu.set(k, []);
    byCpu.get(k).push(r);
  }
  const lists = [...byCpu.values()].map((l) => l.sort((a, b) => a.id - b.id));
  const out = [];
  for (let round = 0; ; round++) {
    let any = false;
    for (const l of lists) if (l.length > round) { out.push(l[round]); any = true; }
    if (!any) return out;
  }
}

// ---------------------------------------------------------------- paced transport with retries

export function makePacer(delayMs = 0) {
  let last = 0, d = Math.max(0, delayMs);
  return {
    async tick() {
      const wait = last + d - Date.now();
      if (wait > 0) await sleep(wait);
      last = Date.now();
    },
    penalize() { d = Math.min(Math.max(d * 2, 100), 5000); },
    relax() { d = d <= 100 ? Math.max(0, delayMs) : Math.floor(d * 0.8); },
    get delay() { return d; },
  };
}

// Retry only what a public RPC plausibly recovers from; a revert (a real circuit answer) rethrows.
export async function withRetry(fn, opts = {}, onBackoff = null) {
  const tries = opts.retries ?? 6, base = opts.backoffMs ?? 500;
  for (let t = 0; ; t++) {
    try { return await fn(); } catch (e) {
      if (t >= tries || !retryable(e)) throw e;
      onBackoff?.(t, errText(e));
      await sleep(base * 2 ** t + Math.floor(Math.random() * 250));
    }
  }
}

// [[target, iface, fnName, args]] -> decoded result or null per slot, in chunked aggregate3 calls.
export async function multicall(provider, calls, { chunk = 400, pacer = null, retries = 6, onBackoff = null } = {}) {
  const mc = new Contract(MULTICALL3, AGGREGATE3_ABI, provider);
  const out = new Array(calls.length).fill(null);
  for (let i = 0; i < calls.length; i += chunk) {
    const part = calls.slice(i, i + chunk);
    let res;
    for (let t = 0; ; t++) {
      try {
        if (pacer) await pacer.tick();
        res = await mc.aggregate3(part.map(([target, I, f, a]) => ({ target, allowFailure: true, callData: I.encodeFunctionData(f, a) })));
        break;
      } catch (e) {
        if (t >= retries || !retryable(e)) throw e;
        onBackoff?.(t, errText(e));
        await sleep(500 * 2 ** t + Math.floor(Math.random() * 250));
      }
    }
    res.forEach(([ok, data], k) => {
      try { out[i + k] = ok ? part[k][1].decodeFunctionResult(part[k][2], data) : null; } catch { out[i + k] = null; }
    });
  }
  return out;
}

// ---------------------------------------------------------------- oracles

// The chain, as the sweep sees it. Individual calls return exactly what the contract returns
// (hex for eval, [newState, outputs] for step); batch calls return per-slot envelopes
// { ok, hex } / { ok, state, outs } or { ok: false, error }.
export class ChainOracle {
  constructor(provider, { budgetGas = 40_000_000, pacer = makePacer(0) } = {}) {
    this.p = provider;
    this.mc = new Contract(MULTICALL3, AGGREGATE3_ABI, provider);
    this.contracts = new Map();
    this.budgetGas = budgetGas;
    this.pacer = pacer;
    this.okStreak = 0;
    this.stats = { rpcCalls: 0, multicallSlots: 0, backoffs: 0 };
  }
  contract(addr) {
    if (!this.contracts.has(addr)) this.contracts.set(addr, new Contract(addr, ['function eval(uint256 id, bytes inputs) view returns (bytes)', 'function step(uint256 id, bytes state, bytes inputs) view returns (bytes newState, bytes outputs)'], this.p));
    return this.contracts.get(addr);
  }
  backoff() { this.stats.backoffs++; this.pacer.penalize(); this.okStreak = 0; }
  async send(fn) {
    await this.pacer.tick();
    this.stats.rpcCalls++;
    const r = await fn();
    if (++this.okStreak >= 50) { this.pacer.relax(); this.okStreak = 0; }
    return r;
  }
  async eval(addr, id, inputsHex) {
    return norm(await this.send(() => withRetry(() => this.contract(addr).eval(id, inputsHex), {}, () => this.backoff())));
  }
  async step(addr, id, stateHex, inputsHex) {
    const [ns, outs] = await this.send(() => withRetry(() => this.contract(addr).step(id, stateHex, inputsHex), {}, () => this.backoff()));
    return [norm(ns), norm(outs)];
  }
  // One aggregate3 for the whole list (runJobs keeps lists within the gas budget). Slots answered
  // with success=false are NOT trusted here: runJobs re-verifies each one individually, because a
  // gas-cap cut and a genuine revert are indistinguishable inside a batch.
  async evalMany(list) {
    const res = await this.send(() => withRetry(() => this.mc.aggregate3(list.map((j) => ({ target: j.addr, allowFailure: true, callData: IFACES[EVAL].encodeFunctionData(EVAL, [j.id, j.inputsHex]) }))), {}, () => this.backoff()));
    this.stats.multicallSlots += list.length;
    return res.map(([ok, data]) => (ok ? { ok: true, hex: norm(IFACES[EVAL].decodeFunctionResult(EVAL, data)[0]) } : { ok: false, error: 'reverted or out of gas' }));
  }
  async stepMany(list) {
    const res = await this.send(() => withRetry(() => this.mc.aggregate3(list.map((j) => ({ target: j.addr, allowFailure: true, callData: IFACES[STEP].encodeFunctionData(STEP, [j.id, j.stateHex, j.inputsHex]) }))), {}, () => this.backoff()));
    this.stats.multicallSlots += list.length;
    return res.map(([ok, data]) => {
      if (!ok) return { ok: false, error: 'reverted or out of gas' };
      const [ns, outs] = IFACES[STEP].decodeFunctionResult(STEP, data);
      return { ok: true, state: norm(ns), outs: norm(outs) };
    });
  }
}

// Batched netlist reader: groups netlist(id) reads into aggregate3 calls bounded by response bytes.
export class NetlistReader {
  constructor(provider, { chunk = 400, bytes = 524_288, pacer = makePacer(0) } = {}) {
    this.p = provider;
    this.mc = new Contract(MULTICALL3, AGGREGATE3_ABI, provider);
    this.contracts = new Map();
    this.chunk = chunk;
    this.bytes = bytes;
    this.pacer = pacer;
    this.okStreak = 0;
    this.stats = { rpcCalls: 0, netlistsRead: 0, bytesRead: 0, individualFallbacks: 0 };
  }
  contract(addr) {
    if (!this.contracts.has(addr)) this.contracts.set(addr, new Contract(addr, ['function netlist(uint256 id) view returns (bytes)'], this.p));
    return this.contracts.get(addr);
  }
  async send(fn) {
    await this.pacer.tick();
    this.stats.rpcCalls++;
    const r = await fn();
    if (++this.okStreak >= 50) { this.pacer.relax(); this.okStreak = 0; }
    return r;
  }
  // Fills netlistHex (or error) on every item: multicall first, one individual re-check per failed
  // slot, full individual fallback when the whole batch is rejected (e.g. no Multicall3 on ganache).
  async fetch(items) {
    const todo = items.filter((it) => it.netlistHex === undefined && !it.error);
    // estBytes is a loose upper bound (NAND=7B > LATCH=4B; REF-heavy netlists are far smaller than
    // 7x flattened gates), so this only over-splits batches, never overflows the response.
    const est = (it) => Math.min(7 * (it.info?.gates ?? 1), this.bytes);
    let cur = [], curBytes = 0;
    const batches = [];
    for (const it of todo) {
      const b = est(it);
      if (cur.length && (cur.length >= this.chunk || curBytes + b > this.bytes)) { batches.push(cur); cur = []; curBytes = 0; }
      cur.push(it); curBytes += b;
    }
    if (cur.length) batches.push(cur);
    for (const batch of batches) {
      try {
        const res = await this.send(() => withRetry(() => this.mc.aggregate3(batch.map((it) => ({ target: it.addr, allowFailure: true, callData: IFACES.netlist.encodeFunctionData('netlist', [it.id]) }))), {}, () => this.pacer.penalize()));
        for (let i = 0; i < batch.length; i++) {
          const [ok, data] = res[i];
          if (ok) {
            try {
              batch[i].netlistHex = norm(IFACES.netlist.decodeFunctionResult('netlist', data)[0]);
              this.stats.netlistsRead++;
              this.stats.bytesRead += (batch[i].netlistHex.length - 2) / 2;
            } catch { /* empty or undecodable: re-check individually below */ }
          }
          if (batch[i].netlistHex === undefined && !batch[i].error) await this.individual(batch[i]);
        }
      } catch { /* Multicall3 missing on this chain, or the batch exceeded a node limit */ }
      for (const it of batch) if (it.netlistHex === undefined && !it.error) await this.individual(it);
    }
  }
  async individual(it) {
    try {
      this.stats.individualFallbacks++;
      it.netlistHex = norm(await this.send(() => withRetry(() => this.contract(it.addr).netlist(it.id), {}, () => this.pacer.penalize())));
      this.stats.netlistsRead++;
      this.stats.bytesRead += (it.netlistHex.length - 2) / 2;
    } catch (e) { it.error = `netlist: ${errText(e)}`; }
  }
}

// ---------------------------------------------------------------- running the samples

// Group jobs into aggregate3-sized splits, run them, re-verify every failed slot individually (a
// gas-cap cut and a revert look identical inside a batch), and fall back to individual calls when
// a whole batch is rejected. Works with any oracle; batch methods are optional.
async function runJobs(oracle, kind, jobs, budgetGas) {
  if (!jobs.length) return [];
  const many = kind === EVAL ? oracle.evalMany?.bind(oracle) : oracle.stepMany?.bind(oracle);
  const one = (j) => (kind === EVAL ? oracle.eval(j.addr, j.id, j.inputsHex) : oracle.step(j.addr, j.id, j.stateHex, j.inputsHex));
  const wrap = (v) => (kind === EVAL ? { ok: true, hex: norm(v) } : { ok: true, state: norm(v[0]), outs: norm(v[1]) });
  if (!many) {
    const out = [];
    for (const j of jobs) { try { out.push(wrap(await one(j))); } catch (e) { out.push({ ok: false, error: errText(e) }); } }
    return out;
  }
  const splits = [];
  let cur = [], curGas = 0;
  for (const j of jobs) {
    const g = callGasEstimate(j.gates);
    if (cur.length && curGas + g > budgetGas) { splits.push(cur); cur = []; curGas = 0; }
    cur.push(j); curGas += g;
  }
  if (cur.length) splits.push(cur);
  const out = [];
  for (const split of splits) {
    let res = null, ok = false;
    try { res = await many(split); ok = Array.isArray(res) && res.length === split.length; } catch { /* fall through to individuals */ }
    if (ok) {
      for (let i = 0; i < split.length; i++) {
        if (res[i]?.ok) { out.push(res[i]); continue; }
        try { out.push(wrap(await one(split[i]))); } catch (e) { out.push({ ok: false, error: errText(e) }); }
      }
    } else {
      for (const j of split) { try { out.push(wrap(await one(j))); } catch (e) { out.push({ ok: false, error: errText(e) }); } }
    }
  }
  return out;
}

// wave: [{ row: {processor, id, gates, ...}, circuit, planned }] -> one result row per entry, same
// order. Stateless circuits use eval(id, inputs); stateful ones step(id, state, inputs) — the same
// rule scripts/verify-live.js used. Comparison is byte-exact on the packed bytes, lowercased.
export async function checkWave(wave, oracle, { budgetGas = 40_000_000 } = {}) {
  const evalJobs = [], stepJobs = [];
  wave.forEach((w, wi) => {
    const stateless = w.circuit.nState === 0;
    w.planned.forEach((pl, si) => {
      const job = { addr: w.row.processor, id: w.row.id, gates: w.row.gates, wi, si, inputsHex: pl.inputsHex };
      if (!stateless) job.stateHex = pl.stateHex;
      (stateless ? evalJobs : stepJobs).push(job);
    });
  });
  const [evalRes, stepRes] = [await runJobs(oracle, EVAL, evalJobs, budgetGas), await runJobs(oracle, STEP, stepJobs, budgetGas)];
  const results = wave.map((w) => ({ processor: w.row.processor, id: w.row.id, nIn: w.circuit.nIn, nOut: w.circuit.nOut, nState: w.circuit.nState, gates: w.row.gates, samples: w.planned.length, matches: 0, mismatches: [], errors: [] }));
  for (const [jobs, res] of [[evalJobs, evalRes], [stepJobs, stepRes]]) {
    jobs.forEach((job, k) => {
      const r = results[job.wi], pl = wave[job.wi].planned[job.si], got = res[k];
      if (!got.ok) { r.errors.push({ sample: job.si, error: got.error }); return; }
      // norm defensively: an injected oracle (tests, shims) may return mixed-case or null bytes
      const hex = norm(got.hex), outs = norm(got.outs), ns = norm(got.state);
      const detail = { sample: job.si, inputs: pl.inputsHex };
      let ok;
      if (job.stateHex === undefined) {
        ok = hex === pl.expectedOuts;
        if (!ok) Object.assign(detail, { expected: pl.expectedOuts, got: hex });
      } else {
        ok = outs === pl.expectedOuts && ns === pl.expectedState;
        if (!ok) Object.assign(detail, { expected: pl.expectedOuts, got: outs, expectedState: pl.expectedState, gotState: ns });
      }
      if (ok) r.matches++;
      else r.mismatches.push(detail);
    });
  }
  for (const r of results) {
    if (!r.mismatches.length) delete r.mismatches;
    if (!r.errors.length) delete r.errors;
  }
  return results;
}

// Greedy minimisation of a failing sample: zero input bits (then state bits) while the mismatch
// survives — a straight Hamming-weight descent, so the result is a failing input with (locally)
// minimal weight. Only talks to the oracle for attempts, so it is cheap and shim-testable.
export async function minimiseMismatch(circuit, oracle, { addr, id, inputs, state }, { attempts = 200 } = {}) {
  let used = 0;
  const inputs2 = inputs.slice();
  // state is only "present" when non-empty: planSamples gives [] for stateless circuits, and an
  // empty array is truthy — taking the step branch for a stateless circuit would query step()
  // with empty state and silently compare the wrong call.
  const state2 = state?.length ? state.slice() : null;
  const stillFails = async () => {
    if (used >= attempts) return null;
    used++;
    const [ns, outs] = beat(circuit, state2 ?? [], inputs2);
    try {
      const got = state2 ? await oracle.step(addr, id, bytesToHex(pack(state2)), bytesToHex(pack(inputs2))) : await oracle.eval(addr, id, bytesToHex(pack(inputs2)));
      return state2 ? (norm(got[1]) !== bytesToHex(pack(outs)) || norm(got[0]) !== bytesToHex(pack(ns))) : (norm(got) !== bytesToHex(pack(outs)));
    } catch { return null; } // an erroring oracle cannot confirm a smaller case; stop shrinking
  };
  for (let i = 0; i < inputs2.length; i++) {
    if (inputs2[i] === 0) continue;
    inputs2[i] = 0;
    if ((await stillFails()) !== true) inputs2[i] = 1;
    if (used >= attempts) break;
  }
  if (state2 && used < attempts) for (let i = 0; i < state2.length; i++) {
    if (state2[i] === 0) continue;
    state2[i] = 0;
    if ((await stillFails()) !== true) state2[i] = 1;
    if (used >= attempts) break;
  }
  return { inputs: inputs2, state: state2, attempts: used };
}

// ---------------------------------------------------------------- loading circuits (REF closure)

// Fetch and load a wave of circuits: BFS over REF targets (batched netlist reads, circuitInfo
// fetched for anything the enumeration map lacks), then tap02.load with a resolver that memoises
// REF targets in `cache` (top-level circuits are visited once and are not cached, so an 11K-circuit
// sweep does not accumulate them).
export async function loadWave(rows, reader, infoMap, cache = new Map()) {
  const key = (a, i) => `${String(a).toLowerCase()}:${BigInt(i)}`;
  const items = new Map();
  const addItem = (a, i) => {
    const k = key(a, i);
    if (!items.has(k)) items.set(k, { addr: String(a), id: BigInt(i), info: infoMap.get(k) ?? null, netlistHex: undefined, error: undefined });
    return items.get(k);
  };
  const top = rows.map((r) => addItem(r.processor, r.id));
  // circuitInfo for items the enumeration map does not know (REF targets, --only mode): batched,
  // individual fallback, same policy as netlists.
  const fillInfo = async (batch) => {
    const missing = batch.filter((it) => !it.info && it.error === undefined);
    if (!missing.length) return;
    try {
      const res = await reader.send(() => withRetry(() => reader.mc.aggregate3(missing.map((it) => ({ target: it.addr, allowFailure: true, callData: IFACES.circuitInfo.encodeFunctionData('circuitInfo', [it.id]) }))), {}, () => reader.pacer.penalize()));
      for (let i = 0; i < missing.length; i++) {
        const [ok, data] = res[i];
        if (ok) {
          try {
            const [nIn, nOut, nState, gates] = IFACES.circuitInfo.decodeFunctionResult('circuitInfo', data);
            missing[i].info = { nIn: Number(nIn), nOut: Number(nOut), nState: Number(nState), gates: Number(gates) };
            infoMap.set(key(missing[i].addr, missing[i].id), missing[i].info);
          } catch { /* fall through to individual */ }
        }
        if (!missing[i].info) await fillInfoOne(missing[i]);
      }
    } catch { /* no Multicall3 on this chain */ for (const it of missing) if (!it.info) await fillInfoOne(it); }
  };
  const fillInfoOne = async (it) => {
    try {
      const c = new Contract(it.addr, ['function circuitInfo(uint256) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)'], reader.p);
      const r = await reader.send(() => withRetry(() => c.circuitInfo(it.id), {}, () => reader.pacer.penalize()));
      it.info = { nIn: Number(r[0]), nOut: Number(r[1]), nState: Number(r[2]), gates: Number(r[3]) };
      infoMap.set(key(it.addr, it.id), it.info);
    } catch (e) { it.error = `circuitInfo: ${errText(e)}`; }
  };
  const queue = [...top]; // a copy: splice drains the queue, top must survive for the final map
  while (queue.length) {
    const batch = queue.splice(0);
    await fillInfo(batch);
    const netlistBatch = batch.filter((it) => !it.error && it.netlistHex === undefined && !cache.has(key(it.addr, it.id)));
    if (netlistBatch.length) await reader.fetch(netlistBatch);
    const next = [];
    for (const it of batch) {
      if (it.error || it.netlistHex === undefined) continue;
      let els;
      try { els = decode(hexToBytes(it.netlistHex), it.info.nIn); } catch (e) { it.error = `netlist decode: ${errText(e)}`; continue; }
      for (const e of els) if (e.op === REF) {
        const sub = addItem(e.cpu, e.id);
        if (!sub.error && sub.netlistHex === undefined && !cache.has(key(sub.addr, sub.id))) next.push(sub);
      }
    }
    queue.push(...next);
  }
  const loadOne = (it, resolve) => load(hexToBytes(it.netlistHex), it.info.nIn, it.info.nOut, resolve);
  const resolve = (a, i) => { // REF targets only: memoised across the whole sweep
    const k = key(a, i);
    if (cache.has(k)) return cache.get(k);
    const it = items.get(k);
    if (!it || it.error || it.netlistHex === undefined) return null;
    const c = loadOne(it, resolve);
    cache.set(k, c);
    return c;
  };
  return top.map((it) => {
    try {
      if (it.error || it.netlistHex === undefined) return { error: it.error ?? 'netlist unavailable', netlistHex: it.netlistHex, gates: it.info?.gates };
      const c = loadOne(it, resolve);
      return { circuit: c, refs: c.elements.filter((e) => e.op === REF).length, netlistHex: it.netlistHex, gates: it.info.gates };
    } catch (e) { return { error: `load: ${errText(e)}`, netlistHex: it.netlistHex, gates: it.info?.gates }; }
  });
}

// ---------------------------------------------------------------- enumeration

// The full universe: every processor of the factory, every circuit taped out on it, with flattened
// circuitInfo. Rows are returned for ALL circuits (REF targets may be ineligible themselves).
export async function enumerate(provider, { chunk = 400, pacer = null } = {}) {
  const factory = new Contract(XLAYER.factory, FACTORY_ABI, provider);
  const nCpu = Number(await factory.cpuCount());
  const facI = new Interface(FACTORY_ABI);
  const cpuRes = await multicall(provider, Array.from({ length: nCpu }, (_, i) => [XLAYER.factory, facI, 'cpus', [i]]), { chunk, pacer });
  const cpus = cpuRes.map((r) => (r ? r[0] : null));
  const metaCalls = [], metaIdx = [];
  cpus.forEach((a, i) => { if (a) { metaIdx.push(i); metaCalls.push([a, IFACES.nextId, 'nextId', []], [a, IFACES.name, 'name', []]); } });
  const meta = await multicall(provider, metaCalls, { chunk, pacer });
  const processors = cpus.map((a) => ({ address: a, name: '', circuits: 0 }));
  metaIdx.forEach((cpuIdx, k) => {
    const r = meta[2 * k], n = meta[2 * k + 1];
    if (!processors[cpuIdx].address) return;
    if (r) processors[cpuIdx].circuits = Math.max(0, Number(r[0]) - 1);
    if (n) processors[cpuIdx].name = n[0] ?? '';
  });
  const infoCalls = [], infoRef = [];
  processors.forEach((proc) => {
    if (!proc.address) return;
    for (let id = 1; id <= proc.circuits; id++) { infoRef.push([proc, id]); infoCalls.push([proc.address, IFACES.circuitInfo, 'circuitInfo', [id]]); }
  });
  const infoRes = await multicall(provider, infoCalls, { chunk, pacer });
  const infoMap = new Map();
  const rows = [];
  infoRes.forEach((r, k) => {
    const [proc, id] = infoRef[k];
    const key = `${proc.address.toLowerCase()}:${id}`;
    if (r) {
      const info = { nIn: Number(r[0]), nOut: Number(r[1]), nState: Number(r[2]), gates: Number(r[3]) };
      infoMap.set(key, info);
      rows.push({ processor: proc.address, id, ...info });
    } else rows.push({ processor: proc.address, id, info: null });
  });
  return { nCpu, processors, infoMap, rows };
}

// ---------------------------------------------------------------- checkpoint and summary

export const writeCheckpoint = (path, data) => {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(data));
  renameSync(tmp, path);
};
export const readCheckpoint = (path) => {
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { return null; }
};

export function summarize(results, meta, options, extra = {}) {
  const attempted = (r) => (r.matches ?? 0) + (r.mismatches?.length ?? 0);
  const checked = results.filter((r) => attempted(r) > 0);
  const sum = (f) => results.reduce((s, r) => s + f(r), 0);
  return {
    chainId: meta.chainId, rpc: meta.rpc, block: meta.block, at: new Date().toISOString(),
    seed: options.seed, samplesPerCircuit: options.samples, maxGates: options.maxGates,
    budgetGas: options.budgetGas, wave: options.wave,
    census: meta.census ?? null,
    processors: meta.processors?.length ?? null,
    circuits: meta.circuits ?? null,
    eligible: meta.eligible ?? null,
    skipped: meta.skipped ?? {},
    checked: checked.length,
    circuitsWithMismatches: results.filter((r) => (r.mismatches?.length ?? 0) > 0).length,
    circuitsErrored: results.filter((r) => (r.errors?.length ?? 0) > 0).length,
    samples: sum((r) => r.samples),
    compared: sum(attempted),
    matches: sum((r) => r.matches ?? 0),
    mismatches: sum((r) => r.mismatches?.length ?? 0),
    erroredSamples: sum((r) => r.errors?.length ?? 0),
    stateful: checked.filter((r) => r.nState > 0).length,
    withRefs: checked.filter((r) => (r.refs ?? 0) > 0).length,
    state: extra.state ?? 'running',
    elapsedS: Math.round((Date.now() - meta.startedAtMs) / 1000),
    ...extra.stats,
  };
}

// ---------------------------------------------------------------- mismatch write-up

export const calldataFor = (kind, id, stateHex, inputsHex) => IFACES[kind].encodeFunctionData(kind, kind === EVAL ? [id, inputsHex] : [id, stateHex, inputsHex]);

// Exact reproduction for mismatching circuits: minimised input, the --only command, the raw
// JSON-RPC eth_call, and the full netlist. One entry per mismatching circuit.
export function mismatchDoc(entries, { rpc, seed, samples, maxDetailed = 20 } = {}) {
  const shown = entries.slice(0, maxDetailed);
  const lines = [
    '# Conformance mismatch: our TAP-02 evaluator vs TapeOut live eval/step',
    '',
    `Found by \`node scripts/conformance.js\` against ${rpc}. Every sample below is reproducible`,
    'standalone: sample inputs are seeded per circuit (seed + FNV of processor:id), so `--only` sees',
    'exactly what the sweep saw. Packed bits are LSB-first (TAP-02 §4).',
    '',
  ];
  for (const [n, e] of shown.entries()) {
    const { row, circuit, detail, minimised, block, attempts } = e;
    const stateful = circuit.nState > 0;
    const kind = stateful ? STEP : EVAL;
    const data = calldataFor(kind, row.id, stateful ? bytesToHex(pack(minimised.state)) : undefined, bytesToHex(pack(minimised.inputs)));
    const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: row.processor, data }, 'latest'] });
    lines.push(
      `## ${n + 1}. ${row.processor} circuit #${row.id} — ${row.gates} gates, nIn ${row.nIn}, nOut ${row.nOut}, nState ${row.nState} (block ${block})`,
      '',
      `First failing sample #${detail.sample}. TapeOut \`${kind}\` disagrees with \`beat()\` in src/tap02.js:`,
      '',
      '| | ours | TapeOut live |',
      '|---|---|---|',
      `| outputs | \`${detail.expected}\` | \`${detail.got}\` |`,
      ...(stateful ? [`| new state | \`${detail.expectedState}\` | \`${detail.gotState}\` |`] : []),
      '',
      `Minimised failing input (greedy zero/one pass, ${attempts} chain calls): inputs \`${bytesToHex(pack(minimised.inputs))}\`${stateful ? `, state \`${bytesToHex(pack(minimised.state))}\`` : ''}`,
      '',
      'Exact reproduction:',
      '',
      '```sh',
      `node scripts/conformance.js --only ${row.processor} --id ${row.id} --rpc ${rpc} --seed ${seed} --samples ${samples}`,
      '```',
      '',
      'Raw JSON-RPC (the exact eth_call):',
      '',
      '```json',
      body,
      '```',
      '',
      `<details><summary>netlist (${((row.netlistHex?.length ?? 2) - 2) / 2} bytes)</summary>`,
      '',
      '`' + (row.netlistHex ?? 'not captured') + '`',
      '',
      '</details>',
      '',
    );
  }
  if (entries.length > shown.length) lines.push(`(and ${entries.length - shown.length} more mismatching circuits, see docs/conformance.json)`, '');
  return lines.join('\n');
}

// ---------------------------------------------------------------- sweep

// Processes `todo` in order in waves, skipping already-done indices (_i), writing `results` in
// place. `stats` (owned by the caller) collects reader/oracle counters; `flush()` runs after every
// wave; `shouldStop()` is honoured between waves (SIGINT).
export async function sweep({ todo, results, options, provider, pacer, infoMap, log = () => {}, flush, limit = 0, onMismatch = null, shouldStop = null, stats = null, reader = null, oracle = null }) {
  const done = new Set(results.map((r) => r._i));
  // reader/oracle are injectable so tests can drive the real sweep loop with shims (ganache has no
  // Multicall3 and MockProcessor has no eval/step); production gets the real ones.
  reader ??= new NetlistReader(provider, { chunk: options.chunk, bytes: options.netlistBytes, pacer });
  oracle ??= new ChainOracle(provider, { budgetGas: options.budgetGas, pacer });
  const cache = new Map();
  const t0 = Date.now();
  let cursor = 0, checkedThisRun = 0, mismatchCircuits = 0;
  const limitLeft = () => (limit > 0 ? limit - checkedThisRun : Infinity);
  while (cursor < todo.length && limitLeft() > 0) {
    const waveRows = [];
    while (cursor < todo.length && waveRows.length < Math.min(options.wave, limitLeft())) {
      if (!done.has(cursor)) waveRows.push({ ...todo[cursor], _i: cursor });
      cursor++;
    }
    if (!waveRows.length) break;
    const loaded = await loadWave(waveRows, reader, infoMap, cache);
    const okRows = [], failRows = new Map(), circuits = [];
    waveRows.forEach((row, k) => {
      if (loaded[k].error) failRows.set(k, { processor: row.processor, id: row.id, nIn: row.nIn, nOut: row.nOut, nState: row.nState, gates: row.gates, samples: 0, matches: 0, errors: [{ sample: 0, error: loaded[k].error }] });
      else { okRows.push(row); circuits.push(loaded[k].circuit); }
    });
    const wave = okRows.map((row, k) => ({ row, circuit: circuits[k], planned: planSamplesFor(circuits[k], options.samples, options.seed, row.processor, row.id) }));
    const waveResults = await checkWave(wave, oracle, { budgetGas: options.budgetGas });
    // minimisation runs right away, paced, so an interrupted run still leaves a usable write-up
    for (let k = 0; k < waveResults.length; k++) {
      const r = waveResults[k], w = wave[k];
      if (r.mismatches?.length && onMismatch) {
        mismatchCircuits++;
        const detail = r.mismatches[0], pl = w.planned[detail.sample];
        const mini = await minimiseMismatch(w.circuit, oracle, { addr: w.row.processor, id: w.row.id, inputs: pl.inputs, state: pl.state }, {});
        const k0 = waveRows.indexOf(w.row);
        onMismatch({ row: { ...w.row, netlistHex: loaded[k0].netlistHex }, circuit: w.circuit, detail, minimised: { inputs: mini.inputs, state: mini.state }, attempts: mini.attempts });
      }
    }
    let okIdx = 0;
    const recs = waveRows.map((row, k) => {
      const base = failRows.get(k) ?? waveResults[okIdx++];
      return { ...base, refs: loaded[k].refs ?? 0, ...(base.mismatches?.length ? { netlistHex: loaded[k].netlistHex } : {}), _i: row._i };
    });
    results.push(...recs);
    checkedThisRun += recs.length;
    if (stats) { stats.reader = reader.stats; stats.oracle = oracle.stats; }
    const m = (f) => recs.reduce((s, r) => s + f(r), 0);
    log(`+${recs.length} (${results.length}/${todo.length} done, ${m((r) => (r.matches ?? 0) + (r.mismatches?.length ?? 0))}/${m((r) => r.samples)} samples match, ${m((r) => r.mismatches?.length ?? 0)} mismatch, ${m((r) => r.errors?.length ?? 0)} error, ${Math.round((Date.now() - t0) / 1000)}s elapsed`);
    flush();
    if (shouldStop?.()) break;
  }
  if (stats) { stats.reader = reader.stats; stats.oracle = oracle.stats; }
  return { checkedThisRun, mismatchCircuits };
}

// ---------------------------------------------------------------- CLI

const opt = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const num = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const has = (k) => process.argv.includes(`--${k}`);

// Re-check one circuit verbosely; the workhorse for minimising a mismatch by hand. Writes nothing.
async function onlyOne(o, provider) {
  const addr = o.only, id = Number(o.id);
  const reader = new NetlistReader(provider, { pacer: makePacer(o.delay) });
  const infoMap = new Map();
  const [loaded] = await loadWave([{ processor: addr, id }], reader, infoMap, new Map());
  if (loaded.error) { console.error(`cannot load circuit: ${loaded.error}`); return 2; }
  const c = loaded.circuit;
  console.log(`${addr} #${id}: ${c.nGates} gates decoded (chain says ${loaded.gates}), nIn ${c.nIn}, nOut ${c.nOut}, nState ${c.nState}, ${loaded.refs} REFs`);
  const oracle = new ChainOracle(provider, { pacer: makePacer(o.delay) });
  const planned = planSamplesFor(c, o.samples, o.seed, addr, id);
  const [results] = await checkWave([{ row: { processor: addr, id, gates: loaded.gates }, circuit: c, planned }], oracle, { budgetGas: o.budgetGas });
  planned.forEach((pl, s) => {
    const fail = results.mismatches?.find((m) => m.sample === s) ?? null;
    console.log(`sample ${s}: inputs ${pl.inputsHex}${c.nState ? ` state ${pl.stateHex}` : ''} -> ours ${pl.expectedOuts}${c.nState ? ` / ${pl.expectedState}` : ''} ${fail ? `MISMATCH: chain ${fail.got}${c.nState ? ` / ${fail.gotState}` : ''}` : 'ok'}`);
  });
  if (!results.mismatches?.length) {
    console.log(`${results.matches}/${results.samples} samples agree with TapeOut live${results.errors?.length ? `, ${results.errors.length} errored: ${results.errors.map((e) => e.error).join('; ')}` : ''}`);
    return 0;
  }
  console.log(`\nMISMATCH: minimising sample ${results.mismatches[0].sample}...`);
  const pl = planned[results.mismatches[0].sample];
  const mini = await minimiseMismatch(c, oracle, { addr, id, inputs: pl.inputs, state: pl.state }, {});
  console.log(`minimised: inputs ${bytesToHex(pack(mini.inputs))}${c.nState ? ` state ${bytesToHex(pack(mini.state))}` : ''} (${mini.attempts} chain calls)`);
  const kind = c.nState ? STEP : EVAL;
  const data = calldataFor(kind, id, c.nState ? bytesToHex(pack(mini.state)) : undefined, bytesToHex(pack(mini.inputs)));
  console.log(`\neth_call: ${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [{ to: addr, data }, 'latest'] })}`);
  return 1;
}

const publicMeta = ({ pacer, startedAtMs, infoMap, ...rest }) => rest;

async function main() {
  const o = {
    rpc: opt('rpc', process.env.RPC_URL ?? XLAYER.rpc),
    out: opt('out', 'docs/conformance.json'),
    mismatchDocPath: opt('mismatch-out', 'docs/conformance-mismatch.md'),
    samples: Math.max(1, num('samples', 4)),
    maxGates: num('max-gates', 18000),
    budgetGas: num('budget', 40_000_000),
    wave: Math.max(1, num('wave', 40)),
    netlistBytes: num('netlist-bytes', 524_288),
    chunk: Math.max(1, num('chunk', 400)),
    delay: num('delay', 50),
    seed: num('seed', 0x0c10c),
    limit: num('limit', 0),
    only: opt('only', null),
    id: num('id', 0),
    fresh: has('fresh'),
    quiet: has('quiet'),
  };
  const provider = new JsonRpcProvider(o.rpc, XLAYER.chainId, { staticNetwork: true, batchMaxCount: 1 });
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId !== XLAYER.chainId) { console.error(`chain ${chainId}: this sweep is for X Layer mainnet (${XLAYER.chainId})`); process.exitCode = 2; return; }
  const pacer = makePacer(o.delay);
  const block = await provider.getBlockNumber();

  if (o.only) {
    if (!o.id) { console.error('--only needs --id'); process.exitCode = 2; return; }
    process.exitCode = await onlyOne(o, provider);
    return;
  }

  // census.json: names for processors whose name() is empty, plus a staleness cross-check
  let census = null;
  const censusNames = new Map();
  try {
    const c = JSON.parse(readFileSync('docs/census.json', 'utf8'));
    census = { block: c.summary.block, at: c.summary.at, processors: c.summary.processors, circuits: c.summary.circuits };
    for (const list of [c.featured ?? [], c.tooBig ?? [], c.heldBack ?? []]) for (const row of list) if (row.processorName) censusNames.set(row.processor.toLowerCase(), row.processorName);
    if (!o.quiet) console.log(`census.json: ${census.circuits} circuits on ${census.processors} processors at block ${census.block} (${String(census.at).slice(0, 10)})`);
  } catch { /* optional */ }

  const options = { samples: o.samples, maxGates: o.maxGates, budgetGas: o.budgetGas, wave: o.wave, netlistBytes: o.netlistBytes, chunk: o.chunk, seed: o.seed };
  const cp = o.fresh ? null : readCheckpoint(o.out);
  if (cp && cp.state === 'complete') {
    console.log(`${o.out} is already complete (${cp.summary?.matches}/${cp.summary?.compared} samples on ${cp.summary?.checked} circuits); rerun with --fresh to redo.`);
    return;
  }
  if (cp) for (const k of Object.keys(options)) if (cp.options?.[k] !== options[k]) { console.log(`${o.out} was built with ${k}=${cp.options?.[k]}, now ${options[k]}: rerun with --fresh`); process.exitCode = 2; return; }

  let todo, results, meta, enumRows;
  if (cp) {
    todo = cp.todo; results = cp.results; enumRows = cp.enum ?? [];
    meta = { ...cp.meta, updatedAt: new Date().toISOString(), pacer, startedAtMs: Date.now() - (cp.summary?.elapsedS ?? 0) * 1000 };
    if (!o.quiet) console.log(`resuming ${o.out}: ${results.length}/${todo.length} done (block ${meta.block})`);
  } else {
    const t0 = Date.now();
    if (!o.quiet) console.log(`enumerating every circuit on chain 196 at block ${block}...`);
    const en = await enumerate(provider, { chunk: o.chunk, pacer });
    const skipped = {};
    const eligible = [];
    for (const row of en.rows) {
      const reason = isEligible(row.info ?? row, o.maxGates);
      if (reason) skipped[reason] = (skipped[reason] ?? 0) + 1;
      else eligible.push(row);
    }
    for (const proc of en.processors) if (!proc.name && censusNames.has(proc.address.toLowerCase())) proc.name = censusNames.get(proc.address.toLowerCase());
    todo = orderRoundRobin(eligible);
    // REF targets may be ineligible themselves, so the info map covers the whole enumerated
    // universe; it is stored compactly in the checkpoint and rebuilt on resume.
    enumRows = en.rows.filter((r) => r.info).map((r) => [r.processor, r.id, r.nIn, r.nOut, r.nState, r.gates]);
    results = [];
    meta = {
      chainId, rpc: o.rpc, block, startedAt: new Date().toISOString(), startedAtMs: Date.now(), updatedAt: new Date().toISOString(),
      census, processors: en.processors, circuits: en.rows.length, eligible: todo.length, skipped, pacer,
    };
    if (!o.quiet) {
      console.log(`${en.nCpu} processors, ${en.rows.length} circuits, ${todo.length} eligible (${Math.round((Date.now() - t0) / 1000)}s); skipped: ${JSON.stringify(skipped)}`);
      if (census) console.log(`census said ${census.circuits} circuits on ${census.processors} processors (block ${census.block}); live now: ${en.rows.length} on ${en.nCpu}`);
    }
  }
  const infoMap = new Map();
  for (const [addr, id, nIn, nOut, nState, gates] of enumRows) infoMap.set(`${addr.toLowerCase()}:${id}`, { nIn, nOut, nState, gates });

  mkdirSync('docs', { recursive: true });
  const mismatchEntries = [];
  const stats = {};
  let interrupted = 0;
  const flush = (state = 'running') => {
    const summary = summarize(results, meta, options, { state, stats: stats.rpc ? { rpcCalls: stats.rpc, netlistsRead: stats.netlistsRead ?? 0, bytesRead: stats.bytesRead ?? 0, backoffs: stats.backoffs ?? 0 } : {} });
    if (state === 'complete') {
      writeCheckpoint(o.out, { version: 1, state: 'complete', summary, options, meta: publicMeta(meta), results: results.map(({ _i, ...r }) => r) });
    } else {
      writeCheckpoint(o.out, { version: 1, state: 'running', summary, options, meta: publicMeta(meta), todo, enum: enumRows, results });
    }
    return summary;
  };
  const log = o.quiet ? () => {} : (m) => console.log(`  ${m}`);
  const onMismatch = (e) => {
    mismatchEntries.push(e);
    console.log(`  MISMATCH ${e.row.processor} #${e.row.id} sample ${e.detail.sample}: ours ${e.detail.expected}${e.circuit.nState ? `/${e.detail.expectedState}` : ''} vs chain ${e.detail.got}${e.circuit.nState ? `/${e.detail.gotState}` : ''}`);
    writeFileSync(o.mismatchDocPath, mismatchDoc(mismatchEntries, { rpc: o.rpc, seed: o.seed, samples: o.samples }));
  };
  process.on('SIGINT', () => { interrupted++; flush('running'); if (interrupted >= 2) process.exit(130); log('interrupted: will stop after this wave; Ctrl-C again to stop now'); });
  process.on('SIGTERM', () => { interrupted++; flush('running'); if (interrupted >= 2) process.exit(130); });

  await sweep({
    todo, results, options, provider, pacer, infoMap, log, flush: () => {
      const s = stats.reader ?? {};
      Object.assign(stats, { rpc: (s.rpcCalls ?? 0) + (stats.oracle?.rpcCalls ?? 0), netlistsRead: s.netlistsRead ?? 0, bytesRead: s.bytesRead ?? 0, backoffs: stats.oracle?.backoffs ?? 0 });
      flush('running');
    },
    limit: o.limit, onMismatch, shouldStop: () => interrupted > 0, stats,
  });

  const remaining = todo.length - results.length;
  const finalState = remaining > 0 ? 'running' : 'complete';
  const summary = flush(finalState);
  console.log(JSON.stringify(summary, null, 1));
  if (finalState === 'complete') console.log(`bit-exact on ${summary.checked}/${summary.checked} checked circuits, ${summary.matches}/${summary.compared} samples${summary.circuitsWithMismatches ? ' — MISMATCHES FOUND' : ''}`);
  else console.log(`${results.length}/${todo.length} circuits done this far (${remaining} left) — rerun to resume`);
  process.exitCode = summary.mismatches > 0 ? 1 : interrupted > 0 ? 130 : 0;
}

const here = process.argv[1] ? pathToFileURL(process.argv[1]).href : null;
if (here === import.meta.url) main().catch((e) => { console.error(e?.stack ?? errText(e)); process.exit(2); });
