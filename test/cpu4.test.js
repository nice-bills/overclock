// The 4-bit CPU: circuit against the reference emulator, the Fibonacci program, and a cheat on a
// CPU job caught end to end by the bots on a local EVM.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, parseEther } from 'ethers';
import { load, beat, pack, unpack, hexToBytes, bytesToHex } from '../src/tap02.js';
import { layout } from '../src/trace.js';
import { Builder } from '../src/hdl.js';
import { Operator, Challenger } from '../src/agents.js';
import { cpuCircuit, toState, fromState, cpuStep, cpuRun, assemble, fibonacciMachine, fibMod256 } from '../src/cpu4.js';

const art = (n) => JSON.parse(readFileSync(new URL(`../build/${n}.json`, import.meta.url)));
const built = cpuCircuit();
const c = load(built.netlist, built.nIn, built.nOut);

test('Builder buffers several outputs so they are the last signals, in order', () => {
  const b = new Builder(3);
  const x = b.xor(b.in[0], b.in[1]), y = b.and(b.in[1], b.in[2]), z = b.not(b.in[0]);
  const nl = b.build([y, x, z]);
  const k = load(nl.netlist, nl.nIn, nl.nOut);
  for (let m = 0; m < 8; m++) {
    const ins = [m & 1, (m >> 1) & 1, (m >> 2) & 1];
    assert.deepEqual(beat(k, [], ins)[1], [ins[1] & ins[2], ins[0] ^ ins[1], 1 - ins[0]]);
  }
});

test('CPU circuit matches the reference emulator on random machines', () => {
  assert.equal(c.nState, 205);
  let seed = 7;
  const rnd = (n) => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) % n);
  for (let t = 0; t < 150; t++) {
    let m = { pc: rnd(16), a: rnd(16), c: rnd(2), out: rnd(16), ram: Array.from({ length: 16 }, () => rnd(16)), rom: Array.from({ length: 16 }, () => rnd(256)) };
    let s = toState(m);
    for (let i = 0; i < 30; i++) {
      const [ns, outs] = beat(c, s, []);
      m = cpuStep(m);
      assert.deepEqual(ns, toState(m), `machine ${t}, beat ${i}`);
      assert.deepEqual(outs, toState(m).slice(9, 13));
      s = ns;
    }
  }
});

test('Fibonacci program: 10,000 beats give F(625) and F(626) mod 256', () => {
  const m = cpuRun(fibonacciMachine(), 10_000);
  assert.equal(m.ram[0] | (m.ram[1] << 4), fibMod256(625));
  assert.equal(m.ram[2] | (m.ram[3] << 4), fibMod256(626));
  assert.equal(m.pc, 0);
  assert.throws(() => assemble(['FOO 1']));
  assert.deepEqual(fromState(toState(m)).ram, m.ram);
});

test('a cheat on a 400-beat CPU job is caught and the honest result finalizes', async () => {
  const provider = new BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, miner: { blockGasLimit: 200_000_000 }, wallet: { totalAccounts: 4, defaultBalance: 1000 } }));
  const [poster, cheatS, honestS, watcherS] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  const deploy = async (name, ...args) => {
    const a = art(name);
    const ct = await new ContractFactory(a.abi, a.bytecode, poster).deploy(...args);
    await ct.waitForDeployment();
    return ct;
  };
  const proc = await deploy('MockProcessor');
  const oc = await deploy('Overclock', parseEther('1'), 3600, '0x0000000000000000000000000000000000000000', await poster.getAddress(), 0);
  await (await proc.store(bytesToHex(built.netlist), 0, built.nOut, c.nState, c.nGates)).wait();
  const BEATS = 400;
  const m0 = fibonacciMachine();
  await (await oc.postJob(await proc.getAddress(), 1, '0x', bytesToHex(pack(toState(m0))), BEATS, false, { value: parseEther('0.1') })).wait();

  const L = layout(c, BEATS);
  const lieLeaf = 241 * L.B + built.signals.sum[0]; // the ADD of pass 16
  let lied = false;
  const cheat = new Operator({ oc, signer: cheatS, name: 'cheat', lie: () => (lied ? null : ((lied = true), lieLeaf)) });
  const op = new Operator({ oc, signer: honestS, name: 'operator' });
  const log = [];
  const watch = new Challenger({ oc, signer: watcherS, name: 'watcher', log: (e) => log.push(e) });
  await cheat.tick();
  for (let i = 0; i < 80 && !log.some((e) => e.fn === 'resolveLeaf'); i++) {
    await watch.tick();
    await cheat.tick();
  }
  assert.equal(log.find((e) => e.leaf !== undefined).leaf, lieLeaf, 'the dispute lands on the corrupted gate');
  assert.equal((await oc.games(0)).level, 255n);
  await op.tick();
  await provider.send('evm_increaseTime', [3601]);
  await provider.send('evm_mine', []);
  await op.tick();
  const [, st] = await oc.result(0);
  assert.deepEqual(unpack(hexToBytes(st), c.nState), toState(cpuRun(m0, BEATS)));
});
