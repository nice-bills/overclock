// D2/D3: certificates for FabX miners.
//
// Unit tests cover the pure pieces: netlist fingerprints and shape grouping, the official-vector
// replay (including the exact first failing input and cycle), the fixed-frame bench for sequential
// vectors, and the runs.json entry. The end-to-end tests run the whole flow on local ganache:
// source circuits -> src/mirror.js -> TapeOutLocal bench -> Overclock post/claim/finalize, once for
// a passing shape and once for a failing miner.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, parseEther } from 'ethers';
import { Builder } from '../src/hdl.js';
import { adderCircuit } from '../src/bench.js';
import { beat, bytesToHex, decode, hexToBytes, load, pack } from '../src/tap02.js';
import { artifact } from '../src/chain.js';
import { createCPU } from '../src/tapeout.js';
import { fetchCircuit } from '../src/mirror.js';
import {
  applyCertificate, certificateEntry, certificateFilename, certificateSource, certifyMiner,
  describeNetlist, fingerprint, groupMinerShapes, inputHex, officialCheck, officialFrames,
  shapeKey, vectorFrames, writeCertificate,
} from '../src/certify.js';
import { benchCircuit, benchState, expectedVerdict, framesVerdict, runBench } from '../src/bench.js';

const bits = (v, n) => Array.from({ length: n }, (_, i) => (v >> i) & 1);
const BOND = parseEther('1');
const WINDOW = 3600;
const P = '0x' + 'aa'.repeat(20);
const REF = '0x' + 'bb'.repeat(20);

// The real GC-094 / miner #2346 data read from the FabX public API: task 94 (2 in / 11 out / 2
// state, 5 cycles), its design, the official reference and all 256 official vectors. Gzip + base64
// keeps the exact fixture in the test without adding a file; it is data, not instructions.
const GC094 = JSON.parse(gunzipSync(Buffer.from([
  'H4sIAAAAAAACA8VczYrl2A1+leB1BSSd/9qFXoRZDeRnFbLwtV2hmJmaobs6dGj6CTKTH8gmEMhqYDbZzi5vk+7nGMo+9rHv+e69',
  'RhhSTcltn2NZ0pElHUmu981z++aL5v79ePysb+6TvWue2q+G5r755aufU7I/+/jXbz/9+bv//fe7j3//4dO//h1f/ve3bz/95/vf',
  '/uJXv/n0l+8//ePHj//8oblrvnh86pt7vmu6P3VfDm+ae3fXPH321NzLXfP0+dvn5p75rvnj0D1//frV12+fnpt7cf6ueT08vHp8',
  '3b19fJ4I+HDX9MObxz88vdBVI3j69XP7PEwXh+cvH988N/cNMb38+HyMNP1MZ5LP7AhdPjMjDJuZ2zP+/541H0bZDK+Hp264IQtb',
  'C8NmRDZMR3/Kxz4fH6Zj4OnYzkeTjy4f8/1tyseMp8142oyny9e7fL3L1/uMt894+4y3z3j7jLfP9/cPWQwCFs9uFs9keXUj7PPZ',
  'Q4Hz7TwgFRApcFSeAmdVmBUibtQqrSDJiFNmnLFAIhnnSMYpbYFEchphfoJ0BRLJyJlkjmQokEge1rxP9M5PN1wgkZH1040pkMjY',
  'NQ/GFTg/3cz3hQIXwc9nqUAi067XyJwKJJKJsm5z1q/Xz2T+zEOBy1q59frZzJ+VAmec1mzO7PoJNmOxvsBljTdnNq6lO5/ZkU+b',
  '12+6usyczrrNWeZvurqcjXzazN90dR6b1sPx5izzN11dzkY+nd3oi13r9cyRG48urGfa02ZmHnPT89r1zFnweWbm1o0cuX4zc/NW',
  'zZrlHtbCnVbFZSxeClzGMmXeFriMZQ3xvsB5zGeZ+VjgvO4+64RvC1zGMtW+K3AZy3LxQ4HLWEJmYuJaTuuzIJs1yk8ItkCiMFIR',
  'Mp3BF0gUJuSn9RhlHsLIZ0ibmd1m5nzfeAzdZma/mTmPjXyGh83MYTMz3xdHmUfZzHzYzMz3xZHP6NYzZyXPM/N9cRyLcTOT1zPn',
  '++Iog3jaPH0jwfm+ONIbh7W+hBaY8nks85ekwHlscQG2wGUsPz35ApexfJZigctYfnxqC1zG8qqkrsBlLMssDQXO+pky7+1aXeax',
  'TGcrBS5jeY1aW+AyltW89QUuY5mHNha4jOU1atsCl7Es67YrcBnL/LVDgUQmrlf6tFZyOvGa3ekqZ/5O4/FkNjNPm5nz2CiDk9/M',
  '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',
].join(''), 'base64')).toString('utf8'));

// A one-input, one-state ticker: out = state, state' = in (or state' = state XOR in).
function ticker(flip = false) {
  const b = new Builder(1);
  const q = b.latch();
  b.setLatch(q, flip ? b.xor(q, b.in[0]) : b.in[0]);
  return b.build([q]);
}

// One input, one output, one state, always output 0: a stand-in for GC-098's constant-zero
// reference, which makes equivalence vacuous (the unsound-reference e2e).
function zeroTicker() {
  const b = new Builder(1);
  const q = b.latch();
  b.setLatch(q, b.zero);
  return b.build([q]);
}

// 256 official-style vectors for an 8-in / 5-out combinational design, expected outputs taken from
// the reference exactly as FabX's vector set is.
function vectorsFor(netlist) {
  const c = load(netlist, 8, 5);
  return Array.from({ length: 256 }, (_, x) => {
    const ins = bits(x, 8);
    // one beat from reset is enough for these combinational designs
    const [, out] = beat(c, new Array(c.nState).fill(0), ins);
    return { index: x, input: bytesToHex(pack(ins)), expectedOut: bytesToHex(pack(out)) };
  });
}

// ---------------------------------------------------------------- fingerprints and shapes

test('netlist fingerprints: byte hash, canonical topology, counts', () => {
  const a = adderCircuit(4);
  const alt = adderCircuit(4, { alt: true });
  const fp = fingerprint({ netlist: a.netlist, nIn: 8, nOut: 5, nState: 0, gateCount: decode(a.netlist, 8).length });
  const d = describeNetlist(a.netlist, 8);
  assert.equal(fp.netlistHash, d.netlistHash);
  assert.equal(fp.structHash, d.structHash);
  assert.equal(fp.topoHash, d.topoHash);
  assert.equal(fp.gates, decode(a.netlist, 8).length);
  assert.equal(fp.nand, d.nand);
  assert.match(fp.netlistHash, /^0x[0-9a-f]{64}$/);
  assert.notEqual(fingerprint({ netlist: alt.netlist, nIn: 8, nOut: 5, nState: 0, gateCount: 0 }).netlistHash, fp.netlistHash);
});

test('shape grouping is per challenge and per byte-identical netlist', () => {
  const a = adderCircuit(4);
  const alt = adderCircuit(4, { alt: true });
  const da = describeNetlist(a.netlist, 8);
  const dalt = describeNetlist(alt.netlist, 8);
  const record = (id, taskId, d) => ({ processor: P, id, taskId, nIn: 8, nOut: 5, nState: 0, gates: d.elements, structHash: d.structHash });
  const groups = groupMinerShapes([
    record(1, 48, da), record(2, 48, da), record(3, 48, da),
    record(4, 48, dalt),
    record(5, 49, da), // same bytes, different Gate Challenge
  ]);
  assert.equal(groups.length, 3);
  const first = groups[0];
  assert.equal(first.count, 3);
  assert.deepEqual(first.ids, [1, 2, 3]);
  assert.deepEqual(first.covers, [{ processor: P, id: 1 }, { processor: P, id: 2 }, { processor: P, id: 3 }]);
  assert.equal(first.taskId, 48);
  assert.equal(first.structHash, da.structHash);
  assert.equal(shapeKey({ taskId: 48, nIn: 8, nOut: 5, nState: 0, structHash: da.structHash }), `${48}:8/5/0:${da.structHash}`);
  assert.equal(groups.find((g) => g.taskId === 49).count, 1, 'same bytes on another challenge is another shape');
});

// ---------------------------------------------------------------- official vectors

test('official vectors: a correct design passes all of them and is detected as exhaustive', () => {
  const alt = adderCircuit(4, { alt: true });
  const vectors = vectorsFor(alt.netlist);
  const check = officialCheck({ netlist: alt.netlist, nIn: 8, nOut: 5, nState: 0 }, { kind: 0, cycles: 1, nIn: 8, nOut: 5 }, vectors);
  assert.equal(check.passed, 256);
  assert.equal(check.failed, 0);
  assert.equal(check.exhaustive, true);
  assert.equal(check.degenerate, false);
  assert.equal(check.firstFailure, null);
  assert.equal(check.uniqueInputs, 256);
  assert.equal(certificateSource(check, { kind: 0 }), 'exhaustive-vectors');
});

test('official vectors: a broken design reports the exact first failing input and gets', () => {
  const alt = adderCircuit(4, { alt: true });
  const bad = adderCircuit(4, { flawAt: 0xa5 });
  const vectors = vectorsFor(alt.netlist);
  const check = officialCheck({ netlist: bad.netlist, nIn: 8, nOut: 5, nState: 0 }, { kind: 0, cycles: 1, nIn: 8, nOut: 5 }, vectors);
  assert.equal(check.failed, 1);
  assert.equal(check.passed, 255);
  assert.deepEqual(check.firstFailure, {
    index: 0xa5,
    cycle: 0,
    input: '0xa5',
    expected: vectors[0xa5].expectedOut,
    got: '01110',
  });
});

test('official vectors: constant-zero sets are marked degenerate', () => {
  const alt = adderCircuit(4, { alt: true });
  const vectors = vectorsFor(alt.netlist).map((v) => ({ ...v, expectedOut: '0x00' }));
  const check = officialCheck({ netlist: alt.netlist, nIn: 8, nOut: 5, nState: 0 }, { kind: 0, cycles: 1, nIn: 8, nOut: 5 }, vectors);
  assert.equal(check.degenerate, true);
  assert.equal(check.failed, 255, 'only input 0 matches the zero reference');
  assert.equal(certificateSource(check, { kind: 0 }), 'degenerate');
});

test('official vectors: sequential tasks replay every cycle from reset', () => {
  const good = ticker(false), bad = ticker(true);
  // three frames: state starts 0, so outputs are 0, 1, 0. The XOR ticker outputs 0, 1, 1.
  const vector = { index: 0, input: bytesToHex(Uint8Array.from([1, 0, 0])), expectedOut: bytesToHex(Uint8Array.from([0, 1, 0])) };
  const task = { kind: 1, cycles: 3, nIn: 1, nOut: 1 };
  const ok = officialCheck({ netlist: good.netlist, nIn: 1, nOut: 1, nState: 1 }, task, [vector]);
  assert.equal(ok.passed, 1, 'the plain ticker matches all three frames');
  const fail = officialCheck({ netlist: bad.netlist, nIn: 1, nOut: 1, nState: 1 }, task, [vector]);
  assert.equal(fail.failed, 1);
  assert.equal(fail.firstFailure.cycle, 2);
  assert.equal(fail.firstFailure.got, '1');
});

test('official #2346 vectors: the first failure is vector 17 cycle 4', () => {
  const check = officialCheck(GC094.design, GC094.task, GC094.vectors);
  assert.equal(check.total, 256);
  assert.equal(check.passed, 221);
  assert.equal(check.failed, 35);
  assert.equal(check.degenerate, false);
  assert.deepEqual(check.firstFailure, {
    index: 17,
    cycle: 4,
    input: '0x0302000200',
    expected: '0x00000000000001000004',
    got: '10000000000',
  });
});

// ---------------------------------------------------------------- frames-mode bench

test('frames bench reproduces a sequential vector failure at the right vector and cycle', () => {
  const resolve = () => null;
  const cpu = '0x' + '11'.repeat(20);
  const good = load(ticker(false).netlist, 1, 1);
  const bad = load(ticker(true).netlist, 1, 1);
  const d = { cpu, id: 1, nIn: 1, nOut: 1, nState: good.nState, circuit: good, reset: [] };
  const r = { cpu, id: 2, nIn: 1, nOut: 1, nState: bad.nState, circuit: bad, reset: [] };
  // The tickers agree on cycle 0 of both vectors, then the XOR ticker diverges: vector 0 cycle 2
  // is the first failure and later failures must not overwrite it.
  const vectors = [
    { index: 0, frames: [[1], [0], [1]] },
    { index: 3, frames: [[1], [1], [0]] },
  ];
  const bench = benchCircuit(d, r, { mode: 'frames', vectors });
  assert.equal(bench.beats, 6);
  assert.equal(bench.vectors.length, 2);
  assert.equal(bench.vectorBits, 1);
  assert.equal(bench.cycleBits, 2);
  assert.equal(bench.nOut, 5); // mismatch + vector + cycle + done
  const exp = expectedVerdict(bench, resolve);
  assert.equal(exp.mismatch, true);
  assert.equal(exp.firstVector, 0);
  assert.equal(exp.firstCycle, 2);
  assert.equal(exp.mismatches, 2);
  const run = runBench(bench, resolve);
  assert.deepEqual(run.outputs, exp.outputs);
  assert.deepEqual(framesVerdict(run.outputs, bench), { mismatch: true, firstVector: 0, firstCycle: 2, done: true });
  assert.equal(benchState(bench).length, load(bench.netlist, 0, bench.nOut, resolve).nState);
});

test('frames bench certifies identical sequential designs over every vector from reset', () => {
  const resolve = () => null;
  const cpu = '0x' + '11'.repeat(20);
  const a = load(ticker(false).netlist, 1, 1);
  const b = load(ticker(false).netlist, 1, 1);
  const d = { cpu, id: 1, nIn: 1, nOut: 1, nState: a.nState, circuit: a, reset: [] };
  const r = { cpu, id: 2, nIn: 1, nOut: 1, nState: b.nState, circuit: b, reset: [] };
  // Without a reset at every vector boundary the second vector would start from vector 0's state.
  const bench = benchCircuit(d, r, {
    mode: 'frames',
    vectors: [{ index: 0, frames: [[1], [1], [0]] }, { index: 1, frames: [[0], [0], [1]] }],
  });
  const exp = expectedVerdict(bench, resolve);
  assert.equal(exp.mismatch, false);
  assert.equal(exp.mismatches, 0);
  assert.deepEqual(framesVerdict(runBench(bench, resolve).outputs, bench), { mismatch: false, firstVector: null, firstCycle: null, done: true });
});

test('official #2346 vectors become frames that latch the exact first failure', () => {
  const resolve = () => null;
  const cpu = '0x' + '11'.repeat(20);
  const d = load(hexToBytes(GC094.design.netlist), GC094.design.nIn, GC094.design.nOut);
  const r = load(hexToBytes(GC094.reference.netlist), GC094.reference.nIn, GC094.reference.nOut);
  const dDesc = { cpu, id: 1, nIn: GC094.design.nIn, nOut: GC094.design.nOut, nState: d.nState, circuit: d, reset: [] };
  const rDesc = { cpu, id: 2, nIn: GC094.reference.nIn, nOut: GC094.reference.nOut, nState: r.nState, circuit: r, reset: [] };
  const vectors = officialFrames(GC094.vectors, GC094.task, GC094.design.nIn);
  assert.equal(vectors.length, 256);
  assert.equal(vectors[0].frames.length, 5);
  assert.equal(vectors[0].index, 0);
  assert.deepEqual(vectors[17].frames[4], [0, 0]); // last frame of 0x0302000200
  const bench = benchCircuit(dDesc, rDesc, { mode: 'frames', vectors });
  assert.equal(bench.beats, 1280);
  assert.equal(bench.vectorBits, 8);
  assert.equal(bench.cycleBits, 3);
  const exp = expectedVerdict(bench, resolve);
  assert.equal(exp.firstVector, 17);
  assert.equal(exp.firstCycle, 4);
  assert.deepEqual(framesVerdict(exp.outputs, bench), {
    mismatch: true, firstVector: 17, firstCycle: 4, done: true,
  });
  assert.deepEqual(framesVerdict(runBench(bench, resolve).outputs, bench), {
    mismatch: true, firstVector: 17, firstCycle: 4, done: true,
  });
});

// ---------------------------------------------------------------- certificate / runs.json

test('certificate entries carry the site fields and upsert without duplicates', () => {
  const job = {
    chainId: 31337, overclock: '0x' + 'cc'.repeat(20), jobId: 0, runId: '31337:0',
    txs: [{ what: 'post job', tx: '0x' + '01'.repeat(32), gas: 100 }], gas: { post: 100, claim: 90, finalize: 80, honestPath: 270 },
    outputs: '0x00', newState: '0x00', traceLeaves: 4096, beats: 256, postedAt: '2026-01-01T00:00:00.000Z', finalizedAt: '2026-01-01T00:00:01.000Z',
    fee: '0.0', bond: '1.0', outcome: 'ok',
  };
  const cert = {
    id: `cert:196:${P}:1`,
    design: { processor: P, id: 1, gates: 20, nIn: 4, nOut: 4, nState: 0 },
    reference: { processor: REF, id: 48 },
    challenge: { taskId: 48, name: 'GC-048 test', label: 'GC-048 test' },
    job,
    inputs: 16, mismatches: 0, verdict: 'certified', coverage: 'all 16 inputs',
    issuedAt: '2026-01-01T00:00:00.000Z',
    shape: { covers: [{ processor: P, id: 1 }, { processor: P, id: 2 }] },
    bench: { gatesPerBeat: 100 },
  };
  assert.equal(certificateFilename(P, 1), `${P}-1.json`);
  assert.equal(inputHex(0xa5, 8), '0xa5');
  const entry = certificateEntry(cert);
  assert.equal(entry.status, 'certified');
  assert.equal(entry.runId, '31337:0');
  assert.equal(entry.covers.length, 2);
  assert.equal(entry.certificate, `${P}-1.json`);
  const doc = applyCertificate({ schema: 1, runs: [], certificates: [] }, cert);
  assert.equal(doc.runs.length, 1);
  assert.equal(doc.certificates.length, 1);
  const again = applyCertificate(doc, cert);
  assert.equal(again.runs.length, 1, 're-running replaces the run');
  assert.equal(again.certificates.length, 1, 're-running replaces the certificate');
});

test('a failed certificate is a first-class entry', () => {
  const cert = {
    id: 'cert:196:x:2',
    design: { processor: P, id: 2, gates: 1, nIn: 8, nOut: 1, nState: 0 },
    reference: { processor: REF, id: 13 },
    challenge: { taskId: 13, name: 'GC-013 test', label: 'GC-013 test' },
    job: { chainId: 31337, overclock: '0x' + 'cc'.repeat(20), jobId: 1, runId: '31337:1', txs: [], gas: {}, beats: 256, traceLeaves: 256, fee: '0.0', bond: '1.0', outcome: 'failed' },
    bench: { gatesPerBeat: 1 },
    inputs: 256, mismatches: 16, firstFailingInput: '0x00', verdict: 'failed',
    coverage: '256 vectors', issuedAt: '2026-01-01T00:00:00.000Z',
  };
  const entry = certificateEntry(cert);
  assert.equal(entry.status, 'failed');
  assert.equal(entry.firstFailingInput, '0x00');
  assert.equal(entry.mismatches, 16);
});

// ---------------------------------------------------------------- e2e on local ganache

let provider, sourceProvider, dest, source, sourceCpu, tasks, vectorsById;
let passing, failing, stateful, unsound, destDir;

async function deploy(name, signer, ...args) {
  const a = artifact(name);
  const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}

before(async () => {
  provider = new BrowserProvider(ganache.provider({
    logging: { quiet: true },
    chain: { chainId: 31337, hardfork: 'shanghai' },
    miner: { blockGasLimit: 2_000_000_000, callGasLimit: 2_000_000_000 },
    wallet: { totalAccounts: 4, defaultBalance: 1000 },
  }), undefined, { cacheTimeout: -1 });
  const [sourceOwner, destOwner] = await Promise.all([0, 1].map((i) => provider.getSigner(i)));

  // ---- source: a MockProcessor holding "mainnet" circuits
  const mock = await deploy('MockProcessor', sourceOwner);
  sourceCpu = (await mock.getAddress()).toLowerCase();
  const store = async (built) => {
    const c = load(built.netlist, built.nIn, built.nOut);
    const id = Number(await mock.nextId());
    await (await mock.store(bytesToHex(built.netlist), built.nIn, built.nOut, c.nState, c.nGates)).wait();
    return id;
  };
  const pass = adderCircuit(4);
  const alt = adderCircuit(4, { alt: true });
  const bad = adderCircuit(4, { flawAt: 0xa5 });
  const passId = await store(pass);
  const altId = await store(alt);
  const badId = await store(bad);
  // Real GC-094 / #2346 design + official reference, and a GC-098-style constant-zero pair.
  const seqDesignId = await store({ netlist: hexToBytes(GC094.design.netlist), nIn: GC094.design.nIn, nOut: GC094.design.nOut });
  const seqRefId = await store({ netlist: hexToBytes(GC094.reference.netlist), nIn: GC094.reference.nIn, nOut: GC094.reference.nOut });
  const zero = zeroTicker();
  const zeroId = await store(zero);
  const zeroRefId = await store(zero);

  const vectors = vectorsFor(alt.netlist);
  const zeroVectors = Array.from({ length: 4 }, (_, index) => ({ index, input: '0x0000', expectedOut: '0x0000' }));
  tasks = new Map([
    [1, { taskId: 1, name: 'GC-048 test adder', kind: 0, cycles: 1, nIn: 8, nOut: 5, refCircuits: sourceCpu, refCircuitId: BigInt(altId) }],
    [2, { taskId: 2, name: 'GC-028 test adder', kind: 0, cycles: 1, nIn: 8, nOut: 5, refCircuits: sourceCpu, refCircuitId: BigInt(altId) }],
    [94, { ...GC094.task, refCircuits: sourceCpu, refCircuitId: BigInt(seqRefId) }],
    [98, { taskId: 98, name: 'GC-098 test constant zero', kind: 1, cycles: 2, nIn: 1, nOut: 1, refCircuits: sourceCpu, refCircuitId: BigInt(zeroRefId) }],
  ]);
  vectorsById = new Map([[1, vectors], [2, vectors], [94, GC094.vectors], [98, zeroVectors]]);
  sourceProvider = provider;
  const taskOf = new Map([[passId, 1], [badId, 2], [seqDesignId, 94], [zeroId, 98]]);
  source = {
    chainId: 31337,
    provider,
    miner: async (cpu, id) => ({ taskId: taskOf.get(Number(id)) ?? 0, status: 1 }),
    task: async (taskId) => tasks.get(Number(taskId)),
    vectors: async (taskId) => vectorsById.get(Number(taskId)),
    circuit: async (cpu, id) => fetchCircuit(provider, cpu, id),
  };

  // ---- destination: TapeOutLocal + Overclock, all local
  const factory = await deploy('TapeOutFactoryLocal', destOwner);
  const cpu = await createCPU(destOwner, await factory.getAddress(), {
    name: 'Certifier Test', symbol: 'CT', story: 'certify e2e', supply: 1_000_000, mintPrice: 1n,
  });
  const overclock = await deploy('Overclock', destOwner, BOND, WINDOW, await factory.getAddress(), await destOwner.getAddress(), 0, 0, 0, '0x0000000000000000000000000000000000000000');
  dest = {
    provider,
    chainId: 31337,
    processor: (await cpu.circuits.getAddress()).toLowerCase(),
    circuits: cpu.circuits,
    transistors: cpu.transistors,
    overclock,
    signer: destOwner,
    window: WINDOW,
    bond: BOND,
    fee: 0n,
    advance: async () => {
      await provider.send('evm_increaseTime', [WINDOW + 1]);
      await provider.send('evm_mine', []);
    },
  };

  passing = { processor: sourceCpu, id: passId };
  failing = { processor: sourceCpu, id: badId };
  stateful = { processor: sourceCpu, id: seqDesignId };
  unsound = { processor: sourceCpu, id: zeroId };
  destDir = mkdtempSync(join(tmpdir(), 'overclock-certify-'));
});

after(() => {
  if (destDir) rmSync(destDir, { recursive: true, force: true });
});

test('e2e: a passing miner is mirrored, benched and finalized as a certificate', async () => {
  const shapeFp = describeNetlist(adderCircuit(4).netlist, 8);
  const shape = {
    key: shapeKey({ taskId: 1, nIn: 8, nOut: 5, nState: 0, structHash: shapeFp.structHash }),
    taskId: 1, structHash: shapeFp.structHash, count: 2,
    covers: [{ processor: sourceCpu, id: passing.id }, { processor: sourceCpu, id: 999 }],
  };
  const cert = await certifyMiner({
    processor: passing.processor, id: passing.id, source, dest, shape, covers: shape.covers,
    now: () => '2026-01-02T03:04:05.000Z',
  });
  assert.equal(cert.verdict, 'certified');
  assert.equal(cert.mismatches, 0);
  assert.equal(cert.firstFailingInput, null);
  assert.equal(cert.inputs, 256);
  assert.equal(cert.officialVectors.passed, 256);
  assert.equal(cert.challenge.taskId, 1);
  assert.equal(cert.challenge.certificateSource, 'exhaustive-vectors');
  assert.equal(cert.design.processor, sourceCpu);
  assert.equal(cert.design.id, passing.id);
  assert.equal(cert.design.netlistHash, fingerprint(await fetchCircuit(provider, sourceCpu, passing.id)).netlistHash);
  assert.equal(cert.reference.id, Number(tasks.get(1).refCircuitId));
  assert.equal(cert.mirror.chainId, 31337);
  assert.equal(cert.shape.covers.length, 2);
  assert.equal(cert.job.chainId, 31337);
  assert.equal(cert.job.txs.length, 3);
  assert.deepEqual(cert.job.txs.map((t) => t.what), ['post job', 'claim', 'finalize']);
  assert.equal(cert.job.gas.honestPath, cert.job.gas.post + cert.job.gas.claim + cert.job.gas.finalize);
  assert.equal(cert.issuedAt, '2026-01-02T03:04:05.000Z');

  const job = await dest.overclock.jobs(cert.job.jobId);
  assert.equal(job.finalized, true);
  const [outs] = await dest.overclock.result(cert.job.jobId);
  assert.equal(hexToBytes(outs)[0] & 1, 0, 'mismatch bit stays 0');

  const file = writeCertificate(cert, destDir);
  assert.match(file, /\.json$/);
  const onDisk = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(onDisk.verdict, 'certified');
  assert.equal(onDisk.job.runId, cert.job.runId);
  const doc = applyCertificate({ schema: 1, runs: [], certificates: [] }, cert);
  assert.equal(doc.certificates[0].status, 'certified');
  assert.equal(doc.certificates[0].covers.length, 2);
});

test('e2e: a failing miner finalizes with the exact first failing input', async () => {
  const cert = await certifyMiner({ processor: failing.processor, id: failing.id, source, dest });
  assert.equal(cert.verdict, 'failed');
  assert.equal(cert.firstFailingInput, '0xa5');
  assert.equal(cert.mismatches, 1);
  assert.equal(cert.officialVectors.failed, 1);
  assert.deepEqual(cert.officialVectors.firstFailure, {
    index: 0xa5, cycle: 0, input: '0xa5', expected: vectorsById.get(2)[0xa5].expectedOut, got: '01110',
  });
  assert.equal(cert.settled.inputs, 256, 'the truth-table bench settles the whole 8-input space');
  assert.equal(cert.settled.mismatches, 1);
  assert.equal(cert.bench.kind, 'truth-table');

  const job = await dest.overclock.jobs(cert.job.jobId);
  assert.equal(job.finalized, true);
  const [outs] = await dest.overclock.result(cert.job.jobId);
  const bitsOut = Array.from({ length: cert.design.nIn + 2 }, (_, i) => (hexToBytes(outs)[i >> 3] >> (i & 7)) & 1);
  assert.equal(bitsOut[0], 1, 'the settled job latched a mismatch');
  assert.equal(bitsOut.slice(1, 9).reduce((v, b, i) => v + b * 2 ** i, 0), 0xa5, 'and the exact failing input');

  const doc = applyCertificate({ schema: 1, runs: [], certificates: [] }, cert);
  assert.equal(doc.certificates[0].status, 'failed');
  assert.equal(doc.certificates[0].firstFailingInput, '0xa5');
});

test('e2e: #2346 GC-094 is caught by the frames job at vector 17 cycle 4', async () => {
  const cert = await certifyMiner({ processor: stateful.processor, id: stateful.id, source, dest });
  assert.equal(cert.verdict, 'failed');
  assert.equal(cert.challenge.taskId, 94);
  assert.equal(cert.challenge.certificateSource, 'reference-equivalence');
  assert.equal(cert.firstFailingInput, '0x0302000200');
  assert.equal(cert.officialVectors.failed, 35);
  assert.deepEqual(cert.officialVectors.firstFailure, {
    index: 17, cycle: 4, input: '0x0302000200', expected: '0x00000000000001000004', got: '10000000000',
  });
  // The certificate settles every official vector as per-cycle frames from reset.
  assert.equal(cert.settled.kind, 'official-vectors');
  assert.equal(cert.settled.vectors, 256);
  assert.equal(cert.settled.firstVector, 17);
  assert.equal(cert.settled.firstCycle, 4);
  assert.equal(cert.settled.firstVectorIndex, 17);
  assert.equal(cert.bench.mode, 'frames');
  assert.equal(cert.bench.vectors, 256);
  assert.equal(cert.bench.beats, 1280);
  // The LFSR sweep alone passes; the frames replay is what catches this miner.
  const lfsr = cert.sweeps.find((s) => s.kind === 'lfsr');
  assert.equal(lfsr.mismatches, 0, 'the LFSR sweep still passes');
  // The settled job itself latched the same (vector, cycle).
  const [outs] = await dest.overclock.result(cert.job.jobId);
  const bits = Array.from({ length: 13 }, (_, i) => (hexToBytes(outs)[i >> 3] >> (i & 7)) & 1);
  const value = (bs) => bs.reduce((v, b, i) => v + b * 2 ** i, 0);
  assert.equal(bits[0], 1, 'the job latched a mismatch');
  assert.equal(value(bits.slice(1, 9)), 17, 'first failing vector');
  assert.equal(value(bits.slice(9, 12)), 4, 'first failing cycle');
  assert.equal(bits[12], 1, 'done');
});

test('e2e: a GC-098-style constant reference is unsound-reference, never certified', async () => {
  const cert = await certifyMiner({ processor: unsound.processor, id: unsound.id, source, dest });
  assert.equal(cert.verdict, 'unsound-reference');
  assert.equal(cert.challenge.taskId, 98);
  assert.equal(cert.challenge.certificateSource, 'degenerate');
  assert.equal(cert.officialVectors.degenerate, true);
  assert.equal(cert.officialVectors.constantOutput, '0x0000');
  assert.equal(cert.officialVectors.referenceConstant, true);
  assert.equal(cert.officialVectors.referenceOutput, '0');
  assert.ok(cert.findings.some((f) => f.code === 'degenerate-reference'));
  assert.match(cert.caveat, /unsound-reference/);
  assert.deepEqual(cert.sweeps.map((s) => s.kind), ['official-vectors', 'lfsr']);
  assert.ok(cert.sweeps.every((s) => s.mismatches === 0), 'both benches agree; the reference is what is unsound');
  const entry = certificateEntry(cert);
  assert.equal(entry.status, 'unsound-reference');
  assert.equal(entry.findings[0].code, 'degenerate-reference');
});

test('certifyMiner refuses mainnet and testnet destinations before touching anything', async () => {
  const stub = { chainId: 196 };
  await assert.rejects(
    certifyMiner({ processor: passing.processor, id: passing.id, source, dest: stub }),
    /refusing to certify on chain 196/,
  );
  await assert.rejects(
    certifyMiner({ processor: passing.processor, id: passing.id, source, dest: { chainId: 1952 } }),
    /refusing to certify on chain 1952/,
  );
});
