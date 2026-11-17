// FabX miner census: read every circuit on the FAB-Genisis processors named in
// docs/census.json, decode the netlists with the TAP-02 decoder, and group the
// miners into structural shapes.
//
//   node scripts/miner-shapes.js                     # top 30 shapes, no vector download
//   node scripts/miner-shapes.js --verify            # also run every distinct netlist
//                                                    # against its challenge's 256 vectors
//   node scripts/miner-shapes.js --all --json /tmp/miner-shapes.json
//
// Read-only: eth_call and GET only. No keys, no transactions.
//
// What a shape is:
//   family   nIn / nOut / nState / gateCount
//   shape    family + structHash, where structHash = keccak256(netlist bytes)
//            (topoHash is also computed: the same structure with every signal
//            renumbered relative to its producer; no renumber-only twins exist
//            on the live processors, so the two hashes group identically)
//
// The verdict per shape is about whether Overclock can certify it from a
// published spec: YES-vectors when the 256 official vectors cover the whole
// input space, YES-ref when only the on-chain official reference is available
// (equivalence certificate), NO-degenerate when the published vectors are
// constant and therefore vacuous, NO-unclaimed when no task is claimed.

import { JsonRpcProvider, Contract, Interface, keccak256, toUtf8Bytes } from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';
import { decode, load, beat, unpack, hexToBytes, NAND, LATCH, REF } from '../src/tap02.js';

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : fallback;
};
const flag = (name) => process.argv.includes(`--${name}`);

export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const POD_MINING = '0x4F6A2312D80753BdAFd35DDB1Bf4BB14C43F8265';
export const TASKS_API = 'https://api.fabx.tech/v1/pod/tasks';

export const CIRCUIT_INFO_ABI = new Interface([
  'function circuitInfo(uint256) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)',
  'function netlist(uint256) view returns (bytes)',
  'function nextId() view returns (uint256)',
]);
export const MINING_ABI = new Interface([
  'function taskCount() view returns (uint32)',
  'function processorMultiplier(address) view returns (uint256)',
  'function getTask(uint32) view returns (tuple(uint8 kind, uint32 cycles, uint32 nIn, uint32 nOut, uint32 vectorCount, bool active, bytes32 vectorsRoot, string name, uint64 refArea, uint256 refCost, address refCircuits, uint64 refCircuitId))',
  'function minerKey(address,uint256) pure returns (bytes32)',
  'function getMiner(bytes32) view returns (tuple(address circuits, uint64 circuitId, uint32 taskId, uint32 gateCount, uint32 stateCount, uint32 depth, uint64 area, uint32 mult, uint64 since, uint8 status, address registrant, uint32 nandBurn, uint32 latchBurn, uint64 bstar, uint64 bonus, bool optimal, uint64 commitBlock, uint64 firstUnusedId, uint64 stopBlock, uint128 verifWeight, uint128 unverWeight, uint256 debt, uint32 boostBps))',
]);
const AGGREGATE3 = ['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])'];

// ---------------------------------------------------------------- netlist hash

// Canonical topology: opcode, each input as a constant/input/relative reference
// and the output arity. Two netlists that differ only by signal renumbering get
// the same hash; a different gate order or a changed gate does not.
export function topologyHash(elements, nIn) {
  const parts = elements.map((e) => {
    const ins = e.ins.map((s) => (s === 0 ? 'c0' : s === 1 ? 'c1' : s < 2 + nIn ? `i${s - 2}` : `r${s - e.firstOut}`)).join(',');
    return `${e.op}:${ins}:${e.nOut}`;
  });
  return keccak256(toUtf8Bytes(parts.join('|')));
}

// Decode a netlist and return its counts and both structural hashes.
export function describeNetlist(netlist, nIn) {
  const bytes = hexToBytes(netlist);
  const elements = decode(bytes, nIn);
  let nand = 0, latch = 0, ref = 0;
  for (const e of elements) {
    if (e.op === NAND) nand++;
    else if (e.op === LATCH) latch++;
    else if (e.op === REF) ref++;
  }
  return {
    elements: elements.length,
    nand,
    latch,
    ref,
    structHash: keccak256(bytes),
    topoHash: topologyHash(elements, nIn),
  };
}

// --------------------------------------------------------------- shape groups

export const familyKey = (r) => `${r.nIn}/${r.nOut}/${r.nState}/${r.gates}`;
export const shapeKey = (r) => `${familyKey(r)}/${r.structHash}`;

export function groupShapes(records) {
  const groups = new Map();
  for (const r of records) {
    const key = shapeKey(r);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        nIn: r.nIn,
        nOut: r.nOut,
        nState: r.nState,
        gates: r.gates,
        structHash: r.structHash,
        count: 0,
        refCopies: 0,
        netlist: r.netlist,
        ids: [],
        processors: new Set(),
        tasks: new Map(),
        statuses: new Map(),
      };
      groups.set(key, g);
    }
    g.count++;
    g.ids.push(r.id);
    g.processors.add(r.processor);
    if (r.isReference) g.refCopies++;
    if (r.taskId) g.tasks.set(r.taskId, (g.tasks.get(r.taskId) ?? 0) + 1);
    if (r.status !== undefined) g.statuses.set(r.status, (g.statuses.get(r.status) ?? 0) + 1);
  }
  return [...groups.values()].map((g) => ({
    ...g,
    processors: [...g.processors],
    tasks: [...g.tasks.entries()].sort((a, b) => b[1] - a[1]),
    statuses: Object.fromEntries(g.statuses),
  }));
}

export function groupFamilies(records) {
  const groups = new Map();
  for (const r of records) {
    const key = familyKey(r);
    let g = groups.get(key);
    if (!g) {
      g = { key, nIn: r.nIn, nOut: r.nOut, nState: r.nState, gates: r.gates, count: 0, miners: 0, refCopies: 0, hashes: new Set(), tasks: new Map(), ids: [] };
      groups.set(key, g);
    }
    g.count++;
    g.ids.push(r.id);
    if (r.taskId) g.miners++;
    if (r.isReference) g.refCopies++;
    g.hashes.add(r.structHash);
    if (r.taskId) g.tasks.set(r.taskId, (g.tasks.get(r.taskId) ?? 0) + 1);
  }
  return [...groups.values()].map((g) => ({ ...g, hashes: g.hashes.size, tasks: [...g.tasks.entries()].sort((a, b) => b[1] - a[1]) }));
}

// Record-level diff. Gate positions that match exactly from either end are kept;
// the middle is what changed. A one- or two-gate edit near the end reads as
// "derived"; a wholesale different netlist reads as "independent".
export function diffNetlists(aHex, bHex, nInA, nInB = nInA) {
  const a = decode(hexToBytes(aHex), nInA);
  const b = decode(hexToBytes(bHex), nInB);
  const same = (x, y) => x.op === y.op && x.nOut === y.nOut && x.ins.length === y.ins.length && x.ins.every((s, i) => s === y.ins[i]);
  let p = 0;
  while (p < a.length && p < b.length && same(a[p], b[p])) p++;
  let ea = a.length - 1, eb = b.length - 1, suffix = 0;
  while (ea >= p && eb >= p && same(a[ea], b[eb])) { suffix++; ea--; eb--; }
  const d = { commonPrefix: p, commonSuffix: suffix, changedA: ea - p + 1, changedB: eb - p + 1, lenA: a.length, lenB: b.length };
  const shared = d.commonPrefix + d.commonSuffix;
  const smaller = Math.min(d.lenA, d.lenB);
  d.class = d.changedA === 0 && d.changedB === 0 && d.lenA === d.lenB ? 'identical'
    : shared >= smaller * 0.9 || (Math.min(d.changedA, d.changedB) <= 2 && shared >= smaller * 0.5) ? 'derived'
      : 'independent';
  return d;
}

// ------------------------------------------------------------------ verifiers

// Run FabX's official vectors. Each vector is { input, expectedOut } in hex.
// Sequential tasks feed `cycles` input frames and compare every output frame.
export function verifyNetlist(netlist, nIn, nOut, vectors, cycles = 1) {
  const circuit = load(hexToBytes(netlist), nIn, nOut);
  const inFrame = Math.ceil(nIn / 8);
  const outFrame = Math.ceil(nOut / 8);
  let passed = 0;
  let firstFailure = null;
  for (const [i, v] of vectors.entries()) {
    const input = hexToBytes(v.input);
    const expected = hexToBytes(v.expectedOut);
    let state = new Array(circuit.nState).fill(0);
    let ok = true;
    let failure = null;
    for (let k = 0; k < cycles; k++) {
      const frame = unpack(input.slice(k * inFrame, (k + 1) * inFrame), nIn);
      const [next, out] = beat(circuit, state, frame);
      state = next;
      const exp = unpack(expected.slice(k * outFrame, (k + 1) * outFrame), nOut);
      if (out.length !== exp.length || out.some((x, i) => x !== exp[i])) {
        ok = false;
        failure = { index: v.index ?? i, cycle: k, input: v.input, expected: v.expectedOut, got: out.join('') };
        break;
      }
    }
    if (ok) passed++;
    else if (!firstFailure) firstFailure = failure;
  }
  return { passed, total: vectors.length, firstFailure };
}

// Verify a local beat sequence (vendor-tap02 vectors carry these for sequential
// circuits): state starts at zero and carries beat to beat.
export function verifyBeats(netlist, nIn, nOut, beats) {
  const circuit = load(hexToBytes(netlist), nIn, nOut);
  let state = new Array(circuit.nState).fill(0);
  let passed = 0;
  let firstFailure = null;
  for (let i = 0; i < beats.length; i++) {
    const b = beats[i];
    const [next, out] = beat(circuit, state, unpack(hexToBytes(b.inputs), nIn));
    const got = out.join('');
    const newState = next.join('');
    // vendor vectors write bits MSB-first in the string, while inputs are packed
    // by the test helper; compare against the expected strings after packing.
    const expected = beatExpected(b, nOut, circuit.nState);
    if (got === expected.outputs && newState === expected.newState) passed++;
    else if (!firstFailure) firstFailure = { index: i, expected, got: { outputs: got, newState } };
    state = next;
  }
  return { passed, total: beats.length, firstFailure };
}

function beatExpected(beatRow, nOut, nState) {
  return {
    outputs: unpack(hexToBytes(beatRow.outputs), nOut).join(''),
    newState: unpack(hexToBytes(beatRow.newState), nState).join(''),
  };
}

// ------------------------------------------------------------------ task info

export function vectorsAreExhaustive(task, vectors) {
  if (task.kind !== 0 || task.cycles !== 1) return false;
  const inputs = new Set(vectors.map((v) => v.input.toLowerCase()));
  return inputs.size >= 2 ** task.nIn;
}

export function vectorsAreDegenerate(vectors) {
  const outs = new Set(vectors.map((v) => v.expectedOut.toLowerCase()));
  return outs.size === 1 && /^0x0*$/.test([...outs][0]);
}

// One task's certificate source. Returns a machine-readable verdict and reason.
export function taskVerdict(task, vectors) {
  if (!task.refCircuits || BigInt(task.refCircuitId) === 0n) return { verdict: 'NO-ref', reason: 'no on-chain reference' };
  if (!vectors) return { verdict: 'YES-ref', reason: 'reference available; vectors not downloaded' };
  if (vectorsAreDegenerate(vectors)) return { verdict: 'NO-degenerate', reason: 'all official vectors expect constant zero' };
  if (vectorsAreExhaustive(task, vectors)) return { verdict: 'YES-vectors', reason: `${vectors.length} vectors cover all 2^${task.nIn} inputs` };
  return { verdict: 'YES-ref', reason: `vectors sample ${new Set(vectors.map((v) => v.input)).size} of 2^${task.nIn} inputs; use reference equivalence` };
}

// The shape verdict is the worst verdict among the challenges its miners claim.
export function shapeVerdict(tasks) {
  if (!tasks.length) return { verdict: 'NO-unclaimed', reason: 'no claimed challenge' };
  const verdictOf = (t) => t.verdict?.verdict ?? t.verdict;
  const order = { 'NO-degenerate': 0, 'NO-ref': 1, 'YES-ref': 2, 'YES-vectors': 3 };
  const sorted = [...tasks].sort((a, b) => (order[verdictOf(a)] ?? 0) - (order[verdictOf(b)] ?? 0));
  return { verdict: verdictOf(sorted[0]), reason: sorted.map((t) => `GC-${String(t.taskId).padStart(3, '0')}:${verdictOf(t)}`).join(' ') };
}

// ------------------------------------------------------------------ chain I/O

const chunks = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

// Free public RPCs drop connections under load. Retry the call, never the whole scan.
async function retry(fn) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt >= 4) throw e;
      await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
    }
  }
}

async function multicall(mc, calls) {
  const out = [];
  for (const ch of chunks(calls, 400)) {
    const res = await retry(() => mc.aggregate3.staticCall(ch));
    out.push(...res);
  }
  return out;
}

async function readCircuits(provider, mc, processor, limit) {
  const circuits = new Contract(processor, CIRCUIT_INFO_ABI, provider);
  const nextId = Number(await retry(() => circuits.nextId()));
  const ids = Array.from({ length: Math.max(0, nextId - 1) }, (_, i) => i + 1).slice(0, limit ?? undefined);
  const infoCalls = ids.map((id) => ({ target: processor, allowFailure: true, callData: CIRCUIT_INFO_ABI.getFunction('circuitInfo').selector + id.toString(16).padStart(64, '0') }));
  const info = await multicall(mc, infoCalls);
  const rows = [];
  for (let i = 0; i < ids.length; i++) {
    if (!info[i]?.[0]) continue;
    const [nIn, nOut, nState, gates] = CIRCUIT_INFO_ABI.decodeFunctionResult('circuitInfo', info[i][1]);
    rows.push({ processor, id: ids[i], nIn: Number(nIn), nOut: Number(nOut), nState: Number(nState), gates: Number(gates) });
  }
  const netlistCalls = rows.map((r) => ({ target: processor, allowFailure: true, callData: CIRCUIT_INFO_ABI.getFunction('netlist').selector + r.id.toString(16).padStart(64, '0') }));
  const netlists = await multicall(mc, netlistCalls);
  for (let i = 0; i < rows.length; i++) {
    rows[i].netlist = netlists[i]?.[0] ? CIRCUIT_INFO_ABI.decodeFunctionResult('netlist', netlists[i][1])[0] : null;
  }
  return { nextId, rows };
}

async function readTasks(provider, mc) {
  const mining = new Contract(POD_MINING, MINING_ABI, provider);
  const count = Number(await retry(() => mining.taskCount()));
  const calls = Array.from({ length: count }, (_, i) => ({ target: POD_MINING, allowFailure: true, callData: MINING_ABI.getFunction('getTask').selector + (i + 1).toString(16).padStart(64, '0') }));
  const res = await multicall(mc, calls);
  const tasks = new Map();
  for (let i = 0; i < count; i++) {
    if (!res[i]?.[0]) continue;
    const t = MINING_ABI.decodeFunctionResult('getTask', res[i][1])[0];
    tasks.set(i + 1, {
      taskId: i + 1,
      kind: Number(t.kind),
      cycles: Number(t.cycles),
      nIn: Number(t.nIn),
      nOut: Number(t.nOut),
      vectorCount: Number(t.vectorCount),
      active: t.active,
      vectorsRoot: t.vectorsRoot,
      name: t.name,
      refArea: Number(t.refArea),
      refCost: t.refCost,
      refCircuits: t.refCircuits,
      refCircuitId: t.refCircuitId,
    });
  }
  return tasks;
}

async function readMiners(provider, mc, processor, ids) {
  const keyCalls = ids.map((id) => ({ target: POD_MINING, allowFailure: true, callData: MINING_ABI.getFunction('minerKey').selector + processor.slice(2).padStart(64, '0') + id.toString(16).padStart(64, '0') }));
  const keyRes = await multicall(mc, keyCalls);
  const keys = keyRes.map((r) => (r?.[0] ? MINING_ABI.decodeFunctionResult('minerKey', r[1])[0] : null));
  const calls = keys.map((k) => k && ({ target: POD_MINING, allowFailure: true, callData: MINING_ABI.getFunction('getMiner').selector + k.slice(2) }));
  const res = await multicall(mc, calls);
  const miners = new Map();
  for (let i = 0; i < ids.length; i++) {
    if (!keys[i] || !res[i]?.[0]) continue;
    const m = MINING_ABI.decodeFunctionResult('getMiner', res[i][1])[0];
    if (m.circuits === '0x0000000000000000000000000000000000000000') continue;
    miners.set(ids[i], {
      taskId: Number(m.taskId),
      status: Number(m.status),
      registrant: m.registrant,
      depth: Number(m.depth),
      area: Number(m.area),
      bstar: Number(m.bstar),
      optimal: m.optimal,
      commitBlock: Number(m.commitBlock),
      since: Number(m.since),
    });
  }
  return miners;
}

async function readReferences(provider, mc, tasks) {
  const refs = new Map();
  for (const t of tasks.values()) {
    if (!t.refCircuits || BigInt(t.refCircuitId) === 0n) continue;
    const id = Number(t.refCircuitId);
    const ref = new Contract(t.refCircuits, CIRCUIT_INFO_ABI, provider);
    const info = await retry(() => ref.circuitInfo(id));
    const netlist = await retry(() => ref.netlist(id));
    const d = describeNetlist(netlist, Number(info.nIn));
    refs.set(t.taskId, {
      processor: t.refCircuits,
      id,
      nIn: Number(info.nIn),
      nOut: Number(info.nOut),
      nState: Number(info.nState),
      gates: Number(info.gateCount),
      netlist,
      ...d,
    });
  }
  return refs;
}

async function readVectors(taskIds, quiet) {
  const out = new Map();
  const queue = [...taskIds];
  const workers = Array.from({ length: 8 }, async () => {
    while (queue.length) {
      const id = queue.shift();
      try {
        const body = await retry(async () => {
          const r = await fetch(`${TASKS_API}/${id}/vectors?chainId=196`);
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        });
        out.set(id, body.vectors);
      } catch (e) {
        if (!quiet) console.warn(`vectors GC-${String(id).padStart(3, '0')}: ${e.message}`);
      }
    }
  });
  await Promise.all(workers);
  return out;
}

// ------------------------------------------------------------------ reporting

const fmtHash = (h, full) => (full ? h : `${h.slice(0, 10)}…`);
const pad = (s, n) => String(s).padEnd(n);
const lpad = (s, n) => String(s).padStart(n);

function printShapeTable(shapes, tasks, opts) {
  const rows = opts.all ? shapes : shapes.slice(0, opts.top);
  console.log('\nSTRUCTURAL SHAPES (nIn/nOut/nState/gates + keccak256 of netlist)');
  console.log(`${'#'.padStart(3)} ${'copies'.padStart(6)} ${'refCopies'.padStart(9)}  ${pad('shape', 20)} ${pad('structHash', 14)} ${pad('tasks', 18)} ${pad('verdict', 12)} ${pad('vectors', 7)} template`);
  for (let i = 0; i < rows.length; i++) {
    const s = rows[i];
    const t = s.tasks.map(([id]) => `GC-${String(id).padStart(3, '0')}`).join(',') || '-';
    const v = s.verdict?.verdict ?? '?';
    console.log(`${lpad(i + 1, 3)} ${lpad(s.count, 6)} ${lpad(s.refCopies, 9)}  ${pad(`${s.nIn}/${s.nOut}/${s.nState}/${s.gates}`, 20)} ${pad(fmtHash(s.structHash, opts.fullHash), 14)} ${pad(t, 18)} ${pad(v, 12)} ${pad(opts.verify ? s.vectors ?? '-' : '-', 7)} ${s.templateClass ?? ''}`);
  }
  if (!opts.all && shapes.length > rows.length) console.log(`... ${shapes.length - rows.length} more shapes (use --all)`);
}

function printFamilyTable(families, opts) {
  const rows = opts.all ? families : families.slice(0, opts.top);
  console.log('\nSHAPE FAMILIES (dims only; a family can hold several netlists and several tasks)');
  console.log(`${'#'.padStart(3)} ${'circuits'.padStart(8)} ${'miners'.padStart(7)} ${'refCopies'.padStart(9)} ${'netlists'.padStart(8)}  ${pad('shape', 20)} ${pad('tasks', 24)} verdict`);
  for (let i = 0; i < rows.length; i++) {
    const f = rows[i];
    const t = f.tasks.map(([id, n]) => `GC-${String(id).padStart(3, '0')}:${n}`).join(',') || '-';
    console.log(`${lpad(i + 1, 3)} ${lpad(f.count, 8)} ${lpad(f.miners, 7)} ${lpad(f.refCopies, 9)} ${lpad(f.hashes, 8)}  ${pad(`${f.nIn}/${f.nOut}/${f.nState}/${f.gates}`, 20)} ${pad(t, 24)} ${f.verdict?.verdict ?? '?'}`);
  }
  if (!opts.all && families.length > rows.length) console.log(`... ${families.length - rows.length} more families (use --all)`);
}

// ---------------------------------------------------------------------- main

async function main() {
  const rpc = arg('rpc', process.env.RPC_URL ?? 'https://rpc.xlayer.tech');
  const jsonPath = arg('json', null);
  const limit = arg('limit', null) ? Number(arg('limit', null)) : null;
  const opts = {
    all: flag('all'),
    top: Number(arg('top', 30)),
    verify: flag('verify'),
    noVectors: flag('no-vectors'),
    fullHash: flag('full-hash'),
    quiet: flag('quiet'),
  };
  const provider = new JsonRpcProvider(rpc);
  const mc = new Contract(MULTICALL3, AGGREGATE3, provider);
  const block = await retry(() => provider.getBlockNumber());
  const chain = await retry(() => provider.getNetwork());

  const census = JSON.parse(readFileSync(new URL('../docs/census.json', import.meta.url)));
  const fromCensus = [...new Set(census.heldBack.filter((r) => /FAB/i.test(r.processorName ?? '')).map((r) => r.processor))];
  const processors = process.argv.filter((a, i) => process.argv[i - 1] === '--processor');
  const list = processors.length ? processors : fromCensus;
  console.log(`chain ${chain.chainId}, block ${block}`);
  console.log(`processors: ${list.join(', ')}`);

  const tasks = await readTasks(provider, mc);
  const refs = await readReferences(provider, mc, tasks);
  console.log(`tasks: ${tasks.size}; on-chain references: ${refs.size}`);

  const records = [];
  const processorsInfo = [];
  for (const processor of list) {
    const multiplier = await retry(() => new Contract(POD_MINING, MINING_ABI, provider).processorMultiplier(processor));
    const { nextId, rows } = await readCircuits(provider, mc, processor, limit);
    const miners = Number(multiplier) > 0 ? await readMiners(provider, mc, processor, rows.map((r) => r.id)) : new Map();
    let bad = 0, refsOn = 0;
    for (const r of rows) {
      if (!r.netlist) { bad++; continue; }
      const d = describeNetlist(r.netlist, r.nIn);
      if (d.elements !== r.gates) bad++;
      const m = miners.get(r.id);
      const taskId = m?.taskId ?? null;
      const ref = taskId ? refs.get(taskId) : null;
      if (ref && ref.structHash === d.structHash) refsOn++;
      records.push({
        processor,
        id: r.id,
        nIn: r.nIn,
        nOut: r.nOut,
        nState: r.nState,
        gates: r.gates,
        netlist: r.netlist,
        ...d,
        taskId,
        status: m?.status,
        isReference: Boolean(ref && ref.structHash === d.structHash && ref.nIn === r.nIn && ref.nOut === r.nOut && ref.nState === r.nState && ref.gates === r.gates),
      });
    }
    processorsInfo.push({ processor, nextId, read: rows.length, multiplier: Number(multiplier), miners: miners.size, refCopies: refsOn, decodeMismatches: bad });
    console.log(`  ${processor}: nextId ${nextId}, read ${rows.length}, multiplier ${Number(multiplier)}, miners ${miners.size}, reference copies ${refsOn}, decode mismatches ${bad}`);
  }

  // Task metadata and official vector sets.
  const usedTasks = [...new Set(records.map((r) => r.taskId).filter((t) => t && t > 0))];
  const vectors = opts.noVectors ? new Map() : await readVectors(usedTasks, opts.quiet);
  const annotatedTasks = new Map();
  for (const id of usedTasks) {
    const task = tasks.get(id);
    if (!task) continue;
    annotatedTasks.set(id, { ...task, verdict: taskVerdict(task, vectors.get(id)), ref: refs.get(id) ?? null, vectors: vectors.get(id) ?? null });
  }

  const shapes = groupShapes(records);
  const families = groupFamilies(records);

  // Attach task verdicts, template diff and per-shape verification.
  for (const f of families) {
    const familyShapes = shapes.filter((s) => s.nIn === f.nIn && s.nOut === f.nOut && s.nState === f.nState && s.gates === f.gates).sort((a, b) => b.count - a.count);
    const template = familyShapes[0];
    for (const s of familyShapes) {
      s.templateClass = s === template ? 'template' : diffNetlists(s.netlist ?? records.find((r) => r.structHash === s.structHash).netlist, records.find((r) => r.structHash === template.structHash).netlist, s.nIn, template.nIn).class;
    }
    f.verdict = shapeVerdict(f.tasks.map(([id]) => annotatedTasks.get(id)).filter(Boolean));
    f.template = template ? { structHash: template.structHash, count: template.count } : null;
  }
  for (const s of shapes) {
    s.verdict = shapeVerdict(s.tasks.map(([id]) => annotatedTasks.get(id)).filter(Boolean));
  }
  shapes.sort((a, b) => b.count - a.count || b.refCopies - a.refCopies);
  families.sort((a, b) => b.count - a.count || b.refCopies - a.refCopies);

  // Optional: run every distinct netlist against its task's 256 vectors.
  let verified = null;
  const pairResults = new Map();
  if (opts.verify) {
    verified = { netlists: 0, passed: 0, failed: 0, skipped: 0, failures: [] };
    const seen = new Map();
    for (const r of records) {
      if (!r.taskId) continue;
      const key = `${r.taskId}:${r.structHash}`;
      if (seen.has(key)) continue;
      seen.set(key, r);
      const task = tasks.get(r.taskId);
      const vs = vectors.get(r.taskId);
      if (!task || !vs) { verified.skipped++; continue; }
      let res;
      try { res = verifyNetlist(r.netlist, r.nIn, r.nOut, vs, task.cycles); }
      catch (e) { res = { passed: 0, total: vs.length, firstFailure: { error: e.message } }; }
      verified.netlists++;
      if (res.passed === res.total) verified.passed++;
      else {
        verified.failed++;
        if (verified.failures.length < 20) verified.failures.push({ processor: r.processor, id: r.id, taskId: r.taskId, ...res });
      }
      pairResults.set(key, res);
    }
    shapes.forEach((s) => {
      const pairs = s.tasks.map(([id]) => pairResults.get(`${id}:${s.structHash}`)).filter(Boolean);
      s.vectors = !pairs.length ? 'n/a' : pairs.every((p) => p.passed === p.total) ? 'pass' : 'FAIL';
    });
    const failedShapes = shapes.filter((s) => s.vectors === 'FAIL').length;
    console.log(`\nverification: ${verified.passed}/${verified.netlists} distinct (challenge, netlist) pairs pass all official vectors; ${verified.failed} fail; ${verified.skipped} skipped; ${failedShapes} shapes contain a failure`);
    for (const f of verified.failures) console.log(`  FAIL ${f.processor} #${f.id} GC-${String(f.taskId).padStart(3, '0')}: ${f.passed}/${f.total} ${JSON.stringify(f.firstFailure)}`);
  }

  // Summary numbers.
  const claimed = records.filter((r) => r.taskId && r.taskId > 0);
  const verdictCounts = {};
  for (const s of shapes) {
    const v = s.verdict.verdict;
    verdictCounts[v] ??= { shapes: 0, circuits: 0, claimed: 0 };
    verdictCounts[v].shapes++;
    verdictCounts[v].circuits += s.count;
    verdictCounts[v].claimed += s.tasks.reduce((n, [, c]) => n + c, 0);
  }
  const summary = {
    chainId: Number(chain.chainId),
    block,
    processors: processorsInfo,
    circuits: records.length,
    claimed: claimed.length,
    unclaimed: records.length - claimed.length,
    referenceCopies: records.filter((r) => r.isReference).length,
    referenceCopyPct: Number(((100 * records.filter((r) => r.isReference).length) / Math.max(1, claimed.length)).toFixed(1)),
    distinctNetlists: new Set(records.map((r) => r.structHash)).size,
    distinctTopologies: new Set(records.map((r) => r.topoHash)).size,
    families: families.length,
    shapes: shapes.length,
    verdicts: verdictCounts,
    verification: verified,
    tasksWithMiners: usedTasks.length,
  };
  console.log('\nSUMMARY');
  console.log(JSON.stringify(summary, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
  console.log(`\nclaimed miners: ${summary.claimed}/${summary.circuits}; byte-identical to the official reference: ${summary.referenceCopies} (${summary.referenceCopyPct}% of claimed)`);
  console.log(`distinct netlists: ${summary.distinctNetlists}; distinct topologies: ${summary.distinctTopologies}; families: ${summary.families}; structural shapes: ${summary.shapes}`);

  printFamilyTable(families, opts);
  printShapeTable(shapes, tasks, opts);

  if (jsonPath) {
    const out = {
      summary,
      tasks: [...annotatedTasks.values()].map((t) => ({
        taskId: t.taskId, name: t.name, kind: t.kind, cycles: t.cycles, nIn: t.nIn, nOut: t.nOut,
        refCircuits: t.refCircuits, refCircuitId: String(t.refCircuitId), refArea: t.refArea, refCost: String(t.refCost),
        verdict: t.verdict,
      })),
      processors: processorsInfo,
      families,
      shapes: shapes.map((s) => ({ ...s, netlist: undefined })),
    };
    writeFileSync(jsonPath, JSON.stringify(out, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1));
    console.log(`\nwrote ${jsonPath}`);
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
