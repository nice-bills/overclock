// overclock-js: every public call against a real v2 Overclock on a local EVM (ganache), plus an
// end-to-end run of examples/post-and-read.js against a ganache node served over HTTP.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ganache from 'ganache';
import { BrowserProvider, Contract, Interface, parseEther } from 'ethers';
import { connect, Status, NotFinalizedError, OVERCLOCK_ABI, Operator, Challenger, artifact, beat, pack, unpack, hexToBytes, bytesToHex, traceJob, Tree, load } from '../packages/overclock-js/src/index.js';
import { deployLocalStack } from '../packages/overclock-js/examples/local-stack.js';

const vectors = JSON.parse(readFileSync(new URL('../vendor-tap02/vectors.json', import.meta.url)));
const byName = Object.fromEntries(vectors.valid.map((v) => [v.name, v]));
const BOND = parseEther('1');
const FEE = parseEther('0.1');
const WINDOW = 3600;
const BOND_BPS = 10_000; // a job's bond is BOND + fee * BOND_BPS / 10,000
const FEE_BPS = 200;

let provider, poster, operator, other, stack, app, reader, full, refState, toggle;
let stateful; // the loaded stateful circuit, for local evaluation

const server = (extra = {}) => ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, wallet: { totalAccounts: 4, defaultBalance: 1000 }, ...extra });
const advance = async (secs) => {
  await provider.send('evm_increaseTime', [secs]);
  await provider.send('evm_mine', []);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const addr = (s) => s.getAddress();

before(async () => {
  provider = new BrowserProvider(server(), undefined, { cacheTimeout: -1 }); // no read cache: a status check right after a block must see it
  [poster, operator, other] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  stack = await deployLocalStack(poster, { bond: BOND, window: WINDOW, feeBps: FEE_BPS, bondBps: BOND_BPS });
  // a stateful circuit: ref_with_state REFs toggle, so point its REF at our processor's copy of it
  toggle = await stack.store(byName.toggle.netlist, byName.toggle.nIn, byName.toggle.nOut);
  const tog = load(hexToBytes(byName.toggle.netlist), byName.toggle.nIn, byName.toggle.nOut);
  const resolve = (a, i) => (a.toLowerCase() === stack.processor.toLowerCase() && BigInt(i) === toggle ? tog : null);
  const ref = byName.ref_with_state;
  const nl = ref.netlist.replace('00000000000000000000000000000000000000aa0000000000000001', stack.processor.slice(2).toLowerCase() + toggle.toString(16).padStart(16, '0'));
  refState = await stack.store(nl, ref.nIn, ref.nOut, resolve);
  stateful = load(hexToBytes(nl), ref.nIn, ref.nOut, resolve);
  app = connect({ signer: poster, overclock: stack.overclock });
  reader = connect({ provider, overclock: stack.overclock });
  full = new Contract(stack.overclock, artifact('Overclock').abi, provider);
});

const operatorFor = (signer, jobId, opts = {}) => {
  const op = new Operator({ oc: full, signer, name: 'op', ...opts });
  op.only = new Set([Number(jobId)]);
  return op;
};

// post a popcount job through the library
const postPop = (inputs = [1, 0, 1, 1, 0, 1, 1, 1], fee = FEE) => app.postJob({ processor: stack.processor, circuitId: stack.circuits.popcount, inputs, fee });

test('the bundled ABI is the compiled contract\'s (same signature for every fragment)', () => {
  const built = new Interface(artifact('Overclock').abi);
  for (const frag of new Interface(OVERCLOCK_ABI).fragments) {
    const theirs = frag.type === 'event' ? built.getEvent(frag.name) : built.getFunction(frag.name);
    assert.ok(theirs, `${frag.name} exists in the contract`);
    assert.equal(theirs.format('full'), frag.format('full'), frag.name);
  }
});

test('connect needs a signer or provider and an address; a read-only client cannot send', async () => {
  assert.throws(() => connect({ overclock: stack.overclock }), /signer or a provider/);
  assert.throws(() => connect({ signer: poster }), /address/);
  await assert.rejects(reader.postJob({ processor: stack.processor, circuitId: stack.circuits.popcount }), /connect with a signer/);
  await assert.rejects(reader.finalize(0), /connect with a signer/);
  assert.equal(app.address, stack.overclock);
});

test('postJob: posts, reports the per-job bond, packs inputs', async () => {
  const before = await full.jobCount();
  const held = await provider.getBalance(stack.overclock);
  const { jobId, bond, txHash, receipt } = await postPop([1, 0, 1, 1, 0, 1, 1, 1]);
  assert.equal(jobId, before);
  assert.equal(bond, BOND + (FEE * BigInt(BOND_BPS)) / 10_000n); // bondFor(jobId)
  assert.equal(bond, await full.bondFor(jobId));
  assert.equal(receipt.hash, txHash);
  const j = await full.jobs(jobId);
  assert.equal(j.fee, FEE);
  assert.equal(j.poster, await addr(poster));
  assert.equal(j.cpu, stack.processor);
  assert.equal(j.id, BigInt(stack.circuits.popcount));
  assert.equal(j.beats, 1n);
  assert.equal(j.perBeat, false);
  assert.deepEqual(unpack(hexToBytes(j.inputs), 8), [1, 0, 1, 1, 0, 1, 1, 1]);
  assert.equal((await provider.getBalance(stack.overclock)) - held, FEE, 'the fee is held by the contract');
});

test('postJob: short inputs are padded, packed hex works, fee may be a number or string, zero fee is fine', async () => {
  const a = await postPop([1, 1]);
  assert.deepEqual((await app.getJob(a.jobId)).inputs, [1, 1, 0, 0, 0, 0, 0, 0]);
  const b = await app.postJob({ processor: stack.processor, circuitId: stack.circuits.popcount, inputs: '0xff', fee: '12345' });
  assert.deepEqual((await app.getJob(b.jobId)).inputs, [1, 1, 1, 1, 1, 1, 1, 1]);
  assert.equal((await app.getJob(b.jobId)).fee, 12345n);
  const c = await app.postJob({ processor: stack.processor, circuitId: stack.circuits.popcount, inputs: new Uint8Array([0x0f]) });
  assert.deepEqual((await app.getJob(c.jobId)).inputs, [1, 1, 1, 1, 0, 0, 0, 0]);
  assert.equal((await app.getJob(c.jobId)).fee, 0n);
  assert.equal(c.bond, BOND, 'no fee: the minimum bond');
});

test('postJob: perBeat inputs and a starting state', async () => {
  // refState: 1 input, 2 state bits. Three beats, one input bit per beat.
  const { jobId } = await app.postJob({ processor: stack.processor, circuitId: refState, beats: 3, inputs: [1, 0, 1], state: [1, 0], fee: FEE });
  const j = await app.getJob(jobId);
  assert.equal(j.perBeat, true, 'more than one beat\'s bits means perBeat');
  assert.equal(j.beats, 3);
  assert.deepEqual(j.inputs, [1, 0, 1]);
  assert.deepEqual(j.state, [1, 0]);
  // one beat's inputs applied every beat, state defaulting to zeros
  const k = await app.postJob({ processor: stack.processor, circuitId: refState, beats: 3, inputs: [1] });
  const jk = await app.getJob(k.jobId);
  assert.equal(jk.perBeat, false);
  assert.deepEqual(jk.state, [0, 0]);
  // explicit perBeat with packed bytes
  const e = await app.postJob({ processor: stack.processor, circuitId: refState, beats: 4, inputs: '0x05', perBeat: true });
  assert.deepEqual((await app.getJob(e.jobId)).inputs, [1, 0, 1, 0]);
});

test('postJob rejects bad arguments before sending anything', async () => {
  const n = await full.jobCount();
  const base = { processor: stack.processor, circuitId: stack.circuits.popcount };
  await assert.rejects(app.postJob({ circuitId: 1 }), /processor is required/);
  await assert.rejects(app.postJob({ processor: stack.processor }), /circuitId is required/);
  await assert.rejects(app.postJob({ ...base, beats: 0 }), /beats/);
  await assert.rejects(app.postJob({ ...base, beats: 1.5 }), /beats/);
  await assert.rejects(app.postJob({ ...base, inputs: new Array(9).fill(1), perBeat: false }), /9 bits given, the circuit takes 8/);
  await assert.rejects(app.postJob({ ...base, state: [1] }), /state: 1 bits given, the circuit takes 0/);
  await assert.rejects(app.postJob({ ...base, inputs: 42 }), /array of bits or packed bytes/);
  assert.equal(await full.jobCount(), n, 'nothing was posted');
});

test('getJob walks the job through every status', async () => {
  const { jobId, bond } = await postPop();
  let j = await app.getJob(jobId);
  assert.equal(j.status, Status.Unclaimed);
  assert.equal(j.claimant, null);
  assert.equal(j.traceRoot, null);
  assert.equal(j.windowEndsAt, null);
  assert.equal(j.claimedOutputs, null);
  assert.equal(j.bond, bond);
  assert.equal(j.fee, FEE);
  assert.equal(j.processor, stack.processor);
  assert.equal(j.circuitId, BigInt(stack.circuits.popcount));
  assert.equal(j.beats, 1);
  assert.equal(j.finalized, false);

  const op = operatorFor(operator, jobId);
  await op.tick();
  j = await reader.getJob(jobId);
  assert.equal(j.status, Status.Claimed);
  assert.equal(j.claimant, await addr(operator));
  assert.match(j.traceRoot, /^0x[0-9a-f]{64}$/);
  assert.equal(j.windowEndsAt, j.claimedAt + WINDOW);
  assert.deepEqual(j.claimedOutputs, [0, 1, 1, 0]);
  assert.deepEqual(j.claimedState, []);

  await advance(WINDOW + 1);
  assert.equal((await app.getJob(jobId)).status, Status.Finalizable);
  await app.finalize(jobId);
  j = await app.getJob(jobId);
  assert.equal(j.status, Status.Finalized);
  assert.equal(j.finalized, true);
});

test('getJob shows a disputed claim as challenged', async () => {
  const { jobId, bond } = await postPop([1, 1, 0, 0, 0, 0, 0, 1]);
  await operatorFor(operator, jobId).tick();
  await (await full.connect(other).challenge(jobId, { value: bond })).wait();
  const j = await app.getJob(jobId);
  assert.equal(j.status, Status.Challenged);
  assert.equal(j.openGames, 1);
  await advance(WINDOW + 1);
  assert.equal((await app.getJob(jobId)).status, Status.Challenged, 'an open dispute keeps it from finalizing');
  await assert.rejects(app.finalize(jobId));
  // the claimant never answers: the challenger wins on timeout and the job reopens
  await (await full.connect(other).timeout((await full.gameCount()) - 1n)).wait();
  assert.equal((await app.getJob(jobId)).status, Status.Unclaimed);
});

test('watchJob resolves when the job finalizes and reports each status once', async () => {
  const { jobId } = await postPop();
  const seen = [];
  const watching = app.watchJob(jobId, { intervalMs: 15, onUpdate: (j) => seen.push(j.status) });
  const sawNext = async (status) => { for (let i = 0; i < 200 && !seen.includes(status); i++) await sleep(25); };
  await sawNext(Status.Unclaimed);
  await operatorFor(operator, jobId).tick();
  await sawNext(Status.Claimed);
  await advance(WINDOW + 1);
  await sawNext(Status.Finalizable);
  await app.finalize(jobId);
  const job = await watching;
  assert.equal(job.status, Status.Finalized);
  assert.deepEqual(seen, [Status.Unclaimed, Status.Claimed, Status.Finalizable, Status.Finalized]);
});

test('watchJob: until a given status, a list of statuses, an already-final job, timeout and abort', async () => {
  const { jobId } = await postPop();
  await operatorFor(operator, jobId).tick();
  assert.equal((await app.watchJob(jobId, { until: Status.Claimed, intervalMs: 10 })).status, Status.Claimed);
  assert.equal((await app.watchJob(jobId, { until: [Status.Finalizable, Status.Claimed], intervalMs: 10 })).status, Status.Claimed);
  await assert.rejects(app.watchJob(jobId, { intervalMs: 10, timeoutMs: 60 }), /still claimed after 60 ms/);
  const ctl = new AbortController();
  const aborted = app.watchJob(jobId, { intervalMs: 10, signal: ctl.signal });
  setTimeout(() => ctl.abort(new Error('stop')), 50);
  await assert.rejects(aborted, /stop/);
  await advance(WINDOW + 1);
  await app.finalize(jobId);
  assert.equal((await app.watchJob(jobId, { intervalMs: 10 })).status, Status.Finalized, 'returns at once for a final job');
  assert.equal((await app.watchJob(jobId, { until: Status.Challenged, intervalMs: 10 })).status, Status.Finalized, 'a final job ends any watch: nothing more will change');
});

test('finalize pays the operator and refuses early', async () => {
  const { jobId, bond } = await postPop();
  await operatorFor(operator, jobId).tick();
  await assert.rejects(app.finalize(jobId), /CALL_EXCEPTION|window/); // the window is still open
  assert.equal((await app.getJob(jobId)).finalized, false);
  await advance(WINDOW + 1);
  const before = await provider.getBalance(await addr(operator));
  const { txHash, receipt } = await app.finalize(jobId);
  assert.equal(receipt.hash, txHash);
  const cut = (FEE * BigInt(FEE_BPS)) / 10_000n;
  assert.equal((await provider.getBalance(await addr(operator))) - before, bond + FEE - cut, 'bond back plus fee less the protocol share');
});

test('getResult throws until the job is final, then returns the bits and the packed result', async () => {
  const { jobId } = await postPop([1, 1, 1, 1, 0, 0, 0, 1]);
  await assert.rejects(app.getResult(jobId), (e) => e instanceof NotFinalizedError && e.status === Status.Unclaimed && e.jobId === jobId);
  await operatorFor(operator, jobId).tick();
  await assert.rejects(reader.getResult(jobId), (e) => e instanceof NotFinalizedError && e.status === Status.Claimed);
  await advance(WINDOW + 1);
  await assert.rejects(app.getResult(jobId), (e) => e instanceof NotFinalizedError && e.status === Status.Finalizable);
  await app.finalize(jobId);
  const r = await reader.getResult(jobId);
  assert.equal(r.jobId, jobId);
  assert.deepEqual(r.outputs, [1, 0, 1, 0]); // popcount 5
  assert.deepEqual(r.newState, []);
  assert.equal(r.outputsHex, bytesToHex(pack([1, 0, 1, 0])));
  assert.equal(r.claimant, await addr(operator));
  assert.equal(r.verified, undefined, 'not recomputed unless asked');
  assert.equal((await app.getResult(jobId, { verify: true })).verified, true);
});

test('a multi-beat stateful job: post, claim, finalize, read, and it matches beat-by-beat evaluation', async () => {
  const beats = 9, inputs = [1], state = [1, 1];
  const { jobId } = await app.postJob({ processor: stack.processor, circuitId: refState, beats, inputs, state, fee: FEE });
  await operatorFor(operator, jobId).tick();
  await advance(WINDOW + 1);
  await app.finalize(jobId);
  let st = state, outs;
  for (let b = 0; b < beats; b++) [st, outs] = beat(stateful, st, inputs);
  const r = await app.getResult(jobId, { verify: true });
  assert.deepEqual(r.outputs, outs);
  assert.deepEqual(r.newState, st);
  assert.equal(r.verified, true);
});

test('runLocally: matches beat-by-beat evaluation and the trace root an honest claim commits to', async () => {
  const beats = 6, inputs = [1, 0, 1, 1, 0, 1], state = [0, 1];
  const local = await app.runLocally({ processor: stack.processor, circuitId: refState, beats, inputs, state });
  let st = state, outs;
  for (let b = 0; b < beats; b++) [st, outs] = beat(stateful, st, [inputs[b]]);
  assert.deepEqual(local.outputs, outs);
  assert.deepEqual(local.newState, st);
  assert.equal(local.outputsHex, bytesToHex(pack(outs)));
  const t = traceJob(stateful, { state, inputs, beats, perBeat: true });
  assert.equal(local.traceRoot, new Tree(t.leaves).root);
  assert.equal(local.leaves, t.n);

  // the same job, posted: runLocally({ jobId }) runs it exactly as posted and an operator claims the same root
  const { jobId } = await app.postJob({ processor: stack.processor, circuitId: refState, beats, inputs, state });
  const posted = await reader.runLocally({ jobId });
  assert.deepEqual(posted, local);
  await operatorFor(operator, jobId).tick();
  assert.equal((await app.getJob(jobId)).traceRoot, local.traceRoot);
});

test('runLocally: one beat\'s inputs repeat every beat; combinational circuits work; bad arguments are refused', async () => {
  const pop = await app.runLocally({ processor: stack.processor, circuitId: stack.circuits.popcount, inputs: [1, 1, 1, 0, 0, 0, 0, 0] });
  assert.deepEqual(pop.outputs, [1, 1, 0, 0]); // popcount 3
  const rep = await app.runLocally({ processor: stack.processor, circuitId: refState, beats: 4, inputs: [1], state: [0, 0] });
  let st = [0, 0], outs;
  for (let b = 0; b < 4; b++) [st, outs] = beat(stateful, st, [1]);
  assert.deepEqual(rep.outputs, outs);
  assert.deepEqual(rep.newState, st);
  await assert.rejects(app.runLocally({}), /processor, circuitId/);
  await assert.rejects(app.runLocally({ processor: stack.processor, circuitId: stack.circuits.popcount, inputs: new Array(12).fill(1), perBeat: false }), /takes 8/);
});

test('verifyClaim: an honest claim is honest', async () => {
  const { jobId } = await postPop();
  assert.deepEqual(await app.verifyClaim(jobId), { jobId, verdict: 'no-claim', reason: 'nobody has claimed this job' });
  await operatorFor(operator, jobId).tick();
  const v = await app.verifyClaim(jobId);
  assert.equal(v.verdict, 'honest');
  assert.equal(v.reason, null);
  assert.equal(v.claimant, await addr(operator));
  assert.equal(v.claimedRoot, v.computedRoot);
  assert.deepEqual(v.computed.outputs, [0, 1, 1, 0]);
});

test('verifyClaim: a corrupted gate (trace root differs) is cheating, at an input, a NAND, and a LATCH read', async () => {
  const { jobId: j1 } = await postPop([1, 1, 1, 1, 0, 0, 0, 1]);
  await operatorFor(operator, j1, { lie: () => 2 + 8 + 20 }).tick();
  const v1 = await app.verifyClaim(j1);
  assert.equal(v1.verdict, 'cheating');
  assert.match(v1.reason, /trace root differs/);
  assert.notEqual(v1.claimedRoot, v1.computedRoot);
  // the right answer comes back with the verdict
  assert.deepEqual(v1.computed.outputs, [1, 0, 1, 0]);

  const { jobId: j2 } = await postPop();
  await operatorFor(other, j2, { lie: () => 5 }).tick(); // an input leaf
  assert.equal((await app.verifyClaim(j2)).verdict, 'cheating');

  const beats = 4;
  const { jobId: j3 } = await app.postJob({ processor: stack.processor, circuitId: refState, beats, inputs: [1], state: [0, 1], fee: FEE });
  const t = traceJob(stateful, { state: [0, 1], inputs: [1], beats });
  await operatorFor(operator, j3, { lie: () => t.B + t.F + 1 }).tick(); // a state leaf of beat 1
  assert.equal((await app.verifyClaim(j3)).verdict, 'cheating');
});

test('verifyClaim: the right trace with a wrong result is cheating too', async () => {
  const { jobId, bond } = await postPop([1, 1, 1, 1, 1, 1, 1, 1]);
  const { traceRoot, outputs: honest } = await app.runLocally({ jobId });
  const lie = honest.map((b, i) => (i === 0 ? b ^ 1 : b));
  await (await full.connect(operator).claim(jobId, traceRoot, bytesToHex(pack(lie)), '0x', { value: bond })).wait();
  const v = await app.verifyClaim(jobId);
  assert.equal(v.verdict, 'cheating');
  assert.match(v.reason, /result bit 0 differs/);
  assert.equal(v.claimedRoot, v.computedRoot, 'the trace itself is fine');
});

test('a cheat that is disputed and overturned never becomes the result: the honest claim does', async () => {
  const { jobId } = await postPop([0, 1, 0, 1, 1, 0, 0, 0]);
  let lied = false;
  const cheat = operatorFor(operator, jobId, { lie: () => (lied ? null : ((lied = true), 2 + 8 + 12)) });
  const watch = new Challenger({ oc: full, signer: other, name: 'watcher' });
  watch.only = new Set([Number(jobId)]);
  await cheat.tick();
  assert.equal((await app.verifyClaim(jobId)).verdict, 'cheating');
  let overturned = false;
  for (let i = 0; i < 60 && !overturned; i++) {
    await watch.tick();
    await cheat.tick();
    overturned = (await app.getJob(jobId)).status === Status.Unclaimed;
  }
  assert.ok(overturned, 'the watcher proved the wrong step and the job reopened');
  await assert.rejects(app.getResult(jobId), NotFinalizedError);
  await operatorFor(poster, jobId).tick(); // an honest claim
  assert.equal((await app.verifyClaim(jobId)).verdict, 'honest');
  await advance(WINDOW + 1);
  await app.finalize(jobId);
  assert.deepEqual((await app.getResult(jobId, { verify: true })).outputs, [1, 1, 0, 0]); // popcount of 0,1,0,1,1,0,0,0 is 3
});

// ---------------------------------------------------------------- end to end: the example script

const run = promisify(execFile);
const EXAMPLE = new URL('../packages/overclock-js/examples/post-and-read.js', import.meta.url).pathname;
let node;
after(async () => {
  await node?.close();
});

test('e2e: examples/post-and-read.js posts, gets an honest claim finalized, reads the result, and flags a cheat', async () => {
  node = ganache.server({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, wallet: { totalAccounts: 4, defaultBalance: 1000 } });
  await node.listen(0);
  const RPC_URL = `http://127.0.0.1:${node.address().port}`;
  const { stdout } = await run(process.execPath, [EXAMPLE], { env: { ...process.env, RPC_URL, CHEAT: '1' }, timeout: 120_000 });
  console.log(stdout.split('\n').map((l) => `    | ${l}`).join('\n'));
  const lines = stdout.trim().split('\n');
  assert.match(lines[0], /^posted job 0: fee 0\.01, an operator must bond 1\.01$/);
  assert.ok(lines.includes('runLocally says: [0,1,1,0]'));
  assert.ok(lines.includes('status: claimed'));
  assert.ok(lines.includes('verifyClaim: honest'));
  assert.ok(lines.includes('status: finalized'));
  assert.ok(lines.some((l) => l.startsWith('result: [0,1,1,0]')));
  assert.ok(lines.some((l) => /^verifyClaim on job 1: cheating \(trace root differs/.test(l)));
  // it is repeatable and the honest-only run (no CHEAT) works on a fresh node too
  const again = await run(process.execPath, [EXAMPLE], { env: { ...process.env, RPC_URL }, timeout: 120_000 });
  assert.ok(again.stdout.includes('result: [0,1,1,0]'));
  assert.ok(!again.stdout.includes('cheating'));
  // and refuses to run without a node
  await assert.rejects(run(process.execPath, [EXAMPLE], { env: { ...process.env, RPC_URL: '' } }), (e) => /Set RPC_URL/.test(e.stderr));
});
