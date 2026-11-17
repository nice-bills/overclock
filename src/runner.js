// B3: the runner. Walks the census and runs every stuck machine once, unattended:
//
//   mirror (testnet) or use directly (mainnet) -> post a job -> claim it with the operator ->
//   wait out the window -> finalize -> verify the result locally -> record it in web/runs.json.
//
// Order: stuck machines that are not FabX miners, biggest first (the ones too big for a block, then
// the rest); then the FabX miner shapes, biggest first, one representative per shape. When a
// reference circuit is configured for a miner, the job is a certificate (src/bench.js): a test
// bench that checks the design against the reference on every input.
//
// Safe to kill at any point: every phase is written to a state file before the next one starts,
// a post is looked up on chain before it is repeated, and runs.json is rewritten atomically.
// Spending is guarded by a floor (never go below it) and a per-day cap; the guard only stops
// new items, jobs already in flight keep going so no bond is left locked.
//
// The wallet key is read from RUNNER_KEY only and is never logged.

import { Contract, JsonRpcProvider, Wallet, formatEther, parseEther, keccak256, toUtf8Bytes, getBytes } from 'ethers';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { artifact, loadCircuit, readJob } from './chain.js';
import { Operator } from './agents.js';
import { layout } from './trace.js';
import { beat, bytesToHex, hexToBytes, pack, unpack } from './tap02.js';
import { fetchCircuit, mirrorCircuit, refKey, MAINNET_RPC } from './mirror.js';
import { burnCost, mint, tapeout, CIRCUITS_FULL_ABI, TRANSISTORS_ABI, XLAYER } from './tapeout.js';
import { benchCircuit, benchSize, benchState, expectedVerdict } from './bench.js';

export const GAS_PER_GATE = 2400;
export const BLOCK_GAS = 210_000_000;
const ZERO = '0x0000000000000000000000000000000000000000';
const TERMINAL = new Set(['done', 'failed', 'skipped']);
const NETWORKS = {
  196: { name: 'X Layer', explorer: 'https://www.oklink.com/x-layer' },
  1952: { name: 'X Layer testnet', explorer: 'https://www.oklink.com/x-layer-testnet' },
};

// ---- selection ------------------------------------------------------------------------------

const isFab = (name) => String(name).startsWith('FAB');
export const itemKey = (c) => `${String(c.processor).toLowerCase()}:${Number(c.id)}`;
export const shapeKey = (c) => `${c.gates}/${c.nIn}/${c.nOut}/${c.nState}`;

/// The run order. Stuck = too big for a block, or a machine a block can't run 1,000 beats of.
/// Machines first (biggest first), then one representative per FabX miner shape (biggest shape
/// first, then the most common), each listing every circuit of that shape as a candidate to cover.
export function buildQueue(census) {
  const seen = new Set();
  const stuck = [...(census.tooBig ?? []), ...(census.heldBack ?? [])].filter((c) => !seen.has(itemKey(c)) && seen.add(itemKey(c)));
  const norm = (c) => ({
    key: itemKey(c), processor: String(c.processor).toLowerCase(), id: Number(c.id), name: c.processorName, owner: c.owner,
    gates: c.gates, nIn: c.nIn, nOut: c.nOut, nState: c.nState, beatsPerBlock: Math.floor(BLOCK_GAS / Math.max(1, c.gates * GAS_PER_GATE)),
  });
  const byKey = (a, b) => (a.key < b.key ? -1 : 1);
  const machines = stuck.filter((c) => !isFab(c.processorName)).map(norm).sort((a, b) => b.gates - a.gates || byKey(a, b));
  const shapes = new Map();
  for (const c of stuck.filter((c) => isFab(c.processorName)).map(norm)) {
    const k = shapeKey(c);
    if (!shapes.has(k)) shapes.set(k, []);
    shapes.get(k).push(c);
  }
  const miners = [...shapes.values()]
    .map((g) => g.sort((a, b) => a.id - b.id || byKey(a, b)))
    .sort((a, b) => b[0].gates - a[0].gates || b.length - a.length || byKey(a[0], b[0]))
    .map((g) => ({ ...g[0], kind: 'miner', shape: shapeKey(g[0]), members: g.slice(1).map((m) => ({ processor: m.processor, id: m.id })) }));
  return [...machines.map((m) => ({ ...m, kind: 'machine', members: [] })), ...miners];
}

/// Beats for a plain run: past what one block allows (twice as many, plus one), but never more
/// than `maxSteps` trace leaves. null when even one beat is over the cap.
export function planBeats(item, { maxSteps = 100_000_000, mult = 2 } = {}) {
  const perBeat = item.gates + item.nState;
  const cap = Math.floor(maxSteps / Math.max(1, perBeat));
  if (cap < 1) return null;
  const want = item.beatsPerBlock < 1 ? 1 : item.beatsPerBlock * mult + 1;
  return { beats: Math.min(want, cap), steps: Math.min(want, cap) * perBeat };
}

/// Deterministic pseudo-random input bits for a circuit, so the run does something.
export function seedBits(key, n) {
  const out = [];
  for (let block = 0; out.length < n; block++) {
    for (const byte of getBytes(keccak256(toUtf8Bytes(`${key}#${block}`)))) for (let b = 0; b < 8 && out.length < n; b++) out.push((byte >> b) & 1);
  }
  return out;
}

/// The bond for a job, read the way the contract offers it: per job (bondFor) or global (bond).
export async function bondOf(oc, jobId) {
  const per = (() => { try { return oc.interface.getFunction('bondFor'); } catch { return null; } })();
  return BigInt(await (per ? oc.bondFor(jobId) : oc.bond()));
}

/// Dry run: what a pass would do, from the census alone.
export function dryRun(queue, { maxSteps, refs = {}, only = null, limit = Infinity } = {}) {
  return queue.filter((q) => !only || only.has(q.key)).slice(0, limit).map((q) => {
    const plan = planBeats(q, { maxSteps });
    const ref = refs[q.key] ?? refs[`shape:${q.shape}`];
    return { ...q, ...(plan ?? {}), skip: plan ? null : `one beat is over ${maxSteps} steps`, certificate: Boolean(ref && q.nIn >= 1 && q.nIn <= 24), reference: ref ?? null };
  });
}

// ---- files: state and runs.json -------------------------------------------------------------

export function writeJsonAtomic(path, obj) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, JSON.stringify(obj, null, 1) + '\n');
  renameSync(tmp, path);
}

const readRuns = (path) => {
  const d = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : {};
  return { schema: 1, ...d, runs: d.runs ?? [], certificates: d.certificates ?? [] };
};
const writeRuns = (path, d, now) => writeJsonAtomic(path, { ...d, schema: 1, updatedAt: new Date(now).toISOString() });
const upsert = (list, row) => { const i = list.findIndex((r) => r.id === row.id); if (i < 0) list.push(row); else list[i] = row; };

export function upsertRun(path, run, network, now = Date.now()) {
  const d = readRuns(path);
  upsert(d.runs, run);
  d.networks = { ...d.networks, [run.chainId]: { ...(NETWORKS[run.chainId] ?? { name: `chain ${run.chainId}` }), ...d.networks?.[run.chainId], overclock: run.overclock, ...network } };
  writeRuns(path, d, now);
}
export function dropRun(path, id, now = Date.now()) {
  const d = readRuns(path);
  d.runs = d.runs.filter((r) => r.id !== id);
  d.certificates = d.certificates.filter((c) => c.runId !== id);
  writeRuns(path, d, now);
}
export function upsertCertificate(path, cert, now = Date.now()) {
  const d = readRuns(path);
  upsert(d.certificates, cert);
  writeRuns(path, d, now);
}

// ---- the runner -----------------------------------------------------------------------------

export class Runner {
  /// oc: Overclock contract connected to the signer. local: { circuits, transistors } of the
  /// processor the runner owns (mirror target, and where benches are taped out).
  constructor({
    oc, signer, provider, source = null, mode = 'mirror', local = null, queue, statePath, runsPath, refs = {},
    fee = parseEther('0.00001'), floor = parseEther('0.0005'), reserve = parseEther('0.0003'), maxPerDay = parseEther('0.01'),
    maxSteps = 100_000_000, parallel = 1, attempts = 3, pollMs = 5000, stream = { above: 2 ** 27 }, settle = null,
    log = () => {}, sleep = (ms) => new Promise((ok) => setTimeout(ok, ms)), clock = () => Date.now(), limit = Infinity, only = null,
  }) {
    Object.assign(this, { oc, signer, provider, source, mode, local, refs, fee, floor, reserve, maxPerDay, maxSteps, parallel, attempts, pollMs, stream, settle, sleep, clock });
    this.queue = queue.filter((q) => !only || only.has(q.key)).slice(0, limit);
    this.statePath = statePath;
    this.runsPath = runsPath;
    this.say = log;
    this.circuits = new Map();
    this.ops = new Map();
    this.stopped = false;
    this.paused = null;
  }

  log(e) { this.say({ at: new Date(this.clock()).toISOString(), ...e }); }
  stop() { this.stopped = true; }
  save() { writeJsonAtomic(this.statePath, this.st); }
  day() { return new Date(this.clock()).toISOString().slice(0, 10); }
  active() { return this.queue.map((q) => this.st.items[q.key]).filter((it) => it && !TERMINAL.has(it.phase)); }

  async init() {
    this.me = (await this.signer.getAddress()).toLowerCase();
    const chainId = Number((await this.provider.getNetwork()).chainId);
    const overclock = (await this.oc.getAddress()).toLowerCase();
    const prev = existsSync(this.statePath) ? JSON.parse(readFileSync(this.statePath, 'utf8')) : null;
    if (prev && (prev.chainId !== chainId || prev.overclock !== overclock)) throw new Error(`state file ${this.statePath} belongs to chain ${prev.chainId} ${prev.overclock}`);
    this.st = prev ?? { version: 1, chainId, overclock, items: {}, days: {} };
    this.chainId = chainId;
    this.overclock = overclock;
    this.window = Number(await this.oc.window());
    this.save();
  }

  // ---- budget

  balance() { return this.provider.getBalance(this.me); }

  /// Spend = fall in (balance + bonds we have locked). Fees count in full, even though a job we
  /// claim ourselves pays most of it back: the cap is a ceiling, not a forecast.
  async account() {
    const locked = Object.values(this.st.items).reduce((s, it) => s + (it.phase === 'claimed' && it.claimedByMe ? BigInt(it.bond) : 0n), 0n);
    const adj = (await this.balance()) + locked;
    const last = this.st.lastAdj == null ? adj : BigInt(this.st.lastAdj);
    if (adj < last) this.st.days[this.day()] = (BigInt(this.st.days[this.day()] ?? 0) + last - adj).toString();
    this.st.lastAdj = adj.toString();
  }

  spentToday() { return BigInt(this.st.days[this.day()] ?? 0); }

  /// Why no new item may start, or null.
  async budgetBlock() {
    if (this.spentToday() >= this.maxPerDay) return `daily cap ${formatEther(this.maxPerDay)} OKB reached`;
    let bond = BigInt(this.st.lastBond ?? 0);
    try { bond = await bondOf(this.oc, await this.oc.jobCount()); } catch { /* keep the last bond we saw */ }
    const need = bond + this.fee + this.reserve + this.floor;
    const have = await this.balance();
    if (have < need) return `balance ${formatEther(have)} OKB is under the floor (needs ${formatEther(need)})`;
    return null;
  }

  // ---- loop

  async tick() {
    for (const it of this.active()) {
      await this.guarded(it, () => this.advance(it));
      await this.account();
      this.save();
    }
    this.paused = null;
    while (this.active().length < this.parallel && !this.stopped) {
      const q = this.queue.find((c) => !this.st.items[c.key]);
      if (!q) break;
      const why = await this.budgetBlock();
      if (why) {
        if (this.pausedWhy !== why) this.log({ what: `paused: ${why}` });
        this.pausedWhy = this.paused = why;
        break;
      }
      this.pausedWhy = null;
      const it = (this.st.items[q.key] = { key: q.key, kind: q.kind, phase: 'new', attempts: 0, txs: [], disputeTxs: 0, disputeGas: 0 });
      this.log({ what: `starts ${q.name} #${q.id} (${q.gates} gates)`, key: q.key });
      await this.guarded(it, () => this.advance(it));
      await this.account();
      this.save();
    }
    const items = Object.values(this.st.items);
    return { active: this.active().length, remaining: this.queue.filter((c) => !this.st.items[c.key]).length, paused: this.paused, done: items.filter((i) => i.phase === 'done').length, failed: items.filter((i) => i.phase === 'failed').length };
  }

  async run({ watch = false, maxCycles = Infinity } = {}) {
    await this.init();
    let s;
    for (let i = 0; i < maxCycles && !this.stopped; i++) {
      s = await this.tick();
      if (!watch && s.active === 0 && (s.remaining === 0 || s.paused)) break;
      await this.sleep(this.pollMs);
    }
    return { ...s, spentToday: formatEther(this.spentToday()) };
  }

  async guarded(it, fn) {
    try {
      await fn();
    } catch (e) {
      const msg = e.shortMessage ?? e.message;
      this.log({ what: `error in ${it.phase}: ${msg}`, key: it.key, error: true });
      it.error = msg;
      // before a job exists a failure is retried a few times, then the item is given up on;
      // after that the job is on chain and has to be seen through
      if (it.phase === 'new' || it.phase === 'mirrored') {
        it.attempts++;
        if (it.attempts >= this.attempts) { it.phase = 'failed'; this.log({ what: 'gave up', key: it.key }); }
      }
    }
  }

  async advance(it) {
    const q = this.queue.find((c) => c.key === it.key);
    if (it.phase === 'new') await this.prepare(it, q);
    if (it.phase === 'mirrored') await this.post(it, q);
    else if (it.phase === 'posted' || it.phase === 'claimed') await this.operate(it, q);
    if (it.phase === 'final') await this.finish(it, q);
  }

  // ---- phase: mirror, plan

  async put(netlist) {
    const { circuits, transistors } = this.local;
    const need = burnCost(netlist.netlist, netlist.nIn);
    for (const [token, kind] of [[0, 'nand'], [1, 'latch']]) {
      const have = Number(await transistors.balanceOf(this.me, token));
      if (need[kind] > have) await mint(transistors, token, need[kind] - have);
    }
    const t = await tapeout(circuits, netlist);
    return { processor: (await circuits.getAddress()).toLowerCase(), id: Number(t.id) };
  }

  async mirrorOf(c) {
    if (this.mode === 'direct') return { processor: c.processor, id: c.id };
    const r = await mirrorCircuit({ provider: this.source, processor: c.processor, id: c.id, circuits: this.local.circuits, transistors: this.local.transistors, log: (m) => this.log({ what: m }) });
    const t = r.refMap.get(refKey(c.processor, c.id));
    return { processor: t.processor.toLowerCase(), id: Number(t.id) };
  }

  async describe(t) {
    const c = await loadCircuit(this.provider, t.processor, t.id, this.circuits);
    return { cpu: t.processor, id: t.id, nIn: c.nIn, nOut: c.nOut, nState: c.nState, reset: [] };
  }

  async prepare(it, q) {
    const plain = planBeats(q, { maxSteps: this.maxSteps });
    if (!plain) { it.phase = 'skipped'; it.error = `one beat is over ${this.maxSteps} steps`; this.log({ what: `skips: ${it.error}`, key: it.key }); return; }
    const ref = this.refs[q.key] ?? this.refs[`shape:${q.shape}`];
    it.design = it.design ?? (await this.mirrorOf(q));
    Object.assign(it, { beats: plain.beats });
    it.inputs = bytesToHex(pack(seedBits(q.key, q.nIn)));
    it.state = bytesToHex(pack(new Array(q.nState).fill(0)));
    this.save();
    if (ref && q.nIn >= 1 && q.nIn <= 24) await this.prepareBench(it, q, ref);
    it.phase = 'mirrored';
    this.save();
  }

  async prepareBench(it, q, ref) {
    try {
      if (!this.local) throw new Error('no processor to tape the bench out on');
      it.reference = it.reference ?? (await this.mirrorOf({ processor: String(ref.processor).toLowerCase(), id: Number(ref.id) }));
      const design = await this.describe(it.design), reference = await this.describe(it.reference);
      const bench = benchCircuit(design, reference);
      const size = benchSize(bench, (a, i) => this.circuits.get(refKey(a, i)));
      if (size.steps > this.maxSteps) throw new Error(`the bench is ${size.steps} steps, over ${this.maxSteps}`);
      it.bench = { design, reference, ...(await this.put({ netlist: bench.netlist, nIn: 0, nOut: bench.nOut })), refSource: { processor: String(ref.processor).toLowerCase(), id: Number(ref.id), name: ref.name } };
      Object.assign(it, { beats: bench.beats, inputs: '0x', state: bytesToHex(pack(benchState(bench))) });
      it.covers = await this.identicalMembers(it, q);
    } catch (e) {
      this.log({ what: `no certificate, running the design plainly: ${e.shortMessage ?? e.message}`, key: it.key });
      delete it.bench;
    }
  }

  /// Circuits of the same shape whose netlist is byte for byte the representative's: they behave
  /// the same, so the certificate covers them.
  async identicalMembers(it, q) {
    const src = this.source ?? this.provider;
    const me = await fetchCircuit(src, q.processor, q.id);
    const same = [];
    for (let i = 0; i < q.members.length; i += 8) {
      const part = await Promise.all(q.members.slice(i, i + 8).map((m) => fetchCircuit(src, m.processor, m.id).then((c) => (Buffer.compare(c.netlist, me.netlist) === 0 ? m : null), () => null)));
      same.push(...part.filter(Boolean));
    }
    return same;
  }

  // ---- phase: post

  async send(it, what, fn, ...args) {
    const rc = await (await this.oc[fn](...args)).wait();
    if (this.settle) await this.settle(rc);
    this.log({ what, key: it.key, fn, gas: Number(rc.gasUsed), tx: rc.hash });
    return rc;
  }

  /// The job we posted for this item, if it is on chain already (we may have died before saving it).
  async findPosted(it, target) {
    const n = Number(await this.oc.jobCount());
    for (let i = it.scanFrom; i < n; i++) {
      const j = await this.oc.jobs(i);
      if (String(j.poster).toLowerCase() === this.me && String(j.cpu).toLowerCase() === target.processor && Number(j.id) === target.id && Number(j.beats) === it.beats) return i;
    }
    return null;
  }

  async post(it, q) {
    const target = it.bench ? { processor: it.bench.processor, id: it.bench.id } : it.design;
    it.target = target;
    if (it.scanFrom == null) { it.scanFrom = Number(await this.oc.jobCount()); this.save(); }
    let jobId = await this.findPosted(it, target);
    if (jobId == null) {
      const rc = await this.send(it, 'posts the job', 'postJob', target.processor, target.id, it.inputs, it.state, it.beats, false, { value: this.fee });
      const ev = rc.logs.map((l) => { try { return this.oc.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'JobPosted');
      jobId = Number(ev.args.jobId);
      it.txs.push({ what: 'post job', tx: rc.hash, gas: Number(rc.gasUsed) });
    }
    it.jobId = jobId;
    it.bond = (await bondOf(this.oc, jobId)).toString();
    this.st.lastBond = it.bond;
    const c = await loadCircuit(this.provider, target.processor, target.id, this.circuits);
    it.steps = layout(c, it.beats).n;
    it.postedAt = new Date(this.clock()).toISOString();
    it.phase = 'posted';
    this.record(it, q);
  }

  // ---- phase: claim, wait, finalize

  operator(it) {
    if (!this.ops.has(it.key)) {
      const op = new Operator({
        oc: this.oc, signer: this.signer, name: 'runner', circuits: this.circuits, settle: this.settle, stream: this.stream,
        log: (e) => {
          this.log({ ...e, key: it.key });
          if (!e.tx) return;
          if (e.fn === 'claim' || e.fn === 'finalize') it.txs.push({ what: e.fn === 'claim' ? 'claim' : 'finalize', tx: e.tx, gas: e.gas });
          else { it.disputeTxs++; it.disputeGas += e.gas ?? 0; }
        },
      });
      op.only = new Set([it.jobId]);
      op._bond = BigInt(it.bond); // Operator reads bond() otherwise, which a per-job bond contract lacks
      this.ops.set(it.key, op);
    }
    return this.ops.get(it.key);
  }

  async chainNow() {
    return Number((await this.provider.getBlock('latest')).timestamp);
  }

  async operate(it, q) {
    let job = await readJob(this.oc, it.jobId);
    if (!job.finalized) {
      await this.operator(it).tick();
      job = await readJob(this.oc, it.jobId);
    }
    if (job.claimant !== ZERO && it.phase === 'posted') {
      it.phase = 'claimed';
      it.claimedByMe = job.claimant.toLowerCase() === this.me;
    }
    if (job.challenged) it.disputes = Math.max(it.disputes ?? 0, 1);
    if (!job.finalized && job.claimant !== ZERO && job.claimant.toLowerCase() !== this.me && !job.challenged && (await this.chainNow()) >= job.claimedAt + this.window) {
      const rc = await this.send(it, 'finalizes', 'finalize', it.jobId);
      it.txs.push({ what: 'finalize', tx: rc.hash, gas: Number(rc.gasUsed) });
      job = await readJob(this.oc, it.jobId);
    }
    if (job.finalized) { it.phase = 'final'; this.ops.delete(it.key); }
    this.record(it, q);
  }

  // ---- phase: verify, record

  /// Re-evaluate the job with the TAP-02 evaluator alone and compare with what the chain settled.
  async verify(it) {
    const job = await readJob(this.oc, it.jobId);
    const c = await loadCircuit(this.provider, it.target.processor, it.target.id, this.circuits);
    let st = job.stateBits, outs = [];
    for (let b = 0; b < job.beats; b++) [st, outs] = beat(c, st, job.perBeat ? job.inputBits.slice(b * job.nIn, (b + 1) * job.nIn) : job.inputBits);
    const [onOut, onState] = await this.oc.result(it.jobId);
    if (bytesToHex(pack(outs)) !== onOut.toLowerCase() || bytesToHex(pack(st)) !== onState.toLowerCase()) throw new Error('the settled result differs from the local evaluation');
    try {
      if (BigInt(await this.oc.traceSize(it.jobId)) !== BigInt(it.steps)) throw new Error('steps differ from the contract trace size');
    } catch (e) {
      if (/steps differ/.test(e.message)) throw e; // traceSize is absent on older contracts
    }
    if (!it.bench) return null;
    const bench = benchCircuit(it.bench.design, it.bench.reference);
    const exp = expectedVerdict(bench, (a, i) => this.circuits.get(refKey(a, i)));
    if (JSON.stringify(exp.outputs) !== JSON.stringify(unpack(hexToBytes(onOut), bench.nOut))) throw new Error('the settled verdict differs from the reference run');
    return exp;
  }

  async finish(it, q) {
    const claim = it.txs.find((t) => t.what === 'claim'), fin = it.txs.find((t) => t.what === 'finalize');
    if (!claim || !fin) await this.lookupTxs(it, !claim, !fin);
    let verdict;
    try {
      verdict = await this.verify(it);
    } catch (e) {
      // never publish a result we could not reproduce
      it.phase = 'failed';
      it.error = e.message;
      this.log({ what: `verification failed: ${e.message}`, key: it.key, error: true });
      dropRun(this.runsPath, `${this.chainId}:${it.jobId}`, this.clock());
      return;
    }
    it.finalizedAt = new Date(this.clock()).toISOString();
    this.record(it, q, verdict);
    it.phase = 'done';
    this.log({ what: `done: ${it.steps} steps settled${verdict ? `, ${verdict.mismatches} mismatches over ${verdict.beats} inputs` : ''}`, key: it.key });
  }

  /// Another operator claimed or finalized: find those transactions from the events.
  async lookupTxs(it, claim, fin) {
    try {
      for (const [want, name, what] of [[claim, 'Claimed', 'claim'], [fin, 'Finalized', 'finalize']]) {
        if (!want) continue;
        const [ev] = await this.oc.queryFilter(this.oc.filters[name](it.jobId), it.postBlock ?? 0);
        if (ev) it.txs.push({ what, tx: ev.transactionHash, gas: Number((await this.provider.getTransactionReceipt(ev.transactionHash)).gasUsed) });
      }
    } catch (e) {
      this.log({ what: `could not look up transactions: ${e.shortMessage ?? e.message}`, key: it.key });
    }
  }

  // ---- runs.json

  record(it, q, verdict = null) {
    const bench = it.bench;
    const where = this.mode === 'mirror' ? ` (testnet mirror ${it.design.processor.slice(0, 8)}…#${it.design.id})` : '';
    const gas = Object.fromEntries(['post', 'claim', 'finalize'].map((w) => [w, it.txs.find((t) => t.what.replace(' job', '') === w)?.gas]));
    const known = Object.values(gas).every((g) => g != null);
    const final = it.phase === 'final' || it.phase === 'done';
    const perBlock = q.beatsPerBlock < 1 ? 'more than one block allows' : `${q.beatsPerBlock} a block allows`;
    const run = {
      id: `${this.chainId}:${it.jobId}`, chainId: this.chainId, overclock: (this.oc.target ?? this.overclock).toString(), jobId: it.jobId,
      circuit: { processor: q.processor, id: q.id, name: q.name, gates: q.gates, nIn: q.nIn, nOut: q.nOut, nState: q.nState, owner: q.owner },
      what: bench ? `Proof of Design: ${q.name} #${q.id} against its reference on all ${it.beats} inputs${where}` : `${it.beats} beats of ${q.name} #${q.id}, past the ${perBlock}${where}`,
      beats: it.beats, steps: it.steps, status: final ? 'final' : it.phase === 'claimed' && (it.disputes ?? 0) > 0 && !final ? 'challenged' : it.phase,
      fee: formatEther(this.fee), bond: formatEther(BigInt(it.bond)),
      directGas: (bench ? benchSize(benchCircuit(bench.design, bench.reference), (a, i) => this.circuits.get(refKey(a, i))).gates : q.gates) * it.beats * GAS_PER_GATE,
      gas: { ...Object.fromEntries(Object.entries(gas).filter(([, g]) => g != null)), ...(known ? { honestPath: gas.post + gas.claim + gas.finalize } : {}), ...(it.disputeGas ? { dispute: it.disputeGas } : {}) },
      ...(it.disputes ? { disputes: it.disputes, disputeTxs: it.disputeTxs } : {}),
      txs: it.txs.map(({ what, tx, gas: g }) => ({ what, tx, ...(g != null ? { gas: g } : {}) })),
      postedAt: it.postedAt, ...(final ? { finalizedAt: it.finalizedAt ?? new Date(this.clock()).toISOString() } : {}),
      source: `runner${this.mode === 'mirror' ? ' (mirror)' : ''}`,
    };
    if (final) run.outcome = bench ? (verdict.mismatches ? `The design fails on ${verdict.mismatches} of ${verdict.beats} inputs; the first is 0x${verdict.firstInput.toString(16)}.` : `The design matches its reference on all ${verdict.beats} inputs checked.`) : `The result was re-evaluated locally and matches; ${it.steps} steps settled.`;
    upsertRun(this.runsPath, run, { overclock: run.overclock }, this.clock());
    if (!bench || !verdict) return;
    upsertCertificate(this.runsPath, {
      id: `cert:${run.id}`, circuit: run.circuit,
      reference: { processor: bench.refSource.processor, id: bench.refSource.id, ...(bench.refSource.name ? { name: bench.refSource.name } : {}) },
      runId: run.id, inputs: verdict.beats, mismatches: verdict.mismatches,
      ...(verdict.mismatches ? { firstFailingInput: `0x${verdict.firstInput.toString(16)}` } : {}),
      status: verdict.mismatches ? 'failed' : 'certified', issuedAt: it.finalizedAt, txs: run.txs,
      ...(it.covers?.length ? { covers: [{ processor: q.processor, id: q.id }, ...it.covers] } : {}),
    }, this.clock());
  }
}

// ---- wiring from the environment (scripts/runner.js and bin/overclock-mcp.js) ----------------

const REPO = new URL('..', import.meta.url);

export async function connectLocal(signer, processor) {
  const circuits = new Contract(processor, CIRCUITS_FULL_ABI, signer);
  return { circuits, transistors: new Contract(await circuits.transistors(), TRANSISTORS_ABI, signer) };
}

/// Build a Runner from environment variables and options. `dry` needs no key and sends nothing.
export async function runnerFromEnv({ env = process.env, opts = {}, log = () => {} } = {}) {
  const num = (k, d) => (env[k] ? Number(env[k]) : d);
  const eth = (k, d) => parseEther(env[k] ?? d);
  const provider = new JsonRpcProvider(env.RPC_URL, undefined, { cacheTimeout: -1 });
  const chainId = Number((await provider.getNetwork()).chainId);
  const dep = (() => { const f = new URL(`deployments/${chainId}.json`, REPO); return existsSync(f) ? JSON.parse(readFileSync(f, 'utf8')) : {}; })();
  const overclock = env.OVERCLOCK ?? dep.overclock ?? (chainId === XLAYER.chainId ? XLAYER.overclock : null);
  if (!overclock) throw new Error('runner: set OVERCLOCK (no deployments file for this chain)');
  if (!env.RUNNER_KEY) throw new Error('runner: set RUNNER_KEY');
  const signer = new Wallet(env.RUNNER_KEY, provider);
  const mode = env.RUNNER_MODE ?? (chainId === XLAYER.chainId ? 'direct' : 'mirror');
  const processor = env.RUNNER_PROCESSOR ?? dep.machines?.life?.processor;
  const local = processor ? await connectLocal(signer, processor) : null;
  if (mode === 'mirror' && !local) throw new Error('runner: mirror mode needs RUNNER_PROCESSOR or deployments/<chain>.json');
  const path = (k, d) => env[k] ?? new URL(d, REPO).pathname;
  const refs = env.RUNNER_REFS ? JSON.parse(readFileSync(env.RUNNER_REFS, 'utf8')) : {};
  const census = JSON.parse(readFileSync(path('RUNNER_CENSUS', 'docs/census.json'), 'utf8'));
  const settle = async (rc) => { while ((await provider.getBlockNumber()) < rc.blockNumber) await new Promise((r) => setTimeout(r, 1000)); };
  return new Runner({
    oc: new Contract(overclock, artifact('Overclock').abi, signer), signer, provider, mode, local, refs, settle, log,
    source: mode === 'mirror' ? new JsonRpcProvider(env.MAINNET_RPC ?? MAINNET_RPC, undefined, { cacheTimeout: -1 }) : null,
    queue: buildQueue(census),
    statePath: path('RUNNER_STATE', `runner-state-${chainId}.json`), runsPath: path('RUNNER_RUNS', 'web/runs.json'),
    fee: eth('RUNNER_FEE', '0.00001'), floor: eth('RUNNER_FLOOR', '0.0005'), reserve: eth('RUNNER_RESERVE', '0.0003'), maxPerDay: eth('RUNNER_MAX_PER_DAY', '0.01'),
    maxSteps: num('RUNNER_MAX_STEPS', 100_000_000), parallel: num('RUNNER_PARALLEL', 1), pollMs: num('RUNNER_POLL_MS', 5000),
    stream: env.RUNNER_STREAM_DIR ? { above: 2 ** 27, dir: env.RUNNER_STREAM_DIR } : { above: 2 ** 27 },
    ...opts,
  });
}
