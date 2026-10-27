// Security regressions found in the October 2026 audit, plus a randomized solvency invariant.
// Each test states what an attacker tries; on the contract deployed before the audit they fail.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import solc from 'solc';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, parseEther } from 'ethers';
import { load, pack, hexToBytes, bytesToHex } from '../src/tap02.js';
import { traceBeat, buildTree, Tree } from '../src/trace.js';
import { depsOf, sigPosOf, Bisector } from '../src/game.js';

const vectors = JSON.parse(readFileSync(new URL('../vendor-tap02/vectors.json', import.meta.url)));
const art = (n) => JSON.parse(readFileSync(new URL(`../build/${n}.json`, import.meta.url)));
const BOND = parseEther('1');
const WINDOW = 3600;
const ZERO = '0x0000000000000000000000000000000000000000';

// A job poster that does real work when its result arrives (about 230K gas).
const RECEIVER = `
pragma solidity ^0.8.28;
interface IOC { function postJob(address, uint256, bytes calldata, bytes calldata, uint32, bool) external payable returns (uint256); }
contract HungryReceiver {
    uint256 public calls;
    mapping(uint256 => uint256[10]) internal sink;
    function post(IOC oc, address cpu, uint256 id, bytes calldata inputs) external payable returns (uint256) {
        return oc.postJob{value: msg.value}(cpu, id, inputs, "", 1, false);
    }
    function onOverclockResult(uint256 jobId, bytes calldata, bytes calldata) external {
        for (uint256 i; i < 10; i++) sink[jobId][i] = i + 1;
        calls++;
    }
}`;

let provider, signers, cpu, oc, popId, pop;
let attacker, accomplice, poster, operator, watcher;

async function deploy(a, signer, ...args) {
  const ct = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await ct.waitForDeployment();
  return ct;
}

const events = (rc, name) => rc.logs.map((l) => { try { return oc.interface.parseLog(l); } catch { return null; } }).filter((e) => e?.name === name).map((e) => e.args);
const send = async (p) => (await p).wait();
const bal = (a) => provider.getBalance(a);
const warp = async (s) => { await provider.send('evm_increaseTime', [s]); await provider.send('evm_mine', []); };

before(async () => {
  provider = new BrowserProvider(ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, wallet: { totalAccounts: 8, defaultBalance: 10000 } }), undefined, { cacheTimeout: -1 });
  signers = await Promise.all([...Array(8).keys()].map((i) => provider.getSigner(i)));
  [attacker, accomplice, poster, operator, watcher] = signers;
  cpu = await deploy(art('MockProcessor'), poster);
  oc = await deploy(art('Overclock'), poster, BOND, WINDOW, ZERO, signers[7].address, 0);
  const v = vectors.valid.find((x) => x.name === 'popcount8_3151');
  pop = load(hexToBytes(v.netlist), v.nIn, v.nOut);
  popId = Number(await cpu.nextId());
  await send(cpu.store(v.netlist, v.nIn, v.nOut, pop.nState, pop.nGates));
});

async function post(inputs, fee = 0n, from = poster) {
  const rc = await send(oc.connect(from).postJob(await cpu.getAddress(), popId, bytesToHex(pack(inputs)), '0x', 1, false, { value: fee }));
  return events(rc, 'JobPosted')[0].jobId;
}

async function claim(jobId, from, root, outputs) {
  return send(oc.connect(from).claim(jobId, root, bytesToHex(pack(outputs)), '0x', { value: BOND }));
}

// Bisect a challenge. C: the claimant's tree; choose(level, index, left, right) -> goLeft.
async function bisect(gameId, from, C, choose) {
  let level = C.depth, index = 0;
  while (level > 0) {
    const left = C.node(level - 1, 2 * index), right = C.node(level - 1, 2 * index + 1);
    await send(oc.connect(from.claimant).reveal(gameId, left, right));
    const goLeft = choose(level, index, left, right);
    await send(oc.connect(from.challenger).pick(gameId, !goLeft));
    index = 2 * index + (goLeft ? 0 : 1);
    level--;
  }
  return index;
}

async function challenge(jobId, from) {
  return events(await send(oc.connect(from).challenge(jobId, { value: BOND })), 'Challenged')[0].gameId;
}

const INPUTS = [1, 0, 1, 1, 0, 1, 1, 1];

test('a settled game cannot be resolved again to pay its winner twice', async () => {
  await post([0, 0, 0, 0, 0, 0, 0, 1], parseEther('5')); // someone else's fee, held by the contract
  const held = await bal(oc.target);
  // the attacker claims its own job honestly and challenges itself from a second account
  const jobId = await post(INPUTS, 0n, attacker);
  const t = traceBeat(pop, [], INPUTS);
  const H = buildTree(t.leaves);
  await claim(jobId, attacker, H.root, t.outputs);
  const gameId = await challenge(jobId, accomplice);
  // always pick left: leaf 0 is the constant 0, so the leaf check needs no proofs at all
  assert.equal(await bisect(gameId, { claimant: attacker, challenger: accomplice }, H, () => true), 0);
  await send(oc.resolveLeaf(gameId, []));
  // ...then calls resolveLeaf again and again on the settled game
  for (let i = 0; i < 10 && (await bal(oc.target)) >= 2n * BOND; i++) {
    try { await send(oc.connect(attacker).resolveLeaf(gameId, [])); } catch { break; }
  }
  await warp(WINDOW + 1);
  await send(oc.finalize(jobId));
  assert.equal(await bal(oc.target), held, 'the contract paid out money it did not owe');
});

test('a claimant who survives a challenge is paid the challenger\'s bond, not two bonds', async () => {
  await post([0, 0, 0, 0, 0, 0, 1, 1], parseEther('5'));
  const held = await bal(oc.target);
  const jobId = await post(INPUTS, 0n, attacker);
  const t = traceBeat(pop, [], INPUTS);
  const H = buildTree(t.leaves);
  await claim(jobId, attacker, H.root, t.outputs);
  // the accomplice disputes a result bit that is right, in one transaction, several times over
  const pos = sigPosOf(pop, 0, pop.nSignals - pop.nOut);
  const dep = [{ pos, bit: t.leaves[pos], siblings: H.proof(pos) }];
  for (let i = 0; i < 4; i++) {
    try { await send(oc.connect(accomplice).disputeOutput(jobId, 0, dep, { value: BOND })); } catch { break; }
  }
  await warp(WINDOW + 1);
  try { await send(oc.finalize(jobId)); } catch {}
  assert.equal(await bal(oc.target), held, 'every failed dispute minted a bond out of other users\' money');
});

test('an old game cannot wipe a later honest claim on the same job', async () => {
  const inputs = [1, 1, 1, 1, 0, 0, 0, 1];
  const jobId = await post(inputs, parseEther('1'));
  const honest = traceBeat(pop, [], inputs);
  const lied = honest.leaves.slice();
  lied[30] ^= 1;
  const H = buildTree(honest.leaves), C = buildTree(lied);
  // a cheat claims, a watcher catches it
  await claim(jobId, attacker, C.root, honest.outputs);
  const gameId = await challenge(jobId, watcher);
  const b = new Bisector(H);
  const q = await bisect(gameId, { claimant: attacker, challenger: watcher }, C, (l, i, left, right) => b.choose(l, i, left, right));
  const deps = depsOf(pop, q).map((pos) => ({ pos, bit: honest.leaves[pos], siblings: b.siblings(pos, q) }));
  await send(oc.connect(watcher).resolveLeaf(gameId, deps));
  // an honest operator now claims the right result
  await claim(jobId, operator, H.root, honest.outputs);
  // anyone replays the old game against the new claim, with proofs from the honest tree
  const fresh = depsOf(pop, q).map((pos) => ({ pos, bit: honest.leaves[pos], siblings: H.proof(pos) }));
  await assert.rejects(send(oc.connect(attacker).resolveLeaf(gameId, fresh)));
  assert.equal((await oc.jobs(jobId)).claimant, operator.address, 'the honest claim was wiped and its bond paid away');
});

test('anyone finalizing cannot starve the poster\'s result callback of gas', async () => {
  const src = { language: 'Solidity', sources: { 'R.sol': { content: RECEIVER } }, settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
  const r = JSON.parse(solc.compile(JSON.stringify(src))).contracts['R.sol'].HungryReceiver;
  const recv = await deploy({ abi: r.abi, bytecode: '0x' + r.evm.bytecode.object }, poster);
  const rc = await send(recv.post(oc.target, await cpu.getAddress(), popId, bytesToHex(pack(INPUTS)), { value: parseEther('0.1') }));
  const jobId = oc.interface.parseLog(rc.logs.find((l) => l.address.toLowerCase() === oc.target.toLowerCase())).args.jobId;
  const t = traceBeat(pop, [], INPUTS);
  await claim(jobId, operator, buildTree(t.leaves).root, t.outputs);
  await warp(WINDOW + 1);
  // find the least gas finalize succeeds with, and check the callback ran there
  const tryWith = async (gasLimit) => {
    const snap = await provider.send('evm_snapshot', []);
    let ok = false, calls = 0n;
    try {
      ok = (await (await oc.connect(attacker).finalize(jobId, { gasLimit })).wait()).status === 1;
      calls = await recv.calls();
    } catch {}
    await provider.send('evm_revert', [snap]);
    return { ok, calls };
  };
  let lo = 30_000, hi = 2_000_000;
  assert.ok((await tryWith(hi)).ok);
  while (hi - lo > 500) {
    const mid = (lo + hi) >> 1;
    if ((await tryWith(mid)).ok) hi = mid; else lo = mid;
  }
  assert.equal((await tryWith(hi)).calls, 1n, `finalize succeeded with ${hi} gas but the callback never ran`);
});

test('a claim cannot carry unchecked garbage in the padding bits of its result', async () => {
  const jobId = await post(INPUTS);
  const t = traceBeat(pop, [], INPUTS);
  // popcount has 4 outputs: the top 4 bits of the byte are not part of the result and no
  // dispute can reach them, so a consumer reading the bytes would trust whatever is there
  const out = pack(t.outputs);
  out[0] |= 0xf0;
  await assert.rejects(send(oc.connect(attacker).claim(jobId, buildTree(t.leaves).root, bytesToHex(out), '0x', { value: BOND })));
});

test('a circuit whose trace does not fit in 64 bits is refused', async () => {
  // level 0: one NAND; level k: two REFs to level k - 1. flatSize doubles with each level.
  const addr = (await cpu.getAddress()).slice(2).toLowerCase();
  let id = Number(await cpu.nextId());
  await send(cpu.store('0x00000000000001', 0, 1, 0, 1));
  for (let k = 1; k <= 64; k++) {
    const ref = '02' + addr + BigInt(id).toString(16).padStart(16, '0') + '0001';
    id = Number(await cpu.nextId());
    await send(cpu.store('0x' + ref + ref, 0, 1, 0, 1));
    await send(oc.flatSize(await cpu.getAddress(), id)).catch(() => {}); // memoize level by level
  }
  await assert.rejects(send(oc.postJob(await cpu.getAddress(), id, '0x', '0x', 1, false)));
});

test('a cheat\'s accomplice who challenges first cannot keep an honest watcher out', async () => {
  const inputs = [0, 1, 1, 0, 1, 0, 0, 1];
  const fee = parseEther('1');
  const jobId = await post(inputs, fee);
  const honest = traceBeat(pop, [], inputs);
  const lied = honest.leaves.slice();
  lied[40] ^= 1;
  const H = buildTree(honest.leaves), C = buildTree(lied);
  const held = await bal(oc.target);
  await claim(jobId, attacker, C.root, honest.outputs);
  // the accomplice opens a game it means to lose slowly
  const stall = await challenge(jobId, accomplice);
  // the honest watcher still gets in, and wins on its own game
  const gameId = await challenge(jobId, watcher);
  const b = new Bisector(H);
  const q = await bisect(gameId, { claimant: attacker, challenger: watcher }, C, (l, i, left, right) => b.choose(l, i, left, right));
  const before = await bal(watcher.address);
  await send(oc.connect(attacker).resolveLeaf(gameId, depsOf(pop, q).map((pos) => ({ pos, bit: honest.leaves[pos], siblings: b.siblings(pos, q) }))));
  assert.equal(await bal(watcher.address), before + 2n * BOND, 'the watcher is paid its bond and the cheat\'s');
  assert.equal((await oc.jobs(jobId)).claimant, ZERO, 'the wrong claim is gone');
  // the accomplice's game is now stale: no more moves, and it only refunds
  await assert.rejects(send(oc.connect(attacker).reveal(stall, C.node(C.depth - 1, 0), C.node(C.depth - 1, 1))));
  await send(oc.timeout(stall));
  assert.equal(Number((await oc.games(stall)).level), 255);
  await assert.rejects(send(oc.timeout(stall)));
  // an honest operator claims and is paid; the contract keeps nothing it doesn't owe
  await claim(jobId, operator, H.root, honest.outputs);
  await warp(WINDOW + 1);
  await send(oc.finalize(jobId));
  assert.equal(await bal(oc.target), held - fee);
});

test('a claim cannot finalize while any game against it is open', async () => {
  const inputs = [1, 0, 0, 1, 1, 0, 1, 0];
  const jobId = await post(inputs);
  const t = traceBeat(pop, [], inputs);
  const H = buildTree(t.leaves);
  await claim(jobId, operator, H.root, t.outputs);
  const g1 = await challenge(jobId, accomplice);
  const g2 = await challenge(jobId, watcher);
  await warp(WINDOW + 1);
  await assert.rejects(send(oc.finalize(jobId)));
  await send(oc.timeout(g1)); // the claimant was due to move: it loses g1, and the claim with it
  assert.equal((await oc.jobs(jobId)).claimant, ZERO);
  const before = await bal(watcher.address);
  await send(oc.connect(operator).timeout(g2)); // stale now: the watcher's bond comes back, and no more
  assert.equal((await oc.games(g2)).turn, 3n);
  assert.equal(await bal(watcher.address), before + BOND);
});

test('a move after its deadline is refused, and the side that was due loses on timeout', async () => {
  const inputs = [1, 1, 0, 0, 1, 1, 0, 0];
  const jobId = await post(inputs);
  const t = traceBeat(pop, [], inputs);
  const H = buildTree(t.leaves);
  await claim(jobId, operator, H.root, t.outputs);
  const gameId = await challenge(jobId, watcher);
  await warp(WINDOW + 1);
  await assert.rejects(send(oc.connect(operator).reveal(gameId, H.node(H.depth - 1, 0), H.node(H.depth - 1, 1))));
  await send(oc.timeout(gameId));
  assert.equal((await oc.jobs(jobId)).claimant, ZERO, 'the late claimant lost');
});

// ------------------------------------------------------------------ randomized solvency invariant

// Whatever sequence of posts, claims, challenges, games, timeouts, replays and finalizations
// happens, the contract holds exactly the money it owes: every open job's fee, every live
// claim's bond and every open game's challenge bond.
async function owed() {
  let sum = 0n;
  const nJobs = Number(await oc.jobCount());
  for (let i = 0; i < nJobs; i++) {
    const j = await oc.jobs(i);
    if (j.finalized) continue;
    sum += j.fee;
    if (j.claimant !== ZERO) sum += BOND;
  }
  const nGames = Number(await oc.gameCount());
  for (let g = 0; g < nGames; g++) if (Number((await oc.games(g)).level) !== 255) sum += BOND;
  return sum;
}

function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

for (const seed of [1, 2, 3]) {
  test(`solvency invariant holds over a random run (seed ${seed})`, async () => {
    const rand = rng(seed);
    const pick = (a) => a[Math.floor(rand() * a.length)];
    const players = signers.slice(0, 5);
    const jobs = []; // { jobId, inputs, honest, claim: { who, leaves, tree, outputs } | null }
    const closed = []; // [gameId, deps] of settled games, for replays
    const parked = []; // games left open mid-bisection
    // owed() counts every job and game ever made on this contract, so it starts from what earlier tests left
    const base = (await bal(oc.target)) - (await owed());
    const check = async (what) => assert.equal((await bal(oc.target)) - (await owed()), base, `after ${what}`);
    for (let step = 0; step < 30; step++) {
      const open = jobs.filter((j) => j.claim);
      const r = rand();
      if (r < 0.2 || jobs.length === 0) {
        const inputs = [...Array(8)].map(() => (rand() < 0.5 ? 1 : 0));
        const jobId = await post(inputs, BigInt(Math.floor(rand() * 5)) * parseEther('0.1'), pick(players));
        jobs.push({ jobId, inputs, honest: traceBeat(pop, [], inputs), claim: null });
        await check('post');
      } else if (r < 0.4) {
        const j = jobs.find((x) => !x.claim && !x.done);
        if (!j) continue;
        const leaves = j.honest.leaves.slice(), outputs = j.honest.outputs.slice();
        const kind = rand();
        if (kind < 0.35) leaves[2 + 8 + Math.floor(rand() * 50)] ^= 1; // lie in the trace
        else if (kind < 0.55) outputs[Math.floor(rand() * 4)] ^= 1; // lie in the result
        const who = pick(players);
        await claim(j.jobId, who, buildTree(leaves).root, outputs);
        j.claim = { who, leaves, tree: buildTree(leaves), outputs };
        await check('claim');
      } else if (r < 0.65 && open.length) {
        const j = pick(open);
        const s = await oc.jobs(j.jobId);
        if (s.finalized) continue; // games run in parallel, so an open one doesn't stop another
        const challenger = pick(players);
        // the challenger plays from the honest trace; if the claim is honest it plays a made-up one
        let mine = j.honest.leaves;
        if (buildTree(mine).root === j.claim.tree.root) {
          mine = mine.slice();
          mine[2 + 8 + Math.floor(rand() * 50)] ^= 1;
        }
        let gameId;
        try { gameId = await challenge(j.jobId, challenger); } catch { continue; } // window over
        await check('challenge');
        if (rand() < 0.4) { // a second watcher opens its own game on the same claim and waits
          parked.push(await challenge(j.jobId, pick(players)));
          await check('parallel challenge');
        }
        if (rand() < 0.2) { // someone walks away mid-game
          await warp(WINDOW + 1);
          await send(oc.timeout(gameId));
        } else if (rand() < 0.25) { // left open: a later game may overturn the claim and make it stale
          parked.push(gameId);
        } else {
          const b = new Bisector(new Tree(mine));
          const q = await bisect(gameId, { claimant: j.claim.who, challenger }, j.claim.tree, (l, i, left, right) => b.choose(l, i, left, right));
          const deps = depsOf(pop, q).map((pos) => ({ pos, bit: mine[pos], siblings: b.siblings(pos, q) }));
          await send(oc.resolveLeaf(gameId, deps));
          closed.push([gameId, deps]);
        }
        const after = await oc.jobs(j.jobId);
        if (after.claimant === ZERO) j.claim = null;
        await check('game');
      } else if (r < 0.75 && open.length) {
        const j = pick(open);
        const s = await oc.jobs(j.jobId);
        if (s.openGames > 0n || s.finalized) continue;
        const k = Math.floor(rand() * 4);
        const pos = sigPosOf(pop, 0, pop.nSignals - pop.nOut + k);
        try {
          await send(oc.connect(pick(players)).disputeOutput(j.jobId, k, [{ pos, bit: j.claim.leaves[pos], siblings: j.claim.tree.proof(pos) }], { value: BOND }));
        } catch { continue; } // window over
        if ((await oc.jobs(j.jobId)).claimant === ZERO) j.claim = null;
        await check('disputeOutput');
      } else if (r < 0.8 && parked.length) {
        // close a parked game: a stale one refunds at once, a live one waits out its deadline
        const gameId = parked.splice(Math.floor(rand() * parked.length), 1)[0];
        const g = await oc.games(gameId);
        if (Number(g.level) === 255) continue;
        if ((await oc.gameClaim(gameId)) === (await oc.claimCount(g.jobId))) await warp(WINDOW + 1);
        await send(oc.timeout(gameId));
        for (const j of jobs) if (j.claim && (await oc.jobs(j.jobId)).claimant === ZERO) j.claim = null;
        await check('timeout of a parked game');
      } else if (r < 0.85 && closed.length) {
        const [gameId, deps] = pick(closed);
        try { await send(oc.connect(pick(players)).resolveLeaf(gameId, rand() < 0.5 ? deps : [])); } catch {}
        for (const j of jobs) if (j.claim && (await oc.jobs(j.jobId)).claimant === ZERO) j.claim = null;
        await check('replayed resolveLeaf');
      } else if (open.length) {
        await warp(WINDOW + 1);
        for (const j of open) {
          const s = await oc.jobs(j.jobId);
          if (s.openGames > 0n || s.finalized) continue;
          await send(oc.finalize(j.jobId));
          j.claim = null;
          j.done = true;
          await check('finalize');
        }
      }
    }
  });
}
