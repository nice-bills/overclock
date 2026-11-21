// End to end, as a user's agent would drive it: bin/overclock-mcp.js over stdio, a real MCP client,
// a local chain with a deployed v2 stack (the 8-argument Overclock constructor) and the real GC-094
// miner data. No private key reaches the server: run_circuit(post=true) hands back an approval link
// and a stand-in for the user's wallet page approves it through the bridge, as in mcp.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Wallet } from 'ethers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { load, beat, pack, hexToBytes, bytesToHex } from '../src/tap02.js';
import { startStack } from './helpers/circuits-stack.js';
import { GC094 } from './fixtures/gc094.js';

let stack, client, dir, page, me;

// Plays the approval page and the user's wallet: connects `address`, then approves (or rejects) every request.
function fakePage(url, address) {
  const p = { mode: 'approve', stop: false, seen: [] };
  const post = (path, body) => fetch(url + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  p.loop = (async () => {
    await post('/connect', { address, wallet: 'Test Wallet' });
    while (!p.stop) {
      const s = await (await fetch(url + '/state')).json();
      for (const r of s.pending) {
        p.seen.push(r);
        await post('/picked', { id: r.id });
        if (p.mode === 'reject') { await post('/result', { id: r.id, error: 'User rejected the request.' }); continue; }
        const tx = { from: r.tx.from, to: r.tx.to, data: r.tx.data, value: r.tx.value, gas: r.tx.gas };
        await post('/result', { id: r.id, hash: await stack.provider.send('eth_sendTransaction', [tx]) });
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  })().catch((e) => { p.error = e; });
  return p;
}

const callRaw = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  const text = r.content[0].text;
  if (r.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};
// follow "waiting for approval" through transaction_status, as a client would
const call = async (name, args = {}) => {
  let r = await callRaw(name, args);
  for (let i = 0; r?.status === 'waiting for approval'; i++) {
    assert.ok(i < 10, `${name} is still waiting for approval`);
    r = await callRaw('transaction_status', { requestId: r.requestId, waitSeconds: 120 });
  }
  return r;
};

before(async () => {
  stack = await startStack();
  dir = mkdtempSync(join(tmpdir(), 'overclock-circuits-e2e-'));
  const fixtureFile = join(dir, 'fabx-fixture.json');
  writeFileSync(fixtureFile, JSON.stringify(stack.fixture));
  me = new Wallet(stack.keys[1]).address;
  client = new Client({ name: 'overclock-e2e', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../bin/overclock-mcp.js', import.meta.url).pathname, '--no-open'],
    env: {
      ...process.env, RPC_URL: stack.url, OVERCLOCK: stack.overclock, FACTORY: stack.factory, PROCESSORS: stack.processor,
      CERTIFY_FIXTURE: fixtureFile, OVERCLOCK_APPROVAL_WAIT_MS: process.env.TEST_APPROVAL_WAIT_MS ?? '2000',
    },
    stderr: process.env.MCP_DEBUG ? 'inherit' : 'ignore',
  }));
});

after(async () => {
  if (page) { page.stop = true; await page.loop; }
  await client?.close();
  await stack?.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
  if (page?.error) throw page.error;
});

test('e2e: the server talks to a v2 stack and lists the four circuit tools', async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ['find_my_circuits', 'run_circuit', 'certify', 'get_certificate', 'post_job']) assert.ok(names.includes(n), n);
  const info = await callRaw('overclock_info');
  assert.equal(info.overclock, stack.overclock);
  assert.equal(info.bondShareOfFeeBps, 5000, 'a v2 contract');
});

test('e2e: find_my_circuits lists what the owner taped out', async () => {
  const r = await callRaw('find_my_circuits', { address: stack.owner.address });
  assert.deepEqual(r.circuits.map((x) => x.id), Object.values(stack.ids).sort((a, b) => a - b));
  assert.ok(r.circuits.every((x) => x.processor === stack.processor));
  assert.equal((await callRaw('find_my_circuits', { address: me })).count, 0);
});

test('e2e: run_circuit runs a circuit for free', async () => {
  const r = await callRaw('run_circuit', { processor: stack.processor, id: stack.ids.design, beats: 3 });
  const c = load(hexToBytes(GC094.design.netlist), GC094.design.nIn, GC094.design.nOut);
  let state = new Array(c.nState).fill(0), out;
  for (let i = 0; i < 3; i++) [state, out] = beat(c, state, new Array(c.nIn).fill(0));
  assert.equal(r.outputs, bytesToHex(pack(out)));
  assert.equal(r.finalState, bytesToHex(pack(state)));
  assert.match(r.traceRoot, /^0x[0-9a-f]{64}$/);
  assert.equal(Number(await stack.oc.jobCount()), 0, 'nothing was posted');
});

test('e2e: run_circuit post=true waits for the wallet, and a rejection posts nothing', async () => {
  const w = await callRaw('run_circuit', { processor: stack.processor, id: stack.ids.design, beats: 2, post: true, fee: '0.01' });
  assert.equal(w.status, 'waiting for approval');
  assert.match(w.approve, /^http:\/\/127\.0\.0\.1:\d+\/wallet\/[0-9a-f]{32}$/);
  page = fakePage(w.approve, me);
  page.mode = 'reject';
  await assert.rejects(callRaw('transaction_status', { requestId: w.requestId, waitSeconds: 60 }), /Wallet: User rejected/);
  assert.match(page.seen.at(-1).label, /^run_circuit · 0\.01 OKB to 0x/);
  assert.equal(Number(await stack.oc.jobCount()), 0);
});

test('e2e: run_circuit post=true, approved through the bridge, posts the job on-chain', async () => {
  page.mode = 'approve';
  const r = await call('run_circuit', { processor: stack.processor, id: stack.ids.design, beats: 2, post: true, fee: '0.01' });
  assert.equal(r.posted.jobId, 0);
  assert.match(r.posted.tx, /^0x[0-9a-f]{64}$/);
  assert.match(r.local.traceRoot, /^0x[0-9a-f]{64}$/);
  const j = await stack.oc.jobs(0);
  assert.equal(j.cpu.toLowerCase(), stack.processor);
  assert.equal(Number(j.id), stack.ids.design);
  assert.equal(Number(j.beats), 2);
  assert.equal(j.poster, me, 'posted from the user\'s wallet, not a key the server holds');
  const job = await callRaw('get_job', { jobId: 0 });
  assert.equal(job.status, 'open');
  assert.equal(job.fee, '0.01');
  // post_job is the same path: a second job is identical but for its id
  const again = await call('post_job', { processor: stack.processor, circuitId: stack.ids.design, beats: 2, fee: '0.01' });
  assert.equal(again.jobId, 1);
  const [a, b] = await Promise.all([stack.oc.jobs(0), stack.oc.jobs(1)]);
  for (const k of ['cpu', 'id', 'beats', 'inputs', 'state', 'fee', 'perBeat', 'poster']) assert.equal(String(a[k]), String(b[k]), k);
});

test('e2e: certify says #2346 fails GC-094 at vector 17, cycle 4; a clean miner passes', async () => {
  const bad = await callRaw('certify', { processor: stack.processor, id: stack.ids.design });
  assert.equal(bad.status, 'fail');
  assert.equal(bad.challenge, 'GC-094');
  assert.deepEqual({ passed: bad.passed, failed: bad.failed, total: bad.total }, { passed: 221, failed: 35, total: 256 });
  assert.equal(bad.firstFailure.index, 17);
  assert.equal(bad.firstFailure.cycle, 4);
  assert.equal(bad.firstFailure.input, '0x0302000200');
  const good = await callRaw('certify', { processor: stack.processor, id: stack.ids.good });
  assert.equal(good.status, 'pass');
  assert.equal(good.passed, 256);
  assert.equal((await callRaw('certify', { processor: stack.processor, id: stack.ids.stranger })).status, 'not-a-fabx-miner');
});

test('e2e: get_certificate returns the saved certificate for a real FabX miner', async () => {
  const c = await callRaw('get_certificate', { processor: '0x87bfca3494aa228ff589ab9b642143a5e8c8f9a6', id: 2346 });
  assert.equal(c.verdict, 'failed');
  assert.equal(c.taskId, 94);
  assert.equal(c.officialVectors.firstFailure.index, 17);
  assert.equal(c.officialVectors.firstFailure.cycle, 4);
  assert.equal((await callRaw('get_certificate', { processor: stack.processor, id: stack.ids.design })).status, 'not certified');
});
