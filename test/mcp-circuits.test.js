// The four circuit tools (find_my_circuits, run_circuit, certify, get_certificate), in process: a real
// MCP client talks to createServer() over an in-memory transport, against a local v2 stack holding the
// real GC-094 / miner #2346 netlists (test/helpers/circuits-stack.js). The stdio, wallet-bridge version
// of the same flow is mcp-circuits-e2e.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Wallet, Contract } from 'ethers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createServer } from '../src/mcp.js';
import { fixtureSource, MINER_PROCESSOR } from '../src/certify.js';
import { load, beat, pack, hexToBytes, bytesToHex } from '../src/tap02.js';
import { startStack } from './helpers/circuits-stack.js';
import { GC094 } from './fixtures/gc094.js';

let stack, client, readOnlyClient, clients = [];

async function connect(ctx) {
  const [a, b] = InMemoryTransport.createLinkedPair();
  await createServer(ctx).connect(a);
  const c = new Client({ name: 'circuits-test', version: '1.0.0' });
  await c.connect(b);
  clients.push(c);
  return c;
}
const call = async (c, name, args = {}) => {
  const r = await c.callTool({ name, arguments: args }, undefined, { timeout: 120000 });
  const text = r.content[0].text;
  if (r.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};
const fails = async (c, name, args, re) => assert.rejects(call(c, name, args), re);

before(async () => {
  stack = await startStack();
  const base = { provider: stack.provider, overclock: stack.overclock, processors: [stack.processor], certificationSource: fixtureSource({ provider: stack.provider, fixture: stack.fixture }) };
  client = await connect({ ...base, signer: new Wallet(stack.keys[1], stack.provider) });
  readOnlyClient = await connect({ ...base, readOnly: true });
});

after(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await stack?.close();
});

test('all four circuit tools are listed, on a read-only server too', async () => {
  for (const c of [client, readOnlyClient]) {
    const names = (await c.listTools()).tools.map((t) => t.name);
    for (const n of ['find_my_circuits', 'run_circuit', 'certify', 'get_certificate']) assert.ok(names.includes(n), n);
  }
});

test('find_my_circuits lists the circuits an address owns, and nothing for anyone else', async () => {
  const want = Object.values(stack.ids).sort((a, b) => a - b);
  // by default it searches the server's processors; or one you name
  for (const args of [{ address: stack.owner.address }, { address: stack.owner.address.toLowerCase(), processor: stack.processor }]) {
    const r = await call(client, 'find_my_circuits', args);
    assert.equal(r.count, want.length);
    assert.deepEqual(r.circuits.map((x) => x.id), want);
    assert.ok(r.circuits.every((x) => x.processor === stack.processor && Array.isArray(x.runs) && x.certificate === null));
  }
  const none = await call(client, 'find_my_circuits', { address: new Wallet(stack.keys[2]).address });
  assert.deepEqual(none, { owner: new Wallet(stack.keys[2]).address, count: 0, circuits: [] });
  // a processor that is not a contract here (the default mainnet machines, say) is skipped, not an error
  const odd = await connect({ provider: stack.provider, overclock: stack.overclock, processors: ['0x' + '12'.repeat(20), stack.processor] });
  assert.equal((await call(odd, 'find_my_circuits', { address: stack.owner.address })).count, want.length);
  await fails(client, 'find_my_circuits', { address: stack.owner.address, processor: '0x' + '12'.repeat(20) }, /no contract at/);
});

test('find_my_circuits follows a transferred circuit to its new owner', async () => {
  const other = new Wallet(stack.keys[3]).address;
  const circuits = new Contract(stack.processor, ['function transferFrom(address,address,uint256)'], stack.owner);
  await (await circuits.transferFrom(stack.owner.address, other, stack.ids.stranger)).wait();
  assert.deepEqual((await call(client, 'find_my_circuits', { address: other })).circuits.map((x) => x.id), [stack.ids.stranger]);
  assert.ok(!(await call(client, 'find_my_circuits', { address: stack.owner.address })).circuits.some((x) => x.id === stack.ids.stranger));
});

test('run_circuit runs a circuit locally, for free, and matches an independent replay', async () => {
  const jobs = Number(await stack.oc.jobCount());
  const signerAddress = new Wallet(stack.keys[1]).address;
  const funds = await stack.provider.getBalance(signerAddress);
  const r = await call(client, 'run_circuit', { processor: stack.processor, id: stack.ids.design, beats: 3 });
  // independent replay straight from the netlist in the test data
  const c = load(hexToBytes(GC094.design.netlist), GC094.design.nIn, GC094.design.nOut);
  let state = new Array(c.nState).fill(0), out;
  for (let i = 0; i < 3; i++) [state, out] = beat(c, state, new Array(c.nIn).fill(0));
  assert.equal(r.outputs, bytesToHex(pack(out)));
  assert.equal(r.finalState, bytesToHex(pack(state)));
  assert.match(r.traceRoot, /^0x[0-9a-f]{64}$/);
  // the same trace root run_locally reports for the same circuit
  const rl = await call(client, 'run_locally', { processor: stack.processor, circuitId: stack.ids.design, beats: 3 });
  assert.equal(r.traceRoot, rl.traceRoot);
  assert.equal(Number(await stack.oc.jobCount()), jobs, 'a local run posts nothing');
  assert.equal(await stack.provider.getBalance(signerAddress), funds);
  // inputs and a starting state are honoured
  const withInput = await call(client, 'run_circuit', { processor: stack.processor, id: stack.ids.design, beats: 1, inputs: '0x03' });
  const [, out1] = beat(c, new Array(c.nState).fill(0), [1, 1]);
  assert.equal(withInput.outputs, bytesToHex(pack(out1)));
});

test('run_circuit post=true posts through the same path as post_job', async () => {
  const before_ = Number(await stack.oc.jobCount());
  const args = { processor: stack.processor, id: stack.ids.design, beats: 2 };
  const via = await call(client, 'run_circuit', { ...args, post: true, fee: '0.01' });
  assert.equal(via.posted.jobId, before_);
  assert.match(via.posted.tx, /^0x[0-9a-f]{64}$/);
  assert.deepEqual(via.local, await call(client, 'run_circuit', args), 'the free local run comes back with the post');
  const direct = await call(client, 'post_job', { processor: stack.processor, circuitId: args.id, beats: 2, fee: '0.01' });
  assert.equal(direct.jobId, before_ + 1);
  // the two jobs are identical on-chain: same circuit, beats, inputs, starting state and fee
  const [a, b] = await Promise.all([stack.oc.jobs(before_), stack.oc.jobs(before_ + 1)]);
  assert.equal(a.cpu.toLowerCase(), stack.processor);
  assert.equal(Number(a.id), stack.ids.design);
  for (const k of ['cpu', 'id', 'beats', 'inputs', 'state', 'fee', 'perBeat']) assert.equal(String(a[k]), String(b[k]), k);
  assert.equal(a.poster, new Wallet(stack.keys[1]).address);
  const job = await call(client, 'get_job', { jobId: via.posted.jobId });
  assert.equal(job.status, 'open');
  assert.equal(job.circuitId, stack.ids.design);
  assert.equal(job.fee, '0.01');
});

test('run_circuit post=true needs a real transaction path: a read-only server refuses and posts nothing', async () => {
  const jobs = Number(await stack.oc.jobCount());
  await fails(readOnlyClient, 'run_circuit', { processor: stack.processor, id: stack.ids.design, beats: 1, post: true }, /read-only/);
  // without post it still runs
  assert.match((await call(readOnlyClient, 'run_circuit', { processor: stack.processor, id: stack.ids.design, beats: 1 })).traceRoot, /^0x/);
  assert.equal(Number(await stack.oc.jobCount()), jobs);
});

test('run_circuit rejects what it cannot run', async () => {
  await fails(client, 'run_circuit', { processor: stack.processor, id: 9999, beats: 1 }, /./);
  await fails(client, 'run_circuit', { processor: stack.processor, id: stack.ids.design, beats: 0 }, /./);
});

test('certify: #2346 fails GC-094 at vector 17, cycle 4, exactly as its saved certificate says', async () => {
  const r = await call(client, 'certify', { processor: stack.processor, id: stack.ids.design });
  const saved = JSON.parse(readFileSync(new URL(`../docs/certificates/${MINER_PROCESSOR.toLowerCase()}-2346.json`, import.meta.url), 'utf8'));
  assert.equal(r.status, 'fail');
  assert.equal(r.challenge, 'GC-094');
  assert.equal(r.taskId, 94);
  assert.deepEqual({ passed: r.passed, failed: r.failed, total: r.total }, { passed: 221, failed: 35, total: 256 });
  assert.deepEqual(r.firstFailure, { index: 17, cycle: 4, input: '0x0302000200', expected: '0x00000000000001000004', got: '10000000000' });
  // the saved certificate agrees on every number
  assert.equal(saved.verdict, 'failed');
  assert.deepEqual({ passed: saved.officialVectors.passed, failed: saved.officialVectors.failed, total: saved.officialVectors.total }, { passed: r.passed, failed: r.failed, total: r.total });
  assert.deepEqual(saved.officialVectors.firstFailure, r.firstFailure);
});

test('certify: a miner that matches the reference passes; a constant reference is unsound; strangers are refused', async () => {
  const good = await call(client, 'certify', { processor: stack.processor, id: stack.ids.good });
  assert.equal(good.status, 'pass');
  assert.deepEqual({ passed: good.passed, failed: good.failed, total: good.total }, { passed: 256, failed: 0, total: 256 });
  assert.equal(good.firstFailure, undefined);

  const unsound = await call(client, 'certify', { processor: stack.processor, id: stack.ids.zeroDesign });
  assert.equal(unsound.status, 'unsound-reference', 'a pass against a constant reference proves nothing');
  assert.equal(unsound.challenge, 'GC-098');
  assert.match(unsound.finding, /constant output/);

  const stranger = await call(client, 'certify', { processor: stack.processor, id: stack.ids.stranger });
  assert.equal(stranger.status, 'not-a-fabx-miner');
});

test('get_certificate reads the saved certificates, and says so when there is none', async () => {
  const c = await call(client, 'get_certificate', { processor: MINER_PROCESSOR, id: 2346 });
  assert.equal(c.verdict, 'failed');
  assert.equal(c.challenge, 'GC-094 双拍位周期8位同步UART接收器');
  assert.equal(c.taskId, 94);
  assert.equal(c.officialVectors.failed, 35);
  assert.equal(c.officialVectors.firstFailure.index, 17);
  assert.equal(c.officialVectors.firstFailure.cycle, 4);
  assert.match(c.document, /^docs\/certificates\/0x87bfca3494aa228ff589ab9b642143a5e8c8f9a6-2346\.json$/);
  assert.equal((await call(client, 'get_certificate', { processor: MINER_PROCESSOR, id: 1648 })).verdict, 'certified');
  assert.equal((await call(client, 'get_certificate', { processor: MINER_PROCESSOR, id: 310 })).verdict, 'unsound-reference');
  const none = await call(client, 'get_certificate', { processor: stack.processor, id: stack.ids.design });
  assert.equal(none.status, 'not certified');
});
