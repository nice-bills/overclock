// FabX miner certificates: prove a design equals its Gate Challenge's official reference on a
// settled Overclock job, or catch it on the exact input the published vectors fail.
//
// The pieces, in the order certifyMiner() uses them:
//
//   1. Claim lookup.  PodMining.minerKey(processor, id) -> getMiner -> taskId.
//   2. Reference.     getTask(taskId) names the official reference processor and circuit id
//                     (0x265E…653C, id == taskId for every challenge today). Both the design and
//                     the reference are read with free eth_calls and mirrored into a TapeOutLocal
//                     stand-in with src/mirror.js, refs rewired.
//   3. Official check. The 256 vectors from the FabX public API are replayed with src/tap02.js.
//                     A failing vector fixes the exact first failing input and cycle; this is what
//                     the research doc reports for #2346, #4890 and #4897.
//   4. Bench.         src/bench.js builds one circuit that runs both sides on every input (counter
//                     for stateless designs, LFSR from reset for stateful ones). If the official
//                     vectors already fail, a fixed-frame bench replays that vector from reset so
//                     the failure itself is what the job settles.
//   5. Job.           Tape the bench out, postJob / claim / finalize on Overclock, read result().
//   6. Certificate.   docs/certificates/<processor>-<id>.json plus a web/runs.json entry. Circuits
//                     with the same challenge and byte-identical netlist share one certificate:
//                     `covers` lists them all.
//
// Every write in this file goes to the destination the caller passes (a local ganache or the
// testnet TapeOutLocal). certifyMiner refuses a mainnet or testnet destination.
//
// Reported issue in src/bench.js (not edited here): its LFSR/counter inputs cannot replay the
// official sequential vectors, which are `cycles` input frames from reset. That is why a failing
// sequential design (#2346, GC-094) passes the LFSR bench yet fails the official vectors. The
// fixed-frame bench below is the minimal addition needed; src/bench.js could grow a `frames` mode
// with the same layout.

import { Contract, Interface, JsonRpcProvider, formatEther, keccak256 } from 'ethers';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Builder } from './hdl.js';
import {
  LATCH, NAND, REF, beat, bytesToHex, decode, hexToBytes, load, pack, unpack,
} from './tap02.js';
import {
  benchCircuit, benchSize, benchState, expectedVerdict, verdict,
} from './bench.js';
import { refKey, fetchCircuit, mirrorCircuit } from './mirror.js';
import { loadCircuit } from './chain.js';
import { burnCost, mint as mintTransistors, tapeout } from './tapeout.js';
import { Tree, traceJob } from './trace.js';

export const MAINNET_RPC = 'https://rpc.xlayer.tech';
export const MAINNET_CHAIN_ID = 196;
export const OLD_PROCESSOR = '0x00586A4C37039aCbFC6aC135cAdd49367ABf390A';
export const MINER_PROCESSOR = '0x87BFCa3494Aa228fF589ab9B642143A5e8c8F9a6';
export const REFERENCE_PROCESSOR = '0x265E2580cB9c3FC059f2AA3cf20ad30F3F0A653C';
export const MULTICALL3 = '0xcA11bde05977b3631167028862bE2a173976CA11';
export const POD_MINING = '0x4F6A2312D80753BdAFd35DDB1Bf4BB14C43F8265';
export const TASKS_API = 'https://api.fabx.tech/v1/pod/tasks';

// From docs/fabx-research.md §2 and §8. Read-only ids: the three miners marked verified on-chain
// that fail the official vectors. Kept here so `--known-failing` reproduces the finding.
export const KNOWN_FAILING = [
  { processor: MINER_PROCESSOR, id: 2346, taskId: 94, firstInput: '0x0302000200', cycle: 4 },
  { processor: MINER_PROCESSOR, id: 4890, taskId: 13, firstInput: '0x00', cycle: 0 },
  { processor: MINER_PROCESSOR, id: 4897, taskId: 14, firstInput: '0x00', cycle: 0 },
];

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
const AGGREGATE3_ABI = ['function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])'];

const ZERO = '0x0000000000000000000000000000000000000000';
const hex = (v) => (typeof v === 'string' ? v.toLowerCase() : bytesToHex(v));
const asBytes = (v) => (v instanceof Uint8Array ? v : hexToBytes(String(v)));
const inputBits = (v, n) => Array.from({ length: n }, (_, i) => (Number(v) >> i) & 1);
const bitsValue = (bs) => bs.reduce((v, b, i) => v + b * 2 ** i, 0);

// Pack an input value the way TAP-02 vectors do: bit i is bit (i & 7) of byte (i >> 3).
export function inputHex(value, nIn) {
  return bytesToHex(pack(inputBits(value, nIn)));
}

// --------------------------------------------------------------------- fingerprints

// The same canonical topology as scripts/miner-shapes.js: signal numbers are rewritten relative
// to their producer, so two netlists that differ only by renumbering hash alike.
export function topologyHash(elements, nIn) {
  const parts = elements.map((e) => {
    const ins = e.ins.map((s) => (s === 0 ? 'c0' : s === 1 ? 'c1' : s < 2 + nIn ? `i${s - 2}` : `r${s - e.firstOut}`)).join(',');
    return `${e.op}:${ins}:${e.nOut}`;
  });
  return keccak256(new TextEncoder().encode(parts.join('|')));
}

export function describeNetlist(netlist, nIn) {
  const bytes = asBytes(netlist);
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
    netlistHash: keccak256(bytes),
    structHash: keccak256(bytes),
    topoHash: topologyHash(elements, nIn),
  };
}

export function fingerprint(circuit) {
  const d = describeNetlist(circuit.netlist, circuit.nIn);
  return {
    nIn: circuit.nIn,
    nOut: circuit.nOut,
    nState: circuit.nState,
    gates: circuit.gateCount ?? d.elements,
    netlistBytes: asBytes(circuit.netlist).length,
    netlistHash: d.netlistHash,
    structHash: d.structHash,
    topoHash: d.topoHash,
    nand: d.nand,
    latch: d.latch,
    ref: d.ref,
  };
}

// --------------------------------------------------------------------- shape grouping

export function challengeName(taskId) {
  return `GC-${String(taskId).padStart(3, '0')}`;
}

// A shape certificate covers one challenge and one byte-identical netlist. Dimensions are part of
// the key because the same bytes decoded with a different nIn are a different circuit.
export function shapeKey(record) {
  return `${record.taskId}:${record.nIn}/${record.nOut}/${record.nState}:${record.structHash}`;
}

export function groupMinerShapes(records) {
  const groups = new Map();
  for (const r of records) {
    if (!r.taskId) continue;
    const key = shapeKey(r);
    let g = groups.get(key);
    if (!g) {
      g = {
        key,
        taskId: Number(r.taskId),
        structHash: r.structHash,
        nIn: r.nIn,
        nOut: r.nOut,
        nState: r.nState,
        gates: r.gates,
        count: 0,
        ids: [],
        covers: [],
        processors: new Set(),
      };
      groups.set(key, g);
    }
    g.count++;
    g.ids.push(r.id);
    g.covers.push({ processor: r.processor, id: r.id });
    g.processors.add(r.processor);
  }
  return [...groups.values()]
    .map((g) => ({
      ...g,
      processors: [...g.processors],
      ids: [...g.ids].sort((a, b) => a - b),
      covers: [...g.covers].sort((a, b) => a.id - b.id),
    }))
    .sort((a, b) => b.count - a.count || a.ids[0] - b.ids[0]);
}

// --------------------------------------------------------------------- official vectors

// Replay FabX's official vectors. A vector carries `cycles` input frames for a sequential task,
// each frame ceil(nIn/8) bytes, and the matching output frames. State starts at zero for every
// vector, exactly as FabX's verify API documents.
export function officialCheck(design, task, vectors) {
  const nIn = Number(design.nIn);
  const nOut = Number(design.nOut);
  const cycles = Math.max(1, Number(task.cycles ?? 1));
  const inFrame = Math.ceil(nIn / 8);
  const outFrame = Math.ceil(nOut / 8);
  const circuit = load(asBytes(design.netlist), nIn, nOut);
  const unique = new Set();
  const expectedOuts = new Set();
  let passed = 0;
  let firstFailure = null;

  for (const [i, v] of vectors.entries()) {
    const input = hexToBytes(v.input);
    const expected = hexToBytes(v.expectedOut);
    unique.add(String(v.input).toLowerCase());
    expectedOuts.add(String(v.expectedOut).toLowerCase());
    let state = new Array(circuit.nState).fill(0);
    let ok = true;
    for (let k = 0; k < cycles; k++) {
      const frame = unpack(input.slice(k * inFrame, (k + 1) * inFrame), nIn);
      const [next, out] = beat(circuit, state, frame);
      state = next;
      const exp = unpack(expected.slice(k * outFrame, (k + 1) * outFrame), nOut);
      if (exp.length !== out.length || exp.some((x, j) => x !== out[j])) {
        ok = false;
        if (!firstFailure) {
          firstFailure = {
            index: v.index ?? i,
            cycle: k,
            input: String(v.input),
            expected: String(v.expectedOut),
            got: out.join(''),
          };
        }
        break;
      }
    }
    if (ok) passed++;
  }

  const zeroOnly = expectedOuts.size === 1 && /^0x0*$/.test([...expectedOuts][0]);
  const exhaustive = Number(task.kind) === 0 && cycles === 1 && unique.size >= 2 ** nIn;
  return {
    passed,
    failed: vectors.length - passed,
    total: vectors.length,
    firstFailure,
    uniqueInputs: unique.size,
    exhaustive,
    degenerate: zeroOnly,
    cycles,
  };
}

export function certificateSource(check, task) {
  if (check.degenerate) return 'degenerate';
  if (check.exhaustive) return 'exhaustive-vectors';
  return 'reference-equivalence';
}

// --------------------------------------------------------------------- fixed-frame bench

// A bench for one fixed sequence of input frames. src/bench.js drives a counter or LFSR; the
// official sequential vectors are specific frame sequences from reset, so this variant drives
// frames[k] on beat k with a small ROM built from the bench counter.
//
// Outputs: [mismatch, firstBeat[0..m-1], done]. State: counter[m], mismatch, firstBeat[m],
// design state, reference state. m = ceil(log2(frames.length)).
export function sequenceBenchCircuit(design, reference, frames) {
  const n = design.nIn;
  const k = frames.length;
  if (!(k >= 1)) throw new Error('fixed-frame bench needs at least one frame');
  if (reference.nIn !== n || reference.nOut !== design.nOut) throw new Error('design and reference must have the same inputs and outputs');
  if (k > 2 ** 16) throw new Error('fixed-frame bench needs a short frame sequence');
  const m = Math.max(1, Math.ceil(Math.log2(k)));

  const b = new Builder(0);
  const cnt = Array.from({ length: m }, () => b.latch());
  let carry = b.one;
  cnt.forEach((q, i) => { const [s, c] = b.halfAdd(q, carry); b.setLatch(q, s); carry = c; });
  const eq = (value) => {
    const bits = inputBits(value, m);
    return bits.map((x, i) => (x ? cnt[i] : b.not(cnt[i]))).reduce((x, y) => b.and(x, y));
  };

  const ins = Array.from({ length: n }, (_, i) => {
    const terms = frames.map((frame, beat) => (frame[i] ? eq(beat) : null)).filter((x) => x !== null);
    if (!terms.length) return b.zero;
    return terms.reduce((x, y) => b.or(x, y));
  });

  const dOut = b.ref(design.cpu, design.id, design.nOut, ins);
  const rOut = b.ref(reference.cpu, reference.id, reference.nOut, ins);
  const diff = dOut.map((x, i) => b.xor(x, rOut[i])).reduce((x, y) => b.or(x, y));
  const mm = b.latch();
  const mmNext = b.or(mm, diff);
  b.setLatch(mm, mmNext);
  const capture = b.and(diff, b.not(mm));
  const first = Array.from({ length: m }, () => b.latch());
  const firstNext = first.map((q, i) => {
    const nx = b.nand(b.nand(q, b.not(capture)), b.nand(cnt[i], capture));
    b.setLatch(q, nx);
    return nx;
  });
  const done = eq(k - 1);
  const built = b.build([mmNext, ...firstNext, done]);

  const dState = design.nState ?? 0, rState = reference.nState ?? 0;
  return {
    ...built,
    beats: k,
    mode: 'frames',
    n: m,
    inputBits: n,
    counterBits: m,
    frames,
    design,
    reference,
    layout: { count: 0, mm: m, first: m + 1, design: 2 * m + 1, reference: 2 * m + 1 + dState },
  };
}

export function sequenceVerdict(outputs, counterBits) {
  return {
    mismatch: outputs[0] === 1,
    firstBeat: outputs[0] ? bitsValue(outputs.slice(1, 1 + counterBits)) : null,
    done: outputs[counterBits + 1] === 1,
  };
}

// Off-chain expected result of a fixed-frame bench, computed with src/tap02.js directly.
export function expectedSequenceVerdict(bench, resolve) {
  const { frames, design, reference } = bench;
  const d = resolve(design.cpu, BigInt(design.id));
  const r = resolve(reference.cpu, BigInt(reference.id));
  const state = benchState(bench);
  let ds = state.slice(bench.layout.design, bench.layout.reference);
  let rs = state.slice(bench.layout.reference);
  let mismatches = 0, firstBeat = null;
  for (let k = 0; k < frames.length; k++) {
    const [dn, dOut] = beat(d, ds, frames[k]);
    const [rn, rOut] = beat(r, rs, frames[k]);
    ds = dn; rs = rn;
    if (dOut.some((v, i) => v !== rOut[i])) {
      if (!mismatches) firstBeat = k;
      mismatches++;
    }
  }
  return {
    mismatch: mismatches > 0,
    firstInput: firstBeat,
    firstBeat,
    mismatches,
    beats: frames.length,
    outputs: [mismatches ? 1 : 0, ...inputBits(firstBeat ?? 0, bench.counterBits), 1],
  };
}

// The input frames of one official vector, split the way TAP-02 packs them.
export function vectorFrames(input, task, nIn) {
  const cycles = Math.max(1, Number(task.cycles ?? 1));
  const inFrame = Math.ceil(nIn / 8);
  const bytes = hexToBytes(input);
  return Array.from({ length: cycles }, (_, k) => unpack(bytes.slice(k * inFrame, (k + 1) * inFrame), nIn));
}

// --------------------------------------------------------------------- source readers

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const RETRYABLE = /missing response|timeout|fetch failed|bad response|network error|ECONNRESET|ETIMEDOUT|rate limit|429|502|503|504|SERVER_ERROR/i;

async function retry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i + 1 >= tries || !RETRYABLE.test(`${e?.code} ${e?.message}`)) throw e;
      await sleep(400 * 2 ** i);
    }
  }
}

const chunks = (arr, n) => {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
};

async function multicall(mc, calls) {
  const out = [];
  for (const ch of chunks(calls, 400)) out.push(...(await retry(() => mc.aggregate3.staticCall(ch))));
  return out;
}

// Default mainnet reader: free view calls plus FabX's public vector API. No keys, no writes.
export function mainnetSource({ provider = new JsonRpcProvider(MAINNET_RPC, undefined, { cacheTimeout: -1 }), quiet = false } = {}) {
  const mining = new Contract(POD_MINING, MINING_ABI, provider);
  const taskCache = new Map(), minerCache = new Map(), vectorCache = new Map(), circuitCache = new Map();
  const source = {
    provider,
    chainId: MAINNET_CHAIN_ID,
    circuit: async (cpu, id) => {
      const key = refKey(cpu, id);
      if (!circuitCache.has(key)) circuitCache.set(key, await fetchCircuit(provider, cpu, id));
      return circuitCache.get(key);
    },
    miner: async (cpu, id) => {
      const key = refKey(cpu, id);
      if (!minerCache.has(key)) {
        const mk = await retry(() => mining.minerKey(cpu, id));
        const m = await retry(() => mining.getMiner(mk));
        minerCache.set(key, m.circuits === ZERO ? null : {
          taskId: Number(m.taskId),
          status: Number(m.status),
          registrant: m.registrant,
          gateCount: Number(m.gateCount),
          stateCount: Number(m.stateCount),
          verifWeight: String(m.verifWeight),
        });
      }
      return minerCache.get(key);
    },
    task: async (taskId) => {
      if (!taskCache.has(taskId)) {
        const t = await retry(() => mining.getTask(taskId));
        taskCache.set(taskId, {
          taskId: Number(taskId),
          kind: Number(t.kind),
          cycles: Number(t.cycles),
          nIn: Number(t.nIn),
          nOut: Number(t.nOut),
          vectorCount: Number(t.vectorCount),
          active: t.active,
          vectorsRoot: t.vectorsRoot,
          name: t.name,
          refArea: Number(t.refArea),
          refCost: String(t.refCost),
          refCircuits: t.refCircuits,
          refCircuitId: BigInt(t.refCircuitId),
        });
      }
      return taskCache.get(taskId);
    },
    vectors: async (taskId) => {
      if (!vectorCache.has(taskId)) {
        const body = await retry(async () => {
          const r = await fetch(`${TASKS_API}/${taskId}/vectors?chainId=${MAINNET_CHAIN_ID}`);
          if (!r.ok) throw new Error(`FabX vectors GC-${String(taskId).padStart(3, '0')}: HTTP ${r.status}`);
          return r.json();
        });
        vectorCache.set(taskId, body.vectors);
      }
      return vectorCache.get(taskId);
    },
    tasks: async () => {
      const count = Number(await retry(() => mining.taskCount()));
      const calls = Array.from({ length: count }, (_, i) => ({ target: POD_MINING, allowFailure: true, callData: MINING_ABI.getFunction('getTask').selector + (i + 1).toString(16).padStart(64, '0') }));
      const mc = new Contract(MULTICALL3, AGGREGATE3_ABI, provider);
      const res = await multicall(mc, calls);
      const out = new Map();
      for (let i = 0; i < count; i++) {
        if (!res[i]?.[0]) continue;
        const t = MINING_ABI.decodeFunctionResult('getTask', res[i][1])[0];
        out.set(i + 1, {
          taskId: i + 1, kind: Number(t.kind), cycles: Number(t.cycles), nIn: Number(t.nIn), nOut: Number(t.nOut),
          vectorCount: Number(t.vectorCount), active: t.active, vectorsRoot: t.vectorsRoot, name: t.name,
          refArea: Number(t.refArea), refCost: String(t.refCost), refCircuits: t.refCircuits, refCircuitId: BigInt(t.refCircuitId),
        });
      }
      return out;
    },
    log: quiet ? () => {} : (m) => console.error(m),
  };
  return source;
}

// Read every claimed miner on a processor and group it by (challenge, netlist, dimensions).
// Chain reads only; Multicall3 batches keep a full 7,000-circuit scan to a few dozen calls.
export async function scanProcessor({ provider, processor, mc = null, log = () => {} }) {
  const multicall3 = mc ?? new Contract(MULTICALL3, AGGREGATE3_ABI, provider);
  const circuits = new Contract(processor, CIRCUIT_INFO_ABI, provider);
  const mining = new Contract(POD_MINING, MINING_ABI, provider);
  const chain = await retry(() => provider.getNetwork());
  const block = await retry(() => provider.getBlockNumber());
  const nextId = Number(await retry(() => circuits.nextId()));
  const ids = Array.from({ length: Math.max(0, nextId - 1) }, (_, i) => i + 1);
  log(`scanning ${processor}: ${ids.length} circuits at block ${block}`);

  const infoCalls = ids.map((id) => ({ target: processor, allowFailure: true, callData: CIRCUIT_INFO_ABI.getFunction('circuitInfo').selector + id.toString(16).padStart(64, '0') }));
  const infoRes = await multicall(multicall3, infoCalls);
  const info = new Map();
  for (let i = 0; i < ids.length; i++) {
    if (!infoRes[i]?.[0]) continue;
    const [nIn, nOut, nState, gates] = CIRCUIT_INFO_ABI.decodeFunctionResult('circuitInfo', infoRes[i][1]);
    info.set(ids[i], { nIn: Number(nIn), nOut: Number(nOut), nState: Number(nState), gates: Number(gates) });
  }

  const keyCalls = ids.map((id) => ({ target: POD_MINING, allowFailure: true, callData: MINING_ABI.getFunction('minerKey').selector + processor.slice(2).padStart(64, '0') + id.toString(16).padStart(64, '0') }));
  const keyRes = await multicall(multicall3, keyCalls);
  const keys = keyRes.map((r) => (r?.[0] ? MINING_ABI.decodeFunctionResult('minerKey', r[1])[0] : null));
  const minerCalls = keys.map((k) => k && ({ target: POD_MINING, allowFailure: true, callData: MINING_ABI.getFunction('getMiner').selector + k.slice(2) }));
  const minerRes = await multicall(multicall3, minerCalls);
  const claims = new Map();
  for (let i = 0; i < ids.length; i++) {
    if (!keys[i] || !minerRes[i]?.[0]) continue;
    const m = MINING_ABI.decodeFunctionResult('getMiner', minerRes[i][1])[0];
    if (m.circuits === ZERO || Number(m.taskId) === 0) continue;
    claims.set(ids[i], { taskId: Number(m.taskId), status: Number(m.status), registrant: m.registrant });
  }

  const claimedIds = ids.filter((id) => claims.has(id) && info.has(id));
  const netlistCalls = claimedIds.map((id) => ({ target: processor, allowFailure: true, callData: CIRCUIT_INFO_ABI.getFunction('netlist').selector + id.toString(16).padStart(64, '0') }));
  const netlistRes = await multicall(multicall3, netlistCalls);
  const records = [];
  for (let i = 0; i < claimedIds.length; i++) {
    if (!netlistRes[i]?.[0]) continue;
    const id = claimedIds[i];
    const { nIn, nOut, gates, nState } = info.get(id);
    const netlist = CIRCUIT_INFO_ABI.decodeFunctionResult('netlist', netlistRes[i][1])[0];
    const d = describeNetlist(netlist, nIn);
    if (d.elements !== gates) throw new Error(`${processor}#${id}: decoded ${d.elements} elements, circuitInfo says ${gates}`);
    records.push({
      processor: processor.toLowerCase(), id, taskId: claims.get(id).taskId, status: claims.get(id).status,
      nIn, nOut, nState, gates, netlist: asBytes(netlist), ...d,
    });
  }
  const groups = groupMinerShapes(records);
  log(`claimed miners: ${records.length}; shapes: ${groups.length}`);
  return {
    chainId: Number(chain.chainId),
    block,
    processor: processor.toLowerCase(),
    nextId,
    circuits: ids.length,
    miners: records.length,
    groups,
    records,
  };
}

// --------------------------------------------------------------------- web/runs.json

export function certificateFilename(processor, id) {
  return `${String(processor).toLowerCase()}-${Number(id)}.json`;
}

export function certificateDocumentPath(processor, id, dir = 'docs/certificates') {
  return `${dir.replace(/\/$/, '')}/${certificateFilename(processor, id)}`;
}

export function writeCertificate(cert, dir = 'docs/certificates') {
  const file = certificateDocumentPath(cert.design.processor, cert.design.id, dir);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cert, null, 1) + '\n');
  return file;
}

// The Floor classifies a circuit as a FabX miner by this processor name, so entries for the miner
// processor use it too; the challenge stays visible in the certificate's reference and in `what`.
function webCircuitName(cert) {
  return cert.design.processor === MINER_PROCESSOR.toLowerCase() ? 'FAB-Genisis' : cert.challenge.name;
}

// The site's Certificate record (docs/runs-schema.md). Unknown fields are ignored by the web JS.
export function certificateEntry(cert) {
  return {
    id: cert.id,
    circuit: {
      processor: cert.design.processor,
      id: cert.design.id,
      name: webCircuitName(cert),
      gates: cert.design.gates,
      nIn: cert.design.nIn,
      nOut: cert.design.nOut,
      nState: cert.design.nState,
    },
    reference: {
      processor: cert.reference.processor,
      id: cert.reference.id,
      name: cert.challenge.label,
    },
    runId: cert.job.runId,
    chainId: cert.job.chainId,
    inputs: cert.inputs,
    mismatches: cert.mismatches,
    ...(cert.firstFailingInput ? { firstFailingInput: cert.firstFailingInput } : {}),
    status: cert.verdict,
    issuedAt: cert.issuedAt,
    txs: cert.job.txs,
    ...(cert.caveat ? { caveat: cert.caveat } : {}),
    ...(cert.coverage ? { coverage: cert.coverage } : {}),
    ...(cert.shape?.covers?.length ? { covers: cert.shape.covers } : {}),
    certificate: certificateFilename(cert.design.processor, cert.design.id),
  };
}

export function runEntry(cert) {
  const job = cert.job;
  return {
    id: job.runId,
    chainId: job.chainId,
    overclock: job.overclock,
    jobId: job.jobId,
    circuit: {
      processor: cert.design.processor,
      id: cert.design.id,
      name: webCircuitName(cert),
      gates: cert.design.gates,
      nIn: cert.design.nIn,
      nOut: cert.design.nOut,
      nState: cert.design.nState,
    },
    what: `Certificate bench for ${cert.challenge.label} (${cert.coverage})`,
    beats: job.beats,
    steps: job.traceLeaves,
    status: 'final',
    fee: job.fee,
    bond: job.bond,
    directGas: cert.bench.gatesPerBeat * job.beats * 2400,
    gas: job.gas,
    outcome: job.outcome,
    txs: job.txs,
    postedAt: job.postedAt,
    finalizedAt: job.finalizedAt,
    source: 'scripts/certify.js',
  };
}

// Upsert the Run and Certificate entries. Re-running a certificate replaces its old records
// instead of appending duplicates.
export function applyCertificate(runsDoc, cert) {
  const doc = {
    schema: 1,
    ...runsDoc,
    runs: Array.isArray(runsDoc.runs) ? [...runsDoc.runs] : [],
    certificates: Array.isArray(runsDoc.certificates) ? [...runsDoc.certificates] : [],
  };
  const run = runEntry(cert);
  const ci = doc.runs.findIndex((r) => r.id === run.id);
  if (ci >= 0) doc.runs[ci] = run;
  else doc.runs.push(run);
  const ce = certificateEntry(cert);
  const xi = doc.certificates.findIndex((c) => c.id === ce.id);
  if (xi >= 0) doc.certificates[xi] = ce;
  else doc.certificates.push(ce);
  doc.updatedAt = new Date().toISOString().slice(0, 10);
  return doc;
}

// --------------------------------------------------------------------- the job

const zeroAddress = (a) => !a || String(a).toLowerCase() === ZERO;

async function ensureTransistors(dest, signer, netlist) {
  const need = burnCost(netlist, 0);
  const address = await signer.getAddress();
  for (const [token, kind] of [[0, 'nand'], [1, 'latch']]) {
    if (!need[kind]) continue;
    const have = Number(await dest.transistors.balanceOf(address, token));
    if (need[kind] > have) await mintTransistors(dest.transistors, token, need[kind] - have);
  }
}

async function defaultAdvance(dest) {
  if (dest.advance) return dest.advance();
  try {
    await dest.provider.send('evm_increaseTime', [dest.window + 1]);
    await dest.provider.send('evm_mine', []);
  } catch (e) {
    throw new Error(`cannot advance the claim window on chain ${dest.chainId}: ${e.message}`);
  }
}

async function sendTx(what, txPromise, contract, txs) {
  const rc = await (await txPromise).wait();
  const gas = Number(rc.gasUsed);
  txs.push({ what, tx: rc.hash, gas });
  const event = (name) => rc.logs.map((l) => { try { return contract.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === name)?.args;
  return { rc, gas, event };
}

// Run one bench as an Overclock job. The bench is taped out on the destination processor, so the
// job's circuit is a local mirror; the certificate records both the source and the mirror ids.
async function runBenchJob({ dest, bench, state, log = () => {} }) {
  if (dest.chainId === MAINNET_CHAIN_ID || dest.chainId === 1952) {
    throw new Error(`refusing to certify on chain ${dest.chainId}: certificates run on a local or testnet TapeOutLocal`);
  }
  const signer = dest.circuits.runner;
  if (!signer) throw new Error('destination circuits are not connected to a signer');

  await ensureTransistors(dest, signer, bench.netlist);
  const minted = await tapeout(dest.circuits, { netlist: bench.netlist, nIn: 0, nOut: bench.nOut });
  const benchId = Number(minted.id);
  log(`taped out bench #${benchId}: ${bench.nOut} outputs, ${bench.beats} beats`);

  const circuit = await loadCircuit(dest.provider, dest.processor, benchId);
  const t0 = Date.now();
  const trace = traceJob(circuit, { state, beats: bench.beats });
  const tree = new Tree(trace.leaves);
  log(`trace ${trace.n} leaves, root ${tree.root.slice(0, 10)}… in ${Date.now() - t0} ms`);

  const txs = [];
  const post = await sendTx('post job', dest.overclock.postJob(
    dest.processor, benchId, '0x', bytesToHex(pack(state)), bench.beats, false, { value: dest.fee ?? 0n },
  ), dest.overclock, txs);
  const jobId = Number(post.event('JobPosted').jobId);
  const postedAt = new Date().toISOString();

  await sendTx('claim', dest.overclock.claim(
    jobId, tree.root, bytesToHex(pack(trace.outputs)), bytesToHex(pack(trace.newState)), { value: dest.bond },
  ), dest.overclock, txs);

  await defaultAdvance(dest);
  await sendTx('finalize', dest.overclock.finalize(jobId), dest.overclock, txs);
  const finalizedAt = new Date().toISOString();

  const [outputsHex, newStateHex] = await dest.overclock.result(jobId);
  const gas = {
    post: txs[0].gas,
    claim: txs[1].gas,
    finalize: txs[2].gas,
  };
  gas.honestPath = gas.post + gas.claim + gas.finalize;
  return {
    chainId: dest.chainId,
    processor: dest.processor,
    benchId,
    jobId,
    runId: `${dest.chainId}:${jobId}`,
    overclock: String(dest.overclock.target).toLowerCase(),
    txs,
    gas,
    outputs: String(outputsHex).toLowerCase(),
    newState: String(newStateHex).toLowerCase(),
    traceLeaves: trace.n,
    traceRoot: tree.root,
    beats: bench.beats,
    postedAt,
    finalizedAt,
  };
}

// --------------------------------------------------------------------- the certificate

// certifyMiner({ processor, id, source, dest, shape, covers, now, log })
//
// source: { provider, chainId, circuit, miner, task, vectors } (mainnetSource() by default)
// dest:   { provider, chainId, processor, circuits, transistors, overclock, window, bond, fee,
//           advance? }
//
// Returns the certificate object; it does not write files. Use writeCertificate() and
// applyCertificate() for that.
export async function certifyMiner({
  processor,
  id,
  source,
  dest,
  shape = null,
  covers = null,
  now = () => new Date().toISOString(),
  log = () => {},
}) {
  if (!source) source = mainnetSource();
  if (dest.chainId === MAINNET_CHAIN_ID || dest.chainId === 1952) {
    throw new Error(`refusing to certify on chain ${dest.chainId}: certificates run on a local or testnet TapeOutLocal`);
  }
  const sourceChainId = Number(source.chainId ?? (await source.provider.getNetwork()).chainId);
  const miner = await source.miner(processor, id);
  if (!miner || !miner.taskId) throw new Error(`${processor}#${id} is not a claimed FabX miner`);
  const task = await source.task(miner.taskId);
  if (zeroAddress(task.refCircuits) || Number(task.refCircuitId) === 0) throw new Error(`${challengeName(task.taskId)} has no on-chain reference`);

  const refId = Number(task.refCircuitId);
  const readCircuit = source.circuit ?? ((cpu, cid) => fetchCircuit(source.provider, cpu, cid));
  const design = await readCircuit(processor, id);
  const reference = await readCircuit(task.refCircuits, refId);
  if (design.nIn !== reference.nIn || design.nOut !== reference.nOut) {
    throw new Error(`${challengeName(task.taskId)}: design ${design.nIn}/${design.nOut} and reference ${reference.nIn}/${reference.nOut} disagree`);
  }

  const vectors = await source.vectors(task.taskId);
  const official = officialCheck(design, task, vectors);
  const designFp = fingerprint(design);
  const refFp = fingerprint(reference);
  log(`${challengeName(task.taskId)} ${task.name}: ${official.passed}/${official.total} official vectors; ${designFp.gates} gates vs reference ${refFp.gates}`);

  // ---- mirror the design and the official reference into the destination processor
  const designMirror = await mirrorCircuit({
    provider: source.provider, processor, id,
    circuits: dest.circuits, transistors: dest.transistors,
    log: (line) => log(`  ${line}`),
  });
  const refMirror = await mirrorCircuit({
    provider: source.provider, processor: task.refCircuits, id: refId,
    circuits: dest.circuits, transistors: dest.transistors,
    log: (line) => log(`  ${line}`),
  });
  const localOf = (mirror, wantedProcessor, wantedId) => {
    const hit = mirror.mapping.find((e) => String(e.from.processor).toLowerCase() === String(wantedProcessor).toLowerCase() && BigInt(e.from.id) === BigInt(wantedId));
    if (!hit) throw new Error(`mirror did not report ${wantedProcessor}#${wantedId}`);
    return hit.to;
  };
  const designLocal = localOf(designMirror, processor, id);
  const refLocal = localOf(refMirror, task.refCircuits, refId);
  const dDesc = { cpu: dest.processor, id: designLocal.id, nIn: design.nIn, nOut: design.nOut, nState: design.nState };
  const rDesc = { cpu: dest.processor, id: refLocal.id, nIn: reference.nIn, nOut: reference.nOut, nState: reference.nState };

  // ---- choose what the job settles
  let bench, expected, benchKind, coverage, state;
  if (official.failed > 0) {
    const first = official.firstFailure;
    let candidate = null;
    if (Number(task.kind) === 0 && Math.max(1, Number(task.cycles)) === 1) {
      // A stateless combinational failure can be settled over the whole truth table, which is
      // stronger than replaying one vector. The first-input check below falls back to the vector
      // replay if the truth-table bench fails somewhere else first.
      candidate = benchCircuit(dDesc, rDesc);
    }
    bench = candidate ?? sequenceBenchCircuit(dDesc, rDesc, vectorFrames(first.input, task, design.nIn));
    benchKind = candidate ? (bench.mode === 'count' ? 'truth-table' : 'lfsr') : 'official-vector';
    coverage = candidate
      ? `${bench.beats} ${bench.mode === 'count' ? 'inputs (all 2^' + design.nIn + ')' : 'LFSR inputs from reset'}`
      : `1 official vector (${vectorFrames(first.input, task, design.nIn).length} frame${vectorFrames(first.input, task, design.nIn).length === 1 ? '' : 's'} from reset)`;
  } else {
    bench = benchCircuit(dDesc, rDesc);
    benchKind = bench.mode === 'count' ? 'truth-table' : 'lfsr';
    coverage = bench.mode === 'count'
      ? `all ${bench.beats} inputs (0..${bench.beats - 1})`
      : `${bench.beats} LFSR inputs from reset (every non-zero ${design.nIn}-bit input once)`;
  }
  state = benchState(bench);

  // ---- load the mirrored design and reference for the off-chain expectation
  const designLoaded = await loadCircuit(dest.provider, dest.processor, Number(designLocal.id));
  const refLoaded = await loadCircuit(dest.provider, dest.processor, Number(refLocal.id));
  const resolveLocal = (cpu, cid) => {
    if (String(cpu).toLowerCase() !== dest.processor.toLowerCase()) return null;
    const n = Number(cid);
    if (n === Number(designLocal.id)) return designLoaded;
    if (n === Number(refLocal.id)) return refLoaded;
    return null;
  };
  expected = bench.mode === 'frames' ? expectedSequenceVerdict(bench, resolveLocal) : expectedVerdict(bench, resolveLocal);
  if (official.failed > 0 && !expected.mismatch) {
    throw new Error(`${challengeName(task.taskId)} #${id}: the official vector failure at ${official.firstFailure.input} did not reproduce in a bench`);
  }

  // A combinational candidate is only better than the exact vector replay if it fails on the same
  // first input; otherwise replay the official vector itself.
  if (official.failed > 0 && bench.mode !== 'frames') {
    const officialInput = String(official.firstFailure.input).toLowerCase();
    const benchInput = inputHex(expected.firstInput, design.nIn);
    if (officialInput !== benchInput) {
      bench = sequenceBenchCircuit(dDesc, rDesc, vectorFrames(official.firstFailure.input, task, design.nIn));
      state = benchState(bench);
      benchKind = 'official-vector';
      coverage = `1 official vector (${bench.beats} frame${bench.beats === 1 ? '' : 's'} from reset)`;
      expected = expectedSequenceVerdict(bench, resolveLocal);
      if (!expected.mismatch) {
        throw new Error(`${challengeName(task.taskId)} #${id}: the official vector failure at ${official.firstFailure.input} did not reproduce in a fixed-frame bench`);
      }
    }
  }

  // ---- settle the job
  const job = await runBenchJob({ dest, bench, state, log });
  const counterBits = bench.mode === 'frames' ? bench.counterBits : bench.n;
  const outs = unpack(hexToBytes(job.outputs), bench.nOut);
  const got = bench.mode === 'frames' ? sequenceVerdict(outs, counterBits) : verdict(outs, bench.n);
  if (got.mismatch !== expected.mismatch) {
    throw new Error(`bench verdict disagrees with the off-chain run: job ${JSON.stringify(got)} vs expected ${JSON.stringify(expected)}`);
  }
  if (!got.done) throw new Error('bench did not signal done on the last beat');
  if (expected.mismatch) {
    const same = bench.mode === 'frames' ? got.firstBeat === expected.firstBeat : got.firstInput === expected.firstInput;
    if (!same) throw new Error(`bench first failure disagrees: job ${JSON.stringify(got)} vs expected ${JSON.stringify(expected)}`);
  }

  const certified = !expected.mismatch;
  const firstFailingInput = official.failed > 0
    ? String(official.firstFailure.input).toLowerCase()
    : expected.mismatch
      ? inputHex(expected.firstInput, design.nIn)
      : null;
  const mismatches = official.failed > 0 ? official.failed : expected.mismatches;
  const inputs = official.failed > 0 ? official.total : bench.beats;
  const caveat = official.degenerate
    ? 'The published vectors for this challenge are all zero and the official reference is constant zero. This certifies equivalence to that reference, not the advertised function.'
    : null;

  const suffix = task.name ? ` ${task.name}` : '';
  const cert = {
    schema: 1,
    id: `cert:${sourceChainId}:${String(processor).toLowerCase()}:${Number(id)}`,
    chain: { source: sourceChainId, settlement: dest.chainId },
    challenge: {
      taskId: Number(task.taskId),
      label: `${challengeName(task.taskId)}${suffix}`,
      name: task.name,
      kind: Number(task.kind),
      cycles: Math.max(1, Number(task.cycles ?? 1)),
      nIn: Number(task.nIn),
      nOut: Number(task.nOut),
      vectorCount: official.total,
      vectorsRoot: task.vectorsRoot,
      certificateSource: certificateSource(official, task),
    },
    design: {
      processor: String(processor).toLowerCase(),
      id: Number(id),
      status: miner.status,
      ...designFp,
    },
    reference: {
      processor: String(task.refCircuits).toLowerCase(),
      id: refId,
      ...refFp,
    },
    mirror: {
      chainId: dest.chainId,
      processor: dest.processor,
      design: { id: Number(designLocal.id) },
      reference: { id: Number(refLocal.id) },
      bench: { id: job.benchId },
    },
    bench: {
      kind: benchKind,
      mode: bench.mode,
      beats: bench.beats,
      gatesPerBeat: benchSize(bench, resolveLocal).gates,
      stateBits: benchState(bench).length,
      netlistHash: keccak256(asBytes(bench.netlist)),
    },
    inputs,
    inputsCovered: coverage,
    coverage,
    mismatches,
    firstFailingInput,
    settled: { inputs: bench.beats, mismatches: expected.mismatches, kind: benchKind },
    officialVectors: {
      passed: official.passed,
      failed: official.failed,
      total: official.total,
      uniqueInputs: official.uniqueInputs,
      exhaustive: official.exhaustive,
      degenerate: official.degenerate,
      firstFailure: official.firstFailure,
    },
    verdict: certified ? 'certified' : 'failed',
    ...(caveat ? { caveat } : {}),
    job: {
      ...job,
      fee: formatEther(dest.fee ?? 0n),
      bond: formatEther(dest.bond),
      outcome: certified
        ? `0 mismatches over ${bench.beats} settled ${bench.mode === 'frames' ? 'beats' : 'inputs'}; ${official.passed}/${official.total} official vectors pass.`
        : `${mismatches} mismatch${mismatches === 1 ? '' : 'es'} in ${inputs} official vectors; first failing input ${firstFailingInput}${official.firstFailure ? ` at cycle ${official.firstFailure.cycle}` : ''}.`,
    },
    shape: shape
      ? {
        key: shape.key,
        taskId: Number(shape.taskId),
        structHash: shape.structHash,
        count: shape.count,
        covers: covers ?? shape.covers,
      }
      : { key: null, taskId: Number(task.taskId), structHash: designFp.structHash, count: 1, covers: covers ?? [{ processor: String(processor).toLowerCase(), id: Number(id) }] },
    issuedAt: now(),
  };
  return cert;
}
