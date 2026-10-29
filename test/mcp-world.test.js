// Overclock World through the MCP server: an agent reads the board, forecasts a move for free, buys cells,
// moves the world on, and after the season collects its winnings, all through tools. The server signs with
// OVERCLOCK_PRIVATE_KEY here; the approval-page flow is covered in test/mcp.test.js.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import { JsonRpcProvider, Wallet, ContractFactory, parseEther } from 'ethers';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { load, pack, unpack, hexToBytes, bytesToHex } from '../src/tap02.js';
import { traceJob, buildTree } from '../src/trace.js';
import { artifact } from '../src/chain.js';
import { colourCellCircuit, worldCircuit, worldStep, fromWorldState } from '../src/world.js';

const W = 16, H = 16, BEATS = 3, WINDOW = 60, BOND = parseEther('0.01'), PRICE = parseEther('0.001');
let server, provider, keys, client, oc, world, worldC;

const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args }, undefined, { timeout: 600000 });
  if (r.isError) throw new Error(`${name}: ${r.content[0].text}`);
  return JSON.parse(r.content[0].text);
};
const deploy = async (name, signer, ...args) => {
  const c = await new ContractFactory(artifact(name).abi, artifact(name).bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
};

before(async () => {
  const port = 20000 + Math.floor(Math.random() * 20000);
  server = ganache.server({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, wallet: { deterministic: true, totalAccounts: 3, defaultBalance: 1000 } });
  await server.listen(port);
  keys = Object.values(server.provider.getInitialAccounts()).map((a) => a.secretKey);
  const url = `http://127.0.0.1:${port}`;
  provider = new JsonRpcProvider(url, undefined, { cacheTimeout: -1 });
  const owner = new Wallet(keys[0], provider);
  const cpu = await deploy('MockProcessor', owner);
  const cpuAddr = (await cpu.getAddress()).toLowerCase();
  const cell = colourCellCircuit();
  const cc = load(cell.netlist, cell.nIn, cell.nOut);
  const cellId = Number(await cpu.nextId());
  await (await cpu.store(bytesToHex(cell.netlist), cell.nIn, cell.nOut, 0, cc.nGates)).wait();
  const wd = worldCircuit(W, H, cpuAddr, cellId);
  worldC = load(wd.netlist, wd.nIn, wd.nOut, (a, i) => (a.toLowerCase() === cpuAddr && Number(i) === cellId ? cc : null));
  const worldId = Number(await cpu.nextId());
  await (await cpu.store(bytesToHex(wd.netlist), wd.nIn, wd.nOut, worldC.nState, worldC.nGates)).wait();
  oc = await deploy('Overclock', owner, BOND, WINDOW, '0x0000000000000000000000000000000000000000', owner.address, 0);
  world = await deploy('World', owner, await oc.getAddress(), cpuAddr, worldId, BEATS, 1, PRICE, parseEther('0.001'), parseEther('0.0001'), '0x0000000000000000000000000000000000000000');
  await (await world.fund({ value: parseEther('0.01') })).wait();

  client = new Client({ name: 'test', version: '1' });
  await client.connect(new StdioClientTransport({
    command: process.execPath, args: ['bin/overclock-mcp.js', '--no-open'], cwd: new URL('..', import.meta.url).pathname, stderr: 'ignore',
    env: { ...process.env, RPC_URL: url, OVERCLOCK: await oc.getAddress(), WORLD: await world.getAddress(), OVERCLOCK_PRIVATE_KEY: keys[1] },
  }));
});

after(async () => { await client?.close(); await server?.close(); });

test('world tools: look, forecast, buy, move on, win and claim', async () => {
  const { tools } = await client.listTools();
  for (const t of ['world_status', 'world_forecast', 'world_place', 'world_advance', 'world_claim']) assert.ok(tools.some((x) => x.name === t), t);

  let s = await call('world_status');
  assert.deepEqual(s.score, { red: 0, blue: 0 });
  assert.equal(s.season, 1);
  assert.equal(s.board.split('\n').length, 16);
  assert.equal(s.canMoveOn, false);

  // a block is stable, so the forecast keeps all 4 cells
  const f = await call('world_forecast', { team: 'red', cells: [[4, 4], [5, 4], [4, 5], [5, 5]] });
  assert.deepEqual(f.tried, { team: 'red', cells: 4, cost: '0.004' });
  assert.deepEqual(f.after.score, { red: 4, blue: 0 });

  const p = await call('world_place', { team: 'red', cells: [[4, 4], [5, 4], [4, 5], [5, 5]] });
  assert.equal(p.paid, '0.004');
  await assert.rejects(call('world_place', { team: 'blue', cells: [[4, 4]] }), /Already bought/);
  await assert.rejects(call('world_place', { team: 'blue', pattern: 'glider', x: 9, y: 9 }), /one team a season/); // same wallet, other team
  s = await call('world_status');
  assert.equal(s.boughtForNextEpoch.cells, 4);
  assert.equal(s.you.team, 'red');
  assert.equal(s.canMoveOn, true);

  const a = await call('world_advance');
  assert.equal(typeof a.jobId, 'number');
  s = await call('world_status');
  assert.equal(s.epoch.jobId, a.jobId);
  assert.equal(s.epoch.status, 'open');

  // an operator settles the epoch
  const op = new Wallet(keys[2], provider);
  const j = await oc.jobs(a.jobId);
  const t = traceJob(worldC, { state: unpack(hexToBytes(j.state), 2 * W * H), beats: BEATS });
  await (await oc.connect(op).claim(a.jobId, buildTree(t.leaves).root, bytesToHex(pack(t.outputs)), bytesToHex(pack(t.newState)), { value: BOND })).wait();
  await provider.send('evm_increaseTime', [WINDOW + 1]);
  await provider.send('evm_mine', []);
  await (await oc.connect(op).finalize(a.jobId, { gasLimit: 3_000_000 })).wait();
  let ref = new Array(W * H).fill(0);
  for (const k of [4 * 16 + 4, 4 * 16 + 5, 5 * 16 + 4, 5 * 16 + 5]) ref[k] = 1;
  for (let g = 0; g < BEATS; g++) ref = worldStep(ref, W, H);
  assert.deepEqual(fromWorldState(t.newState), ref);
  s = await call('world_status');
  assert.equal(s.epoch.status, 'final');
  assert.equal(s.canMoveOn, true);

  // the season is one epoch: moving on ends it, red wins, and the agent claims the pot
  const end = await call('world_advance');
  assert.deepEqual({ ...end.seasonEnded, announcedOverTapeSend: undefined }, { season: 1, winner: 'red', red: 4, blue: 0, pot: '0.002', announcedOverTapeSend: undefined });
  s = await call('world_status');
  assert.equal(s.season, 2);
  assert.deepEqual(s.pastSeasons[0], { season: 1, winner: 'red', red: 4, blue: 0, pot: '0.002' });
  const c = await call('world_claim', { season: 1 });
  assert.equal(c.paid, '0.002');
  await assert.rejects(call('world_claim', { season: 1 }));
});
