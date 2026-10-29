// Overclock World on a local EVM: buy cells, run epochs as Overclock jobs, end a season, pay the winners.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, parseEther } from 'ethers';
import { load, pack, unpack, hexToBytes, bytesToHex } from '../src/tap02.js';
import { traceJob, buildTree } from '../src/trace.js';
import { colourCellCircuit, worldCircuit, worldStep, toWorldState, fromWorldState } from '../src/world.js';

const art = (n) => JSON.parse(readFileSync(new URL(`../build/${n}.json`, import.meta.url)));
const BOND = parseEther('0.01'), WINDOW = 60, BEATS = 4, EPOCHS = 2;
const PRICE = parseEther('0.01'), JOB_FEE = parseEther('0.001'), TIP = parseEther('0.0001');
const W = 16, H = 16;

let provider, op, red, blue, keeper, oc, world, worldC, cpuAddr, worldId;
const deploy = async (name, signer, ...args) => {
  const c = await new ContractFactory(art(name).abi, art(name).bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
};
const warp = async (s) => { await provider.send('evm_increaseTime', [s]); await provider.send('evm_mine', []); };
const mask = (cells) => cells.reduce((m, [x, y]) => m | (1n << BigInt(y * W + x)), 0n);
const cellsOf = async () => {
  const st = unpack(hexToBytes(await world.state()), 2 * W * H);
  return fromWorldState(st);
};

// What an honest operator does: run the job, claim it, wait out the window, finalize.
async function operate(jobId) {
  const j = await oc.jobs(jobId);
  const t = traceJob(worldC, { state: unpack(hexToBytes(j.state), 2 * W * H), beats: Number(j.beats) });
  await (await oc.connect(op).claim(jobId, buildTree(t.leaves).root, bytesToHex(pack(t.outputs)), bytesToHex(pack(t.newState)), { value: BOND })).wait();
  await warp(WINDOW + 1);
  await (await oc.connect(op).finalize(jobId, { gasLimit: 3_000_000 })).wait();
  return t;
}

before(async () => {
  provider = new BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, wallet: { totalAccounts: 5, defaultBalance: 1000 } }), undefined, { cacheTimeout: -1 });
  [op, red, blue, keeper] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  const cpu = await deploy('MockProcessor', op);
  cpuAddr = (await cpu.getAddress()).toLowerCase();
  const cell = colourCellCircuit();
  const cc = load(cell.netlist, cell.nIn, cell.nOut);
  const cellId = Number(await cpu.nextId());
  await (await cpu.store(bytesToHex(cell.netlist), cell.nIn, cell.nOut, 0, cc.nGates)).wait();
  const wd = worldCircuit(W, H, cpuAddr, cellId);
  worldC = load(wd.netlist, wd.nIn, wd.nOut, (a, i) => (a.toLowerCase() === cpuAddr && Number(i) === cellId ? cc : null));
  worldId = Number(await cpu.nextId());
  await (await cpu.store(bytesToHex(wd.netlist), wd.nIn, wd.nOut, worldC.nState, worldC.nGates)).wait();
  oc = await deploy('Overclock', op, BOND, WINDOW, '0x0000000000000000000000000000000000000000', await op.getAddress(), 0);
  world = await deploy('World', op, await oc.getAddress(), cpuAddr, worldId, BEATS, EPOCHS, PRICE, JOB_FEE, TIP);
});

test('world: a season of Red vs Blue, run by Overclock jobs, pays the winning team', async () => {
  // red: a glider and a block; blue: a blinker that will die off against nothing
  const redCells = [[1, 0], [2, 1], [0, 2], [1, 2], [2, 2], [10, 10], [11, 10], [10, 11], [11, 11]];
  const blueCells = [[6, 5], [6, 6]]; // a domino: dies in one generation
  await (await world.connect(red).place(1, mask(redCells), { value: PRICE * BigInt(redCells.length) })).wait();
  await (await world.connect(blue).place(2, mask(blueCells), { value: PRICE * 2n })).wait();
  await assert.rejects(world.connect(blue).place(1, mask([[3, 3]]), { value: PRICE }));
  await assert.rejects(world.connect(red).place(1, mask([[6, 5]]), { value: PRICE }));
  await assert.rejects(world.connect(red).place(1, mask([[4, 4]]), { value: PRICE * 2n }));

  let ref = new Array(W * H).fill(0);
  for (const [x, y] of redCells) ref[y * W + x] = 1;
  for (const [x, y] of blueCells) ref[y * W + x] = 2;

  for (let e = 0; e < EPOCHS; e++) {
    const before = await provider.getBalance(await keeper.getAddress());
    const rc = await (await world.connect(keeper).advance()).wait();
    const jobId = rc.logs.map((l) => { try { return world.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === 'EpochStarted').args.jobId;
    assert.ok((await provider.getBalance(await keeper.getAddress())) > before - rc.gasUsed * rc.gasPrice, 'keeper is tipped');
    await assert.rejects(world.advance());
    const t = await operate(jobId);
    for (let g = 0; g < BEATS; g++) ref = worldStep(ref, W, H);
    assert.deepEqual(fromWorldState(t.newState), ref, `epoch ${e} matches the reference`);
  }
  // the next advance takes the last epoch's result, ends the season and clears the board
  await (await world.connect(keeper).advance()).wait();
  assert.equal(await world.season(), 1n);
  assert.equal(await world.running(), 0n);
  await assert.rejects(world.advance());
  const [pot, redPlaced, bluePlaced, winner, r, b] = await world.seasonInfo(0);
  assert.equal(winner, 1n);
  assert.equal(r, BigInt(ref.filter((v) => v === 1).length));
  assert.equal(b, 0n);
  assert.equal(redPlaced, 9n);
  assert.equal(bluePlaced, 2n);
  assert.equal(pot, (PRICE * 11n) / 2n);
  assert.deepEqual((await cellsOf()).filter(Boolean), []);

  const redBefore = await provider.getBalance(await red.getAddress());
  const rc = await (await world.connect(red).claim(0)).wait();
  assert.equal(await provider.getBalance(await red.getAddress()), redBefore + pot - rc.gasUsed * rc.gasPrice);
  await assert.rejects(world.connect(red).claim(0));
  await assert.rejects(world.connect(blue).claim(0));

  // season 1: blue may now switch sides, and the world starts again from its cells
  await (await world.connect(blue).place(1, mask([[8, 8], [9, 8], [10, 8]]), { value: PRICE * 3n })).wait();
  await (await world.connect(keeper).advance()).wait();
  assert.deepEqual((await cellsOf()).filter(Boolean), [1, 1, 1]);
  assert.equal((await world.seasonInfo(1))[0], (PRICE * 3n) / 2n);
});
