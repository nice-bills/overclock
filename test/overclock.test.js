// End-to-end disputes on a local EVM (ganache) against MockProcessor.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, Contract, parseEther } from 'ethers';
import { load, pack, unpack, hexToBytes, bytesToHex } from '../src/tap02.js';
import { traceBeat, buildTree, root, flatSize } from '../src/trace.js';
import { depsOf, sigPosOf, Bisector } from '../src/game.js';

const vectors = JSON.parse(readFileSync(new URL('../vendor-tap02/vectors.json', import.meta.url)));
const art = (n) => JSON.parse(readFileSync(new URL(`../build/${n}.json`, import.meta.url)));
const BOND = parseEther('1');
const WINDOW = 3600;

let provider, claimant, challenger, poster, cpu, oc;
const circuits = new Map(); // name -> { id, c }

async function deploy(name, signer, ...args) {
  const a = art(name);
  const f = new ContractFactory(a.abi, a.bytecode, signer);
  const ct = await f.deploy(...args);
  await ct.waitForDeployment();
  return ct;
}

async function register(name, v, rewrite = (h) => h) {
  const nlHex = rewrite(v.netlist);
  const resolve = (addr, id) => [...circuits.values()].find((x) => x.addr === addr.toLowerCase() && BigInt(x.id) === id)?.c ?? null;
  const c = load(hexToBytes(nlHex), v.nIn, v.nOut, resolve);
  const id = Number(await cpu.nextId());
  await (await cpu.store(nlHex, v.nIn, v.nOut, c.nState, c.nGates)).wait();
  circuits.set(name, { id, c, addr: (await cpu.getAddress()).toLowerCase() });
  return circuits.get(name);
}

before(async () => {
  provider = new BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, wallet: { totalAccounts: 3, defaultBalance: 1000 } }));
  [claimant, challenger, poster] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));
  cpu = await deploy('MockProcessor', poster);
  oc = await deploy('Overclock', poster, BOND, WINDOW);
  const byName = Object.fromEntries(vectors.valid.map((v) => [v.name, v]));
  await register('popcount', byName.popcount8_3151);
  await register('toggle', byName.toggle);
  const toggleAddr = circuits.get('toggle').addr.slice(2);
  const toggleId = circuits.get('toggle').id.toString(16).padStart(16, '0');
  // point the REF at our mock processor's copy of the toggle circuit
  await register('refState', byName.ref_with_state, (h) => h.replace('00000000000000000000000000000000000000aa0000000000000001', toggleAddr + toggleId));
});

const asClaimant = () => oc.connect(claimant);
const asChallenger = () => oc.connect(challenger);

async function post(name, inputs, state = []) {
  const { id, c } = circuits.get(name);
  const tx = await oc.connect(poster).postJob(circuits.get(name).addr, id, bytesToHex(pack(inputs)), bytesToHex(pack(state)), { value: parseEther('0.1') });
  const rc = await tx.wait();
  const jobId = rc.logs.map((l) => oc.interface.parseLog(l)).find((e) => e?.name === 'JobPosted').args.jobId;
  return { jobId, c };
}

// Run a full bisection game; returns the Resolved event.
async function dispute(jobId, claimantLevels, honestLevels, c, inputs, state) {
  const rc0 = await (await asChallenger().challenge(jobId, { value: BOND })).wait();
  const gameId = rc0.logs.map((l) => oc.interface.parseLog(l)).find((e) => e?.name === 'Challenged').args.gameId;
  const b = new Bisector(honestLevels);
  let level = claimantLevels.length - 1, index = 0;
  while (level > 0) {
    const left = claimantLevels[level - 1][2 * index], right = claimantLevels[level - 1][2 * index + 1];
    await (await asClaimant().reveal(gameId, left, right)).wait();
    const goLeft = b.choose(level, index, left, right);
    await (await asChallenger().pick(gameId, !goLeft)).wait();
    index = 2 * index + (goLeft ? 0 : 1);
    level--;
  }
  const q = index;
  const honestBits = traceBeat(c, state, inputs).leaves;
  const deps = q < flatSize(c) ? depsOf(c, q).map((pos) => ({ pos, bit: honestBits[pos], siblings: b.siblings(pos, q) })) : [];
  const rc = await (await asChallenger().resolveLeaf(gameId, deps)).wait();
  return { q, gas: rc.gasUsed, ev: rc.logs.map((l) => oc.interface.parseLog(l)).find((e) => e?.name === 'Resolved').args };
}

const bal = (s) => provider.getBalance(s.address);

test('honest claim finalizes after the window and is readable', async () => {
  const inputs = [1, 0, 1, 1, 0, 1, 1, 1];
  const { jobId, c } = await post('popcount', inputs);
  const t = traceBeat(c, [], inputs);
  await (await asClaimant().claim(jobId, root(buildTree(t.leaves)), bytesToHex(pack(t.outputs)), '0x', { value: BOND })).wait();
  await provider.send('evm_increaseTime', [WINDOW + 1]);
  await provider.send('evm_mine', []);
  await (await oc.finalize(jobId)).wait();
  const [outs] = await oc.result(jobId);
  assert.equal(outs, bytesToHex(pack(t.outputs)));
  assert.deepEqual(unpack(hexToBytes(outs), 4), [0, 1, 1, 0]); // popcount 6
});

test('a lie at one gate is caught and the liar is slashed (real mainnet netlist)', async () => {
  const inputs = [1, 1, 1, 1, 0, 0, 0, 1];
  const { jobId, c } = await post('popcount', inputs);
  const honest = traceBeat(c, [], inputs);
  // the liar flips one NAND deep in the circuit and keeps everything after it consistent
  const lieAt = 2 + 8 + 20;
  const lied = honest.leaves.slice();
  lied[lieAt] ^= 1;
  const H = buildTree(honest.leaves), C = buildTree(lied);
  await (await asClaimant().claim(jobId, root(C), bytesToHex(pack(honest.outputs.map((x) => x ^ 1))), '0x', { value: BOND })).wait();
  const before = await bal(challenger);
  const { q, ev, gas } = await dispute(jobId, C, H, c, inputs, []);
  assert.equal(q, lieAt);
  assert.equal(ev.winner, challenger.address);
  assert.equal(ev.reason, 'wrong step');
  assert.ok((await bal(challenger)) > before, 'challenger collected the bond');
  console.log(`    one-gate check at leaf ${q} of ${flatSize(c)}: resolveLeaf gas ${gas}`);
});

test('a false challenge against an honest claim loses', async () => {
  const inputs = [0, 1, 0, 1, 1, 0, 0, 0];
  const { jobId, c } = await post('popcount', inputs);
  const t = traceBeat(c, [], inputs);
  const H = buildTree(t.leaves);
  await (await asClaimant().claim(jobId, root(H), bytesToHex(pack(t.outputs)), '0x', { value: BOND })).wait();
  // a griefer pretends leaf 40 should be flipped
  const fake = t.leaves.slice();
  fake[40] ^= 1;
  const { ev } = await dispute(jobId, H, buildTree(fake), c, inputs, []);
  assert.equal(ev.winner, claimant.address);
});

test('correct trace but wrong claimed output is caught', async () => {
  const inputs = [1, 1, 1, 1, 1, 1, 1, 1];
  const { jobId, c } = await post('popcount', inputs);
  const t = traceBeat(c, [], inputs);
  const H = buildTree(t.leaves);
  const wrong = t.outputs.slice();
  wrong[0] ^= 1;
  await (await asClaimant().claim(jobId, root(H), bytesToHex(pack(wrong)), '0x', { value: BOND })).wait();
  const pos = sigPosOf(c, 0, c.nSignals - c.nOut + 0);
  const b = new Bisector(H);
  const rc = await (await asChallenger().disputeOutput(jobId, 0, [{ pos, bit: t.leaves[pos], siblings: b.siblings(pos, H[0].length) }], { value: BOND })).wait();
  const ev = rc.logs.map((l) => oc.interface.parseLog(l)).find((e) => e?.name === 'Resolved').args;
  assert.equal(ev.winner, challenger.address);
});

test('lies inside a REF sub-circuit and at a LATCH are caught (stateful circuit)', async () => {
  const { c } = circuits.get('refState');
  const inputs = [1], state = [0, 1];
  const honest = traceBeat(c, state, inputs);
  // every leaf except the constants: a lie anywhere must be caught
  for (let lieAt = 2; lieAt < honest.leaves.length; lieAt++) {
    const { jobId } = await post('refState', inputs, state);
    const lied = honest.leaves.slice();
    lied[lieAt] ^= 1;
    const H = buildTree(honest.leaves), C = buildTree(lied);
    await (await asClaimant().claim(jobId, root(C), bytesToHex(pack(honest.outputs)), bytesToHex(pack(honest.newState)), { value: BOND })).wait();
    const { q, ev } = await dispute(jobId, C, H, c, inputs, state);
    assert.equal(q, lieAt);
    assert.equal(ev.winner, challenger.address, `lie at ${lieAt}`);
  }
});

test('a claimant who stops answering loses on timeout', async () => {
  const inputs = [1, 0, 0, 0, 0, 0, 0, 0];
  const { jobId, c } = await post('popcount', inputs);
  const t = traceBeat(c, [], inputs);
  await (await asClaimant().claim(jobId, root(buildTree(t.leaves)), bytesToHex(pack(t.outputs)), '0x', { value: BOND })).wait();
  const rc = await (await asChallenger().challenge(jobId, { value: BOND })).wait();
  const gameId = rc.logs.map((l) => oc.interface.parseLog(l)).find((e) => e?.name === 'Challenged').args.gameId;
  await provider.send('evm_increaseTime', [WINDOW + 1]);
  await provider.send('evm_mine', []);
  const rc2 = await (await oc.timeout(gameId)).wait();
  const ev = rc2.logs.map((l) => oc.interface.parseLog(l)).find((e) => e?.name === 'Resolved').args;
  assert.equal(ev.winner, challenger.address);
});
