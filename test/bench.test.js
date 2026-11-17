// Test-bench generator: unit tests against the TAP-02 evaluator, then full Overclock jobs on local ganache.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, parseEther } from 'ethers';
import { Builder } from '../src/hdl.js';
import { load, beat, pack, unpack, hexToBytes, bytesToHex } from '../src/tap02.js';
import { traceJob, Tree, flatSize } from '../src/trace.js';
import { sigPosOf, depsOf, Bisector } from '../src/game.js';
import { adderCircuit, benchCircuit, benchState, benchSize, expectedVerdict, runBench, verdict, breakNand, lfsrNext, inputAt } from '../src/bench.js';

// ---- designs --------------------------------------------------------------------------------
const addRef = (x, w) => (x & (2 ** w - 1)) + (x >> w); // plain JS: a + b
const adder = (w) => adderCircuit(w);
const adderAlt = (w) => adderCircuit(w, { alt: true });
const adderFlawed = (w, at) => adderCircuit(w, { flawAt: at });

// stateful: a 3-bit accumulator, out = acc, acc' = acc + in (mod 8)
const accum = (alt) => {
  const b = new Builder(3);
  const acc = [b.latch(), b.latch(), b.latch()];
  let c = b.zero;
  const sum = [];
  acc.forEach((q, i) => {
    if (alt) { const x = b.xor(q, b.in[i]); sum.push(b.xor(x, c)); c = b.or(b.and(q, b.in[i]), b.and(x, c)); }
    else { const [s, co] = b.fullAdd(q, b.in[i], c); sum.push(s); c = co; }
  });
  acc.forEach((q, i) => b.setLatch(q, sum[i]));
  return b.build(acc.map((q) => b.not(b.not(q))));
};
// same, but acc' = acc ^ in (differs once a carry happens)
const accumXor = () => {
  const b = new Builder(3);
  const acc = [b.latch(), b.latch(), b.latch()];
  acc.forEach((q, i) => b.setLatch(q, b.xor(q, b.in[i])));
  return b.build(acc.map((q) => b.not(b.not(q))));
};

// ---- a local registry of circuits, optionally backed by the mock processor --------------------
const CPU = '0x' + 'ab'.repeat(20);
function registry(addr = CPU, store = null) {
  const byId = new Map();
  const resolve = (a, id) => (a.toLowerCase() === addr.toLowerCase() ? byId.get(Number(id)) ?? null : null);
  let next = 1;
  const add = async (nl, extra = {}) => {
    const c = load(nl.netlist, nl.nIn, nl.nOut, resolve);
    const id = store ? await store(nl, c) : next++;
    byId.set(id, c);
    return { cpu: addr, id, nIn: nl.nIn, nOut: nl.nOut, nState: c.nState, ...extra };
  };
  return { add, resolve, addr };
}

// ---- unit tests -------------------------------------------------------------------------------
test('LFSR taps have full period 2^n - 1 for every supported width up to 18', () => {
  for (let n = 1; n <= 18; n++) {
    let s = 1, k = 0;
    do { s = lfsrNext(s, n); k++; } while (s !== 1 && k <= 2 ** n);
    assert.equal(k, 2 ** n - 1, `n = ${n}`);
  }
  assert.equal(inputAt('count', 8, 5), 5);
  assert.equal(inputAt('lfsr', 3, 0), 1);
});

test('bench over a correct 8-input design certifies it: 0 mismatches over 256 inputs', async () => {
  const R = registry();
  const d = await R.add(adder(4)), r = await R.add(adderAlt(4));
  const bench = benchCircuit(d, r);
  assert.equal(bench.mode, 'count');
  assert.equal(bench.beats, 256);
  assert.equal(bench.nIn, 0);
  assert.equal(bench.nOut, 8 + 2);
  const exp = expectedVerdict(bench, R.resolve);
  assert.equal(exp.mismatches, 0);
  const run = runBench(bench, R.resolve);
  assert.deepEqual(run.outputs, exp.outputs);
  assert.deepEqual(verdict(run.outputs, 8), { mismatch: false, firstInput: null, done: true });
  const sz = benchSize(bench, R.resolve);
  console.log(`    8-input bench: ${sz.gates} gates/beat (${sz.ownGates} own), ${sz.beats} beats, ${sz.steps} steps`);
});

test('bench over a broken design reports the exact first failing input', async () => {
  const R = registry();
  const good = await R.add(adderAlt(4));
  for (const at of [0xa5, 0, 255, 0x3c]) {
    const bad = await R.add(adderFlawed(4, at));
    const bench = benchCircuit(bad, good);
    // plain-JS oracle: the broken circuit against a + b
    const c = R.resolve(CPU, BigInt(bad.id));
    const fails = [];
    for (let x = 0; x < 256; x++) {
      const outs = beat(c, [], Array.from({ length: 8 }, (_, i) => (x >> i) & 1))[1];
      if (outs.reduce((v, b, i) => v + b * 2 ** i, 0) !== addRef(x, 4)) fails.push(x);
    }
    assert.deepEqual(fails, [at]);
    const exp = expectedVerdict(bench, R.resolve);
    assert.equal(exp.firstInput, at);
    assert.equal(exp.mismatches, 1);
    const v = verdict(runBench(bench, R.resolve).outputs, 8);
    assert.deepEqual(v, { mismatch: true, firstInput: at, done: true });
  }
});

test('a NAND broken in place: the bench finds the first of many failing inputs', async () => {
  const R = registry();
  const good = adder(4);
  const r = await R.add(adderAlt(4));
  let tried = 0;
  for (let w = 0; w < 36 && tried < 6; w++) {
    const bad = await R.add({ ...good, netlist: breakNand(good.netlist, 8, w) });
    const bench = benchCircuit(bad, r);
    const c = R.resolve(CPU, BigInt(bad.id));
    let first = null, count = 0;
    for (let x = 0; x < 256; x++) {
      const outs = beat(c, [], Array.from({ length: 8 }, (_, i) => (x >> i) & 1))[1];
      if (outs.reduce((v, b, i) => v + b * 2 ** i, 0) !== addRef(x, 4)) { first ??= x; count++; }
    }
    const exp = expectedVerdict(bench, R.resolve);
    assert.equal(exp.firstInput, first);
    assert.equal(exp.mismatches, count);
    const v = verdict(runBench(bench, R.resolve).outputs, 8);
    assert.equal(v.mismatch, first !== null);
    assert.equal(v.firstInput, first);
    if (first !== null) tried++;
  }
  assert.ok(tried >= 3, 'at least a few mutations were observable');
});

test('stateful designs: LFSR inputs from reset, state carried between beats', async () => {
  const R = registry();
  const good = await R.add(accum(false), { reset: [0, 0, 0] });
  const alt = await R.add(accum(true), { reset: [0, 0, 0] });
  const xor = await R.add(accumXor(), { reset: [0, 0, 0] });
  const ok = benchCircuit(good, alt);
  assert.equal(ok.mode, 'lfsr');
  assert.equal(ok.beats, 7);
  assert.equal(benchState(ok).length, load(ok.netlist, 0, ok.nOut, R.resolve).nState);
  assert.deepEqual(runBench(ok, R.resolve).outputs, expectedVerdict(ok, R.resolve).outputs);
  assert.equal(expectedVerdict(ok, R.resolve).mismatches, 0);
  // plain-JS oracle for acc + in vs acc ^ in along the LFSR sequence
  const bad = benchCircuit(good, xor);
  let x = 1, a = 0, b = 0, first = null;
  for (let k = 0; k < 7 && first === null; k++) {
    if (a !== b) first = x;
    a = (a + x) & 7; b = (b ^ x) & 7;
    x = lfsrNext(x, 3);
  }
  const exp = expectedVerdict(bad, R.resolve);
  assert.equal(exp.firstInput, first);
  assert.deepEqual(verdict(runBench(bad, R.resolve).outputs, 3), { mismatch: true, firstInput: first, done: true });
});

test('a mismatch stays latched and the first failing input is not overwritten', async () => {
  const R = registry();
  const good = await R.add(adderAlt(3));
  const bad = await R.add({ ...adder(3), netlist: breakNand(adder(3).netlist, 6, 0) });
  const bench = benchCircuit(bad, good);
  const exp = expectedVerdict(bench, R.resolve);
  assert.ok(exp.mismatches > 1, 'several failing inputs');
  const c = load(bench.netlist, 0, bench.nOut, R.resolve);
  let st = benchState(bench), outs, seen = false;
  for (let k = 0; k < bench.beats; k++) {
    [st, outs] = beat(c, st, []);
    if (seen) assert.equal(outs[0], 1);
    if (outs[0]) { seen = true; assert.equal(verdict(outs, 6).firstInput, exp.firstInput); }
    assert.equal(outs[7], k === bench.beats - 1 ? 1 : 0, 'done only on the last beat');
  }
});

test('mismatched interfaces are rejected', async () => {
  const R = registry();
  const a = await R.add(adder(4)), b = await R.add(adder(3));
  assert.throws(() => benchCircuit(a, b), /same inputs and outputs/);
});

test('sizes: 8-input and 18-input benches', async () => {
  const R = registry();
  for (const w of [4, 9]) {
    const bench = benchCircuit(await R.add(adder(w)), await R.add(adderAlt(w)));
    const sz = benchSize(bench, R.resolve);
    assert.equal(bench.beats, 2 ** (2 * w));
    console.log(`    ${2 * w}-input bench: ${sz.gates} gates/beat (${sz.ownGates} own), ${sz.beats} beats, ${sz.steps} steps, netlist ${bench.netlist.length} bytes`);
  }
});

// ---- e2e on ganache: the bench as a real Overclock job --------------------------------------
const art = (n) => JSON.parse(readFileSync(new URL(`../build/${n}.json`, import.meta.url)));
const BOND = parseEther('1');
const WINDOW = 3600;
let provider, claimant, challenger, poster, cpu, oc, E; // E: registry backed by the mock processor

async function deploy(name, signer, ...args) {
  const a = art(name);
  const ct = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await ct.waitForDeployment();
  return ct;
}

before(async () => {
  provider = new BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, wallet: { totalAccounts: 3, defaultBalance: 1000 } }));
  [claimant, challenger, poster] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  cpu = await deploy('MockProcessor', poster);
  oc = await deploy('Overclock', poster, BOND, WINDOW, '0x0000000000000000000000000000000000000000', await poster.getAddress(), 0);
  const addr = await cpu.getAddress();
  E = registry(addr, async (nl, c) => {
    const id = Number(await cpu.nextId());
    await (await cpu.store(bytesToHex(nl.netlist), nl.nIn, nl.nOut, c.nState, c.nGates)).wait();
    return id;
  });
});

const evOf = (rc, name) => rc.logs.map((l) => oc.interface.parseLog(l)).find((e) => e?.name === name).args;
const asClaimant = () => oc.connect(claimant);
const asChallenger = () => oc.connect(challenger);

async function postBench(bench) {
  const c = load(bench.netlist, 0, bench.nOut, E.resolve);
  const id = await E.add({ netlist: bench.netlist, nIn: 0, nOut: bench.nOut });
  const state = benchState(bench);
  const rc = await (await oc.connect(poster).postJob(E.addr, id.id, '0x', bytesToHex(pack(state)), bench.beats, false, { value: parseEther('0.1') })).wait();
  return { jobId: evOf(rc, 'JobPosted').jobId, c, state };
}

async function dispute(jobId, C, H, c, honestBits, beats) {
  const gameId = evOf(await (await asChallenger().challenge(jobId, { value: BOND })).wait(), 'Challenged').gameId;
  const b = new Bisector(H);
  let level = C.depth, index = 0;
  while (level > 0) {
    const left = C.node(level - 1, 2 * index), right = C.node(level - 1, 2 * index + 1);
    await (await asClaimant().reveal(gameId, left, right)).wait();
    const goLeft = b.choose(level, index, left, right);
    await (await asChallenger().pick(gameId, !goLeft)).wait();
    index = 2 * index + (goLeft ? 0 : 1);
    level--;
  }
  const deps = depsOf(c, index, beats).map((pos) => ({ pos, bit: honestBits[pos], siblings: b.siblings(pos, index) }));
  const rc = await (await asChallenger().resolveLeaf(gameId, deps)).wait();
  return { q: index, ev: evOf(rc, 'Resolved') };
}

const claimTrace = (jobId, t) => asClaimant().claim(jobId, new Tree(t.leaves).root, bytesToHex(pack(t.outputs)), bytesToHex(pack(t.newState)), { value: BOND });
const finalize = async (jobId) => {
  await provider.send('evm_increaseTime', [WINDOW + 1]);
  await provider.send('evm_mine', []);
  await (await oc.finalize(jobId)).wait();
  const [outs] = await oc.result(jobId);
  return unpack(hexToBytes(outs), 10);
};

test('e2e: a bench over a correct design finalizes as a certificate (0 mismatches over 256 inputs)', async () => {
  const bench = benchCircuit(await E.add(adder(4)), await E.add(adderAlt(4)));
  const { jobId, c, state } = await postBench(bench);
  const t = traceJob(c, { state, beats: bench.beats });
  await (await claimTrace(jobId, t)).wait();
  const outs = await finalize(jobId);
  assert.deepEqual(verdict(outs, 8), { mismatch: false, firstInput: null, done: true });
  console.log(`    certificate job: ${bench.beats} beats x ${t.B} leaves = ${t.n} trace leaves`);
});

test('e2e: a bench over a broken design finalizes with the exact failing input', async () => {
  const bench = benchCircuit(await E.add(adderFlawed(4, 0xa5)), await E.add(adderAlt(4)));
  const { jobId, c, state } = await postBench(bench);
  const t = traceJob(c, { state, beats: bench.beats });
  await (await claimTrace(jobId, t)).wait();
  assert.deepEqual(verdict(await finalize(jobId), 8), { mismatch: true, firstInput: 0xa5, done: true });
});

test('e2e: a false "certified" claim over a broken design is challenged and the liar is slashed', async () => {
  const bench = benchCircuit(await E.add(adderFlawed(4, 0xa5)), await E.add(adderAlt(4)));
  const { jobId, c, state } = await postBench(bench);
  const honest = traceJob(c, { state, beats: bench.beats });
  assert.deepEqual(verdict(honest.outputs, 8).firstInput, 0xa5);
  // the lie: at beat 0xa5 the "differs" signal reads 0, and everything after it is consistent with that
  const lieAt = sigPosOf(c, 0xa5 * honest.B, bench.signals.diff);
  const lied = traceJob(c, { state, beats: bench.beats, fault: lieAt });
  assert.deepEqual(verdict(lied.outputs, 8), { mismatch: false, firstInput: null, done: true }, 'the lie claims a clean certificate');
  await (await claimTrace(jobId, lied)).wait();
  const before = await provider.getBalance(challenger.address);
  const { q, ev } = await dispute(jobId, new Tree(lied.leaves), new Tree(honest.leaves), c, honest.leaves, bench.beats);
  assert.equal(q, lieAt);
  assert.equal(ev.winner, challenger.address);
  assert.equal(ev.reason, 'wrong step');
  assert.ok((await provider.getBalance(challenger.address)) > before, 'challenger collected the bond');
});
