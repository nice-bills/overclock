// The MCP server end to end: a real MCP client spawns bin/overclock-mcp.js over stdio against a
// local chain with the TapeOut stand-in, posts and claims a job through tools, finalizes it, and
// catches a cheating operator through challenge_claim.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import { JsonRpcProvider, Wallet, ContractFactory, parseEther } from 'ethers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { load, pack, unpack, hexToBytes, bytesToHex } from '../src/tap02.js';
import { layout, flatSize } from '../src/trace.js';
import { cellCircuit, boardCircuit, lifeStep, board, PATTERNS } from '../src/life.js';
import { artifact } from '../src/chain.js';
import { createCPU, mint, burnCost, tapeout } from '../src/tapeout.js';
import { Operator } from '../src/agents.js';

const W = 6, H = 6, WINDOW = 3600;
let server, provider, factoryAddr, keys, oc, cpuAddr, cellId, boardId, bdC, cellC, client, start;

const call = async (name, args = {}) => {
  const t0 = Date.now();
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  if (process.env.MCP_DEBUG) console.error(name, Date.now() - t0, 'ms');
  const text = r.content[0].text;
  if (r.isError) throw new Error(`${name}: ${text}`);
  return JSON.parse(text);
};

before(async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  server = ganache.server({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, wallet: { deterministic: true, totalAccounts: 4, defaultBalance: 1000 } });
  await server.listen(port);
  keys = Object.values(server.provider.getInitialAccounts()).map((a) => a.secretKey);
  const url = `http://127.0.0.1:${port}`;
  provider = new JsonRpcProvider(url, undefined, { cacheTimeout: -1 });
  const owner = new Wallet(keys[0], provider);
  const deploy = async (name, ...args) => {
    const a = artifact(name);
    const c = await new ContractFactory(a.abi, a.bytecode, owner).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const factory = await deploy('TapeOutFactoryLocal');
  factoryAddr = await factory.getAddress();
  const cpu = await createCPU(owner, await factory.getAddress(), { name: 'Test', symbol: 'T', story: '', supply: 100000, mintPrice: parseEther('0.00001') });
  cpuAddr = (await cpu.circuits.getAddress()).toLowerCase();
  const cell = cellCircuit(), bd = boardCircuit(W, H, cpuAddr, 1);
  await mint(cpu.transistors, 0, burnCost(cell.netlist, 9).nand);
  await mint(cpu.transistors, 1, W * H);
  cellId = Number((await tapeout(cpu.circuits, cell)).id);
  boardId = Number((await tapeout(cpu.circuits, bd)).id);
  cellC = load(cell.netlist, 9, 1);
  bdC = load(bd.netlist, 0, W * H, () => cellC);
  oc = await deploy('Overclock', parseEther('1'), WINDOW, await factory.getAddress(), owner.address, 200);
  start = board(W, H, [[PATTERNS.glider, 0, 0]]);

  client = new Client({ name: 'overclock-test', version: '1.0.0' });
  await client.connect(new StdioClientTransport({
    command: process.execPath,
    args: [new URL('../bin/overclock-mcp.js', import.meta.url).pathname],
    env: { ...process.env, RPC_URL: url, OVERCLOCK: await oc.getAddress(), PRIVATE_KEY: keys[1], FACTORY: factoryAddr },
    stderr: process.env.MCP_DEBUG ? 'inherit' : 'ignore',
  }));
});

after(async () => {
  await client?.close();
  await server?.close();
});

test('lists read and write tools when a wallet is configured', async () => {
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ['overclock_info', 'list_jobs', 'get_job', 'describe_circuit', 'run_locally', 'verify_claim', 'post_job', 'claim_job', 'challenge_claim', 'finalize_job', 'tapeout_circuit'])
    assert.ok(names.includes(n), n);
  const info = await call('overclock_info');
  assert.equal(info.bond, '1.0');
  assert.equal(info.challengeWindowSeconds, WINDOW);
  assert.equal(info.wallet.address, new Wallet(keys[1]).address);
});

test('describes a taped-out circuit and runs it locally', async () => {
  const d = await call('describe_circuit', { processor: cpuAddr, circuitId: boardId });
  assert.equal(d.nState, W * H);
  assert.equal(d.gatesFlattened, W * H * cellC.nGates + W * H);
  assert.deepEqual(d.refs, [`${cpuAddr}#${cellId}`]);
  const r = await call('run_locally', { processor: cpuAddr, circuitId: boardId, beats: 4, state: bytesToHex(pack(start)) });
  let ref = start;
  for (let g = 0; g < 4; g++) ref = lifeStep(ref, W, H);
  assert.deepEqual(unpack(hexToBytes(r.finalState.hex), W * H), ref);
});

test('creates a processor and tapes out circuits through tools, minting the transistors it burns', async () => {
  const { processor } = await call('create_processor', { name: 'Agent CPU', symbol: 'AGT' });
  const { cell } = await call('life_circuits', {});
  const t = await call('tapeout_circuit', { processor, netlist: cell.netlist, nIn: cell.nIn, nOut: cell.nOut });
  assert.equal(t.circuitId, 1);
  assert.equal(t.gatesFlattened, cellC.nGates);
  assert.equal(t.minted.nand, t.burned.nand);
  const { board: bd } = await call('life_circuits', { w: 4, h: 4, processor, cellId: 1 });
  const b = await call('tapeout_circuit', { processor, netlist: bd.netlist, nIn: bd.nIn, nOut: bd.nOut });
  assert.equal(b.nState, 16);
  assert.deepEqual((await call('describe_circuit', { processor, circuitId: b.circuitId })).refs, [`${processor.toLowerCase()}#1`]);
});

test('post, claim, verify and finalize a job through tools', async () => {
  const { jobId } = await call('post_job', { processor: cpuAddr, circuitId: boardId, beats: 6, state: bytesToHex(pack(start)), fee: '0.05' });
  assert.equal((await call('get_job', { jobId })).status, 'open');
  const c = await call('claim_job', { jobId });
  assert.equal(c.claimant, new Wallet(keys[1]).address);
  assert.equal((await call('verify_claim', { jobId })).verdict, 'correct');
  await assert.rejects(call('finalize_job', { jobId })); // too early, and a failed send must not break the next one
  await provider.send('evm_increaseTime', [WINDOW + 1]);
  await provider.send('evm_mine', []);
  assert.equal((await call('list_jobs', { status: 'ready to finalize' })).jobs[0].jobId, jobId);
  const f = await call('finalize_job', { jobId });
  let ref = start;
  for (let g = 0; g < 6; g++) ref = lifeStep(ref, W, H);
  assert.deepEqual(unpack(hexToBytes(f.finalState), W * H), ref);
});

test('challenge_claim catches a cheat down to one gate and takes the bond', async () => {
  const BEATS = 5;
  const { jobId } = await call('post_job', { processor: cpuAddr, circuitId: boardId, beats: BEATS, state: bytesToHex(pack(start)), fee: '0.05' });
  const L = layout(bdC, BEATS);
  const leaf = 2 * L.B + 2 + bdC.nState + 7 * (flatSize(cellC) + 1) + flatSize(cellC) - 1; // one cell rule's last NAND, beat 2
  const cheatSigner = new Wallet(keys[2], provider);
  const cheat = new Operator({ oc, signer: cheatSigner, name: 'cheat', lie: (j) => (Number(j.jobId) === jobId ? leaf : null) });
  cheat.only = new Set([jobId]);
  await cheat.tick();
  assert.match((await call('verify_claim', { jobId })).verdict, /^wrong/);

  const me = new Wallet(keys[1]).address;
  const before = await provider.getBalance(me);
  let stop = false;
  const loop = (async () => { while (!stop) { await cheat.tick(); await new Promise((r) => setTimeout(r, 300)); } })();
  let res = await call('challenge_claim', { jobId, waitSeconds: 120 });
  const actions = [...res.actions];
  for (let i = 0; i < 5 && res.openDisputes.length; i++) {
    res = await call('advance_disputes', { waitSeconds: 120 });
    actions.push(...res.actions);
  }
  stop = true;
  await loop;
  assert.equal(res.openDisputes.length, 0);
  assert.ok(actions.some((a) => a.fn === 'resolveLeaf'), 'proved the wrong step');
  const j = await call('get_job', { jobId });
  assert.equal(j.status, 'open', 'the wrong claim was thrown out and the job reopened');
  assert.ok((await provider.getBalance(me)) > before, 'the challenger won the cheat\'s bond');
});

test('HTTP mode serves the same tools to remote agents, read-only without a key', async () => {
  const { spawn } = await import('node:child_process');
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
  const port = 40000 + Math.floor(Math.random() * 20000);
  const env = { ...process.env, RPC_URL: provider._getConnection().url, OVERCLOCK: await oc.getAddress() };
  delete env.PRIVATE_KEY;
  const child = spawn(process.execPath, [new URL('../bin/overclock-mcp.js', import.meta.url).pathname, '--http', '--port', String(port)], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  try {
    await new Promise((ok, bad) => { child.stderr.on('data', (d) => String(d).includes('/mcp') && ok()); child.on('exit', bad); });
    const remote = new Client({ name: 'remote', version: '1.0.0' });
    await remote.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`)));
    const names = (await remote.listTools()).tools.map((t) => t.name);
    assert.ok(names.includes('verify_claim'));
    assert.ok(!names.includes('post_job'), 'no wallet, no transaction tools');
    const r = await remote.callTool({ name: 'overclock_info', arguments: {} });
    const info = JSON.parse(r.content[0].text);
    assert.equal(info.overclock, await oc.getAddress());
    assert.match(info.wallet, /read-only/);
    await remote.close();
  } finally {
    child.kill();
  }
});
