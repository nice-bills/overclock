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
//                     for stateless designs, LFSR from reset for stateful ones). Stateful
//                     challenges additionally settle a frames-mode bench over ALL official vectors:
//                     each vector replays its per-cycle frames from reset and the bench latches the
//                     first failing (vector index, cycle). That is what catches #2346 (GC-094) in
//                     the job itself; its LFSR sweep still passes, which is exactly the gap this
//                     closes. The verdict fails if either bench fails.
//   5. Job.           Tape the bench out, postJob / claim / finalize on Overclock, read result().
//   6. Certificate.   docs/certificates/<processor>-<id>.json (plus an optional runs-index entry). Circuits
//                     with the same challenge and byte-identical netlist share one certificate:
//                     `covers` lists them all. A constant reference or vector set yields
//                     `verdict: "unsound-reference"` and a finding, never `certified` (GC-098).
//
// Every write in this file goes to the destination the caller passes (a local ganache or the
// testnet TapeOutLocal). certifyMiner refuses a mainnet or testnet destination.

import { Contract, Interface, JsonRpcProvider, formatEther, keccak256 } from 'ethers';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  LATCH, NAND, REF, beat, bytesToHex, decode, hexToBytes, load, pack, unpack,
} from './tap02.js';
import {
  benchCircuit, benchSize, benchState, expectedVerdict, framesVerdict, verdict,
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

  const constant = expectedOuts.size === 1 ? [...expectedOuts][0] : null;
  const exhaustive = Number(task.kind) === 0 && cycles === 1 && unique.size >= 2 ** nIn;
  return {
    passed,
    failed: vectors.length - passed,
    total: vectors.length,
    firstFailure,
    uniqueInputs: unique.size,
    exhaustive,
    degenerate: constant !== null,
    constantOutput: constant,
    cycles,
  };
}

// Replay the reference through every official vector and report whether its output is constant.
// A challenge can be degenerate because the published expected outputs are constant or because the
// reference itself only ever emits one value; either way passing it proves nothing (GC-098).
export function constantReference(reference, task, vectors) {
  const nIn = Number(reference.nIn), nOut = Number(reference.nOut);
  const cycles = Math.max(1, Number(task.cycles ?? 1));
  const inFrame = Math.ceil(nIn / 8);
  const circuit = load(asBytes(reference.netlist), nIn, nOut);
  let seen = null;
  for (const v of vectors) {
    const input = hexToBytes(v.input);
    let state = new Array(circuit.nState).fill(0);
    for (let k = 0; k < cycles; k++) {
      const frame = unpack(input.slice(k * inFrame, (k + 1) * inFrame), nIn);
      const [next, out] = beat(circuit, state, frame);
      state = next;
      const value = out.join('');
      if (seen === null) seen = value;
      else if (seen !== value) return { constant: false, output: null };
    }
  }
  return { constant: seen !== null, output: seen };
}

export function certificateSource(check, task) {
  if (check.degenerate) return 'degenerate';
  if (check.exhaustive) return 'exhaustive-vectors';
  return 'reference-equivalence';
}

// --------------------------------------------------------------------- official frames

// Every official vector as a frames-mode bench vector: its `cycles` input frames from reset.
// The bench compares the design with the official reference every cycle and latches the first
// failing (vector index, cycle), so the job settles exactly what the published vectors say.
export function officialFrames(vectors, task, nIn) {
  return vectors.map((v, i) => ({ index: v.index ?? i, frames: vectorFrames(String(v.input), task, nIn) }));
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

// A source from a JSON file instead of FabX's contracts and API, for offline checks and tests:
//   { miners: { "<processor>#<id>": <taskId> }, tasks: { "<taskId>": <task> }, vectors: { "<taskId>": [{ index, input, expectedOut }] } }
// Circuits (the design and the reference) are read from `provider`.
export function fixtureSource({ provider, fixture, chainId = 31337 }) {
  const key = (cpu, id) => `${String(cpu).toLowerCase()}#${Number(id)}`;
  const miners = new Map(Object.entries(fixture.miners ?? {}).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    provider,
    chainId,
    circuit: (cpu, id) => fetchCircuit(provider, cpu, id),
    miner: async (cpu, id) => (miners.has(key(cpu, id)) ? { taskId: Number(miners.get(key(cpu, id))), status: 1 } : null),
    task: async (taskId) => {
      const t = fixture.tasks?.[taskId];
      if (!t) throw new Error(`fixture has no task ${taskId}`);
      return { taskId: Number(taskId), ...t, refCircuitId: BigInt(t.refCircuitId ?? 0) };
    },
    vectors: async (taskId) => {
      const v = fixture.vectors?.[taskId];
      if (!v) throw new Error(`fixture has no vectors for task ${taskId}`);
      return v;
    },
    log: () => {},
  };
}

// The quick answer to "is this FabX miner correct?": replay every official vector against the miner
// and say whether the challenge's reference is even meaningful. Read-only. The verdict uses the same
// words and the same precedence as certifyMiner (a constant reference outranks a failure), but it is
// the vector replay alone: the saved certificate (docs/certificates) also runs the LFSR equivalence
// sweep, so `certified` is only ever claimed by a certificate.
export async function verifyMiner(source, processor, id) {
  const miner = await source.miner(processor, id);
  if (!miner?.taskId) return { status: 'not-a-fabx-miner', message: `${processor}#${id} is not a claimed FabX miner.` };
  const task = await source.task(miner.taskId);
  if (zeroAddress(task.refCircuits) || Number(task.refCircuitId) === 0) {
    return { status: 'no-reference', challenge: challengeName(miner.taskId), taskId: miner.taskId, message: `${challengeName(miner.taskId)} has no on-chain reference to check against.` };
  }
  const [design, reference, vectors] = await Promise.all([source.circuit(processor, id), source.circuit(task.refCircuits, task.refCircuitId), source.vectors(miner.taskId)]);
  const checked = officialCheck(design, task, vectors);
  const ref = constantReference(reference, task, vectors);
  const unsound = checked.degenerate || ref.constant;
  const status = unsound ? 'unsound-reference' : checked.failed ? 'fail' : 'pass';
  return {
    status, challenge: challengeName(miner.taskId), name: task.name, taskId: miner.taskId,
    passed: checked.passed, failed: checked.failed, total: checked.total, cycles: checked.cycles,
    ...(checked.firstFailure ? { firstFailure: checked.firstFailure } : {}),
    ...(unsound ? { finding: 'The official reference (or its published vectors) produces a constant output, so passing it proves nothing about the advertised function.' } : {}),
  };
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
    ...(cert.findings?.length ? { findings: cert.findings } : {}),
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
  // ---- load the mirrored design and reference for off-chain expectations
  const designLoaded = await loadCircuit(dest.provider, dest.processor, Number(designLocal.id));
  const refLoaded = await loadCircuit(dest.provider, dest.processor, Number(refLocal.id));
  const resolveLocal = (cpu, cid) => {
    if (String(cpu).toLowerCase() !== dest.processor.toLowerCase()) return null;
    const n = Number(cid);
    if (n === Number(designLocal.id)) return designLoaded;
    if (n === Number(refLocal.id)) return refLoaded;
    return null;
  };
  // Frames mode inlines these circuits so it can reset their state at every vector boundary.
  const dDesc = { cpu: dest.processor, id: designLocal.id, nIn: design.nIn, nOut: design.nOut, nState: design.nState, circuit: designLoaded, reset: [] };
  const rDesc = { cpu: dest.processor, id: refLocal.id, nIn: reference.nIn, nOut: reference.nOut, nState: reference.nState, circuit: refLoaded, reset: [] };

  // ---- choose what the job(s) settle
  // Stateful challenges need both schedules: all official per-cycle vectors (frames, the exact
  // published behaviour) and the LFSR sweep (broader equivalence against the reference). The
  // verdict fails if either bench fails. Stateless designs keep the stronger truth table when the
  // vectors are exhaustive, and replay the published failure otherwise.
  const stateful = (design.nState ?? 0) > 0 || (reference.nState ?? 0) > 0;
  const plans = [];
  if (stateful) {
    plans.push({
      kind: 'official-vectors',
      bench: benchCircuit(dDesc, rDesc, { mode: 'frames', vectors: officialFrames(vectors, task, design.nIn) }),
    });
    plans.push({ kind: 'lfsr', bench: benchCircuit(dDesc, rDesc, { mode: 'lfsr' }) });
  } else {
    const complete = Number(task.kind) === 0 && Math.max(1, Number(task.cycles)) === 1;
    const base = benchCircuit(dDesc, rDesc);
    plans.push({ kind: base.mode === 'count' ? 'truth-table' : 'lfsr', bench: base });
    if (official.failed > 0) {
      const exp = expectedVerdict(base, resolveLocal);
      const sameFirst = complete && exp.mismatch && inputHex(exp.firstInput, design.nIn) === String(official.firstFailure.input).toLowerCase();
      if (!sameFirst) {
        const replay = benchCircuit(dDesc, rDesc, {
          mode: 'frames',
          vectors: [{ index: official.firstFailure.index, input: String(official.firstFailure.input).toLowerCase(), frames: vectorFrames(official.firstFailure.input, task, design.nIn) }],
        });
        const rexp = expectedVerdict(replay, resolveLocal);
        if (!rexp.mismatch) {
          throw new Error(`${challengeName(task.taskId)} #${id}: the official vector failure at ${official.firstFailure.input} did not reproduce in a frames bench`);
        }
        plans[0] = { kind: 'official-vector', bench: replay };
      }
    }
  }
  const coverageOf = (plan) => {
    const b = plan.bench;
    if (b.mode === 'frames') {
      return plan.kind === 'official-vector'
        ? `1 official vector (${b.beats} frame${b.beats === 1 ? '' : 's'} from reset)`
        : `${b.vectors.length} official vectors (${b.beats} frames from reset)`;
    }
    if (b.mode === 'count') return `all ${b.beats} inputs (0..${b.beats - 1})`;
    return `${b.beats} LFSR inputs from reset (every non-zero ${design.nIn}-bit input once)`;
  };
  const coverage = plans.map(coverageOf).join(' + ');

  // ---- settle every bench as an Overclock job
  const settledRuns = [];
  for (const plan of plans) {
    const bench = plan.bench;
    const expected = expectedVerdict(bench, resolveLocal);
    const job = await runBenchJob({ dest, bench, state: benchState(bench), log });
    const outs = unpack(hexToBytes(job.outputs), bench.nOut);
    const got = bench.mode === 'frames' ? framesVerdict(outs, bench) : verdict(outs, bench.n);
    if (got.mismatch !== expected.mismatch) {
      throw new Error(`bench verdict disagrees with the off-chain run: job ${JSON.stringify(got)} vs expected ${JSON.stringify(expected)}`);
    }
    if (!got.done) throw new Error('bench did not signal done on the last beat');
    if (expected.mismatch) {
      const same = bench.mode === 'frames'
        ? got.firstVector === expected.firstVector && got.firstCycle === expected.firstCycle
        : got.firstInput === expected.firstInput;
      if (!same) throw new Error(`bench first failure disagrees: job ${JSON.stringify(got)} vs expected ${JSON.stringify(expected)}`);
    }
    settledRuns.push({ plan, expected, got, job, size: benchSize(bench, resolveLocal) });
  }
  const primary = settledRuns[0];
  const primaryBench = primary.plan.bench;
  const primaryExpected = primary.expected;

  // The frames bench settles the same failure the official vectors report, not merely "an input".
  if (stateful && official.failed > 0) {
    if (!primaryExpected.mismatch) {
      throw new Error(`${challengeName(task.taskId)} #${id}: the official vector failure at ${official.firstFailure.input} did not reproduce in the frames bench`);
    }
    const vector = primaryBench.vectors[primaryExpected.firstVector];
    const vectorIndex = Number(vector?.index ?? primaryExpected.firstVector);
    if (vectorIndex !== Number(official.firstFailure.index) || primaryExpected.firstCycle !== Number(official.firstFailure.cycle)) {
      throw new Error(`${challengeName(task.taskId)} #${id}: the frames bench first failure (vector ${vectorIndex} cycle ${primaryExpected.firstCycle}) disagrees with the official vectors (vector ${official.firstFailure.index} cycle ${official.firstFailure.cycle})`);
    }
  }

  const failed = official.failed > 0 || settledRuns.some((r) => r.expected.mismatch);
  const constant = constantReference(reference, task, vectors);
  const degenerate = official.degenerate || constant.constant;
  const mismatches = official.failed > 0 ? official.failed : settledRuns.reduce((s, r) => s + r.expected.mismatches, 0);
  const inputs = official.failed > 0 ? official.total : settledRuns.reduce((s, r) => s + r.plan.bench.beats, 0);
  const verdictName = degenerate ? 'unsound-reference' : failed ? 'failed' : 'certified';

  let firstFailingInput = null;
  if (official.failed > 0) firstFailingInput = String(official.firstFailure.input).toLowerCase();
  else {
    const failing = settledRuns.find((r) => r.expected.mismatch);
    if (failing) {
      const b = failing.plan.bench;
      firstFailingInput = b.mode === 'frames'
        ? b.vectors[failing.expected.firstVector]?.input ?? null
        : inputHex(failing.expected.firstInput, design.nIn);
    }
  }

  const findings = [];
  if (degenerate) {
    findings.push({
      code: 'degenerate-reference',
      output: constant.constant ? constant.output : official.constantOutput,
      detail: 'The official reference or its published vectors produce a constant output. Equivalence to that reference can never establish the advertised function, so the verdict is withheld.',
    });
    for (const r of settledRuns) {
      if (!r.expected.mismatch) continue;
      findings.push({
        code: 'divergence',
        bench: r.plan.kind,
        mode: r.plan.bench.mode,
        mismatches: r.expected.mismatches,
        ...(r.plan.bench.mode === 'frames'
          ? { firstVector: r.expected.firstVector, firstCycle: r.expected.firstCycle }
          : { firstInput: inputHex(r.expected.firstInput, design.nIn) }),
        detail: 'The design diverges from the official reference under the swept inputs. This is reported as a finding; it is not a passing certificate.',
      });
    }
  }
  const caveat = degenerate
    ? 'The official reference or vectors are constant; equivalence to them is not evidence for the advertised function. Verdict withheld as unsound-reference.'
    : null;
  const failureAt = official.firstFailure
    ? ` at vector ${official.firstFailure.index} cycle ${official.firstFailure.cycle}`
    : '';
  const outcome = verdictName === 'certified'
    ? `0 mismatches over ${inputs} settled inputs (${coverage}); ${official.passed}/${official.total} official vectors pass.`
    : verdictName === 'unsound-reference'
      ? `Verdict withheld (unsound-reference): ${official.passed}/${official.total} official vectors pass over a constant reference; no sound certificate is possible from the published data.`
      : `${mismatches} mismatch${mismatches === 1 ? '' : 'es'}${official.failed > 0 ? ` in ${official.total} official vectors` : ''}; first failing input ${firstFailingInput}${failureAt}.`;

  const sweeps = settledRuns.map((r) => ({
    kind: r.plan.kind,
    mode: r.plan.bench.mode,
    beats: r.plan.bench.beats,
    ...(r.plan.bench.mode === 'frames' ? { vectors: r.plan.bench.vectors.length } : {}),
    mismatches: r.expected.mismatches,
    ...(r.expected.mismatch
      ? (r.plan.bench.mode === 'frames'
        ? { firstVector: r.expected.firstVector, firstCycle: r.expected.firstCycle }
        : { firstInput: inputHex(r.expected.firstInput, design.nIn) })
      : {}),
    outputs: r.job.outputs,
    job: { runId: r.job.runId, jobId: r.job.jobId, benchId: r.job.benchId },
  }));

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
      certificateSource: certificateSource({ ...official, degenerate }, task),
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
      bench: { id: primary.job.benchId },
    },
    bench: {
      kind: primary.plan.kind,
      mode: primaryBench.mode,
      beats: primaryBench.beats,
      nOut: primaryBench.nOut,
      gatesPerBeat: primary.size.gates,
      stateBits: benchState(primaryBench).length,
      netlistHash: keccak256(asBytes(primaryBench.netlist)),
      ...(primaryBench.mode === 'frames' ? { vectors: primaryBench.vectors.length, vectorBits: primaryBench.vectorBits, cycleBits: primaryBench.cycleBits } : {}),
    },
    inputs,
    inputsCovered: coverage,
    coverage,
    mismatches,
    firstFailingInput,
    settled: {
      inputs: primaryBench.beats,
      mismatches: primaryExpected.mismatches,
      kind: primary.plan.kind,
      ...(primaryBench.mode === 'frames' ? { vectors: primaryBench.vectors.length } : {}),
      ...(primaryBench.mode === 'frames' && primaryExpected.mismatch
        ? { firstVector: primaryExpected.firstVector, firstCycle: primaryExpected.firstCycle, firstVectorIndex: Number(primaryBench.vectors[primaryExpected.firstVector]?.index ?? primaryExpected.firstVector) }
        : {}),
    },
    sweeps,
    officialVectors: {
      passed: official.passed,
      failed: official.failed,
      total: official.total,
      uniqueInputs: official.uniqueInputs,
      exhaustive: official.exhaustive,
      degenerate: official.degenerate,
      constantOutput: official.constantOutput,
      referenceConstant: constant.constant,
      referenceOutput: constant.output,
      firstFailure: official.firstFailure,
    },
    verdict: verdictName,
    ...(caveat ? { caveat } : {}),
    ...(findings.length ? { findings } : {}),
    job: {
      ...primary.job,
      fee: formatEther(dest.fee ?? 0n),
      bond: formatEther(dest.bond),
      outcome,
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
