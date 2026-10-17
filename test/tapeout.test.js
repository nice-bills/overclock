// The TapeOut-facing flow on a local EVM: processor, transistors and tapeouts through the
// TapeOut-shaped stand-in, Overclock's registry check, fees, continuing jobs, circuit accounts
// and the Machine consumer.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, Contract, parseEther } from 'ethers';
import { load, pack, unpack, hexToBytes, bytesToHex } from '../src/tap02.js';
import { traceJob, Tree } from '../src/trace.js';
import { cellCircuit, boardCircuit, lifeStep, board, PATTERNS } from '../src/life.js';
import { artifact } from '../src/chain.js';
import { createCPU, mint, burnCost, tapeout, OPENER_ABI, ACCOUNT_ABI } from '../src/tapeout.js';
import { Builder } from '../src/hdl.js';

const BOND = parseEther('1'), WINDOW = 3600, FEE = parseEther('0.1');
const W = 6, H = 6;
let provider, owner, op, treasury, stranger, factory, cpu, oc, cellId, boardId, cellC, bdC, start;

async function deploy(name, signer, ...args) {
  const a = artifact(name);
  const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}
const reverts = (p, msg) => assert.rejects(p, (e) => `${e.shortMessage} ${e.message} ${JSON.stringify(e.info ?? {})}`.includes(msg), msg);
const later = async () => { await provider.send('evm_increaseTime', [WINDOW + 1]); await provider.send('evm_mine', []); };

// honest claim of a job, then finalize
async function runHonest(jobId, c, stateBits, beats) {
  const t = traceJob(c, { state: stateBits, beats });
  await (await oc.connect(op).claim(jobId, new Tree(t.leaves).root, bytesToHex(pack(t.outputs)), bytesToHex(pack(t.newState)), { value: BOND })).wait();
  await later();
  return (await oc.finalize(jobId)).wait();
}

before(async () => {
  provider = new BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, wallet: { totalAccounts: 5, defaultBalance: 1000 } }));
  [owner, op, treasury, stranger] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  factory = await deploy('TapeOutFactoryLocal', owner);
  cpu = await createCPU(owner, await factory.getAddress(), { name: 'Test', symbol: 'T', story: '', supply: 100000, mintPrice: parseEther('0.00001') });
  const addr = (await cpu.circuits.getAddress()).toLowerCase();
  const cell = cellCircuit();
  const bd = boardCircuit(W, H, addr, 1);
  await mint(cpu.transistors, 0, burnCost(cell.netlist, 9).nand);
  await mint(cpu.transistors, 1, W * H);
  cellId = (await tapeout(cpu.circuits, cell)).id;
  boardId = (await tapeout(cpu.circuits, bd)).id;
  cellC = load(cell.netlist, 9, 1);
  bdC = load(bd.netlist, 0, W * H, (a, i) => (a === addr && i === 1n ? cellC : null));
  oc = await deploy('Overclock', owner, BOND, WINDOW, await factory.getAddress(), await treasury.getAddress(), 200);
  start = board(W, H, [[PATTERNS.glider, 0, 0]]);
});

test('tapeout burns one transistor per NAND and LATCH, none per REF, and circuitInfo is flattened', async () => {
  const me = await owner.getAddress();
  assert.equal(await cpu.transistors.balanceOf(me, 0), 0n);
  assert.equal(await cpu.transistors.balanceOf(me, 1), 0n);
  const info = await cpu.circuits.circuitInfo(boardId);
  assert.equal(Number(info.gateCount), W * H * cellC.nGates + W * H);
  assert.equal(Number(info.nState), W * H);
  assert.equal(await cpu.circuits.nextId(), boardId);
});

test('the stand-in enforces the netlist rules TapeOut does', async () => {
  await mint(cpu.transistors, 0, 10);
  const future = new Uint8Array([0, 0, 0, 3, 0, 0, 1]); // NAND reading its own output
  await reverts(cpu.circuits.tapeout(future, 1, 1, { value: await cpu.circuits.TAPEOUT_FEE() }), 'NAND: future signal');
  const b = new Builder(2);
  const bad = b.ref(await cpu.circuits.getAddress(), cellId, 1, [b.in[0], b.in[1]]); // the cell has 9 inputs
  await reverts(cpu.circuits.tapeout(b.build(bad).netlist, 2, 1, { value: await cpu.circuits.TAPEOUT_FEE() }), 'REF: pin mismatch');
  await reverts(cpu.circuits.tapeout(new Uint8Array([0, 0, 0, 2, 0, 0, 2]), 1, 1, { value: 1n }), 'tapeout fee');
});

test('Overclock only accepts circuits of registered TapeOut processors', async () => {
  const mock = await deploy('MockProcessor', owner);
  await (await mock.store(cellCircuit().netlist, 9, 1, 0, 57)).wait();
  await reverts(oc.postJob(await mock.getAddress(), 1, '0x00', '0x', 1, false), 'not a TapeOut processor');
});

test('job fee is split between the claimant and the treasury', async () => {
  const rc = await (await oc.postJob(await cpu.circuits.getAddress(), boardId, '0x', bytesToHex(pack(start)), 4, false, { value: FEE })).wait();
  const jobId = oc.interface.parseLog(rc.logs.find((l) => l.address === rc.to)).args.jobId;
  const t0 = await provider.getBalance(await treasury.getAddress());
  await runHonest(jobId, bdC, start, 4);
  assert.equal((await provider.getBalance(await treasury.getAddress())) - t0, FEE * 200n / 10000n);
});

test('a circuit\'s own account posts a continuation, and the run picks up exactly where it stopped', async () => {
  const rc = await (await oc.postJob(await cpu.circuits.getAddress(), boardId, '0x', bytesToHex(pack(start)), 5, false, { value: FEE })).wait();
  const first = Number(oc.interface.parseLog(rc.logs.find((l) => l.address === rc.to)).args.jobId);
  await runHonest(first, bdC, start, 5);
  const opener = await deploy('OpenerLocal', owner, await factory.getAddress());
  await (await opener.open(await cpu.circuits.getAddress(), boardId, { value: parseEther('0.08') })).wait();
  const acct = await opener.accountOf(await cpu.circuits.getAddress(), boardId);
  await (await owner.sendTransaction({ to: acct, value: FEE })).wait();
  const data = oc.interface.encodeFunctionData('continueJob', [first, '0x', 7, false]);
  const account = new Contract(acct, ACCOUNT_ABI, owner);
  await reverts(account.connect(stranger).execute(await oc.getAddress(), FEE, data, 0, { value: parseEther('0.002') }), 'NotOwner');
  await (await account.execute(await oc.getAddress(), FEE, data, 0, { value: parseEther('0.002') })).wait();
  const next = Number(await oc.jobCount()) - 1;
  const j = await oc.jobs(next);
  assert.equal(j.poster, acct);
  assert.equal(j.parent, BigInt(first + 1));
  let ref = start;
  for (let g = 0; g < 5; g++) ref = lifeStep(ref, W, H);
  await runHonest(next, bdC, ref, 7);
  for (let g = 0; g < 7; g++) ref = lifeStep(ref, W, H);
  const [, ns] = await oc.result(next);
  assert.deepEqual(unpack(hexToBytes(ns), W * H), ref);
  await reverts(oc.continueJob(Number(await oc.jobCount()) - 1 + 50, '0x', 1, false), '');
});

test('Machine advances on each finalized result and ignores a stale branch', async () => {
  const rc = await (await oc.postJob(await cpu.circuits.getAddress(), boardId, '0x', bytesToHex(pack(start)), 3, false, { value: FEE })).wait();
  const first = Number(oc.interface.parseLog(rc.logs.find((l) => l.address === rc.to)).args.jobId);
  await runHonest(first, bdC, start, 3);
  const m = await deploy('Machine', owner, await oc.getAddress(), first, 3);
  let ref = start;
  for (let g = 0; g < 3; g++) ref = lifeStep(ref, W, H);
  // two advances from the same head
  await (await m.advance(4, { value: FEE })).wait();
  const a = Number(await oc.jobCount()) - 1;
  await (await m.advance(2, { value: FEE })).wait();
  const b = a + 1;
  await runHonest(a, bdC, ref, 4);
  for (let g = 0; g < 4; g++) ref = lifeStep(ref, W, H);
  assert.equal(await m.head(), BigInt(a));
  assert.equal(await m.beats(), 7n);
  assert.deepEqual(unpack(hexToBytes(await m.state()), W * H), ref);
  let refB = start;
  for (let g = 0; g < 5; g++) refB = lifeStep(refB, W, H);
  await runHonest(b, bdC, unpack(hexToBytes((await oc.jobs(b)).state), W * H), 2); // finalizes, but its parent is no longer the head
  assert.equal(await m.head(), BigInt(a));
  assert.equal(await m.beats(), 7n);
});
