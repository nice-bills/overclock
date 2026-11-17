// B3: the runner. Unit tests (queue order, beats, bond helper, budget guard, runs.json writing) and an
// end-to-end run on ganache: the real 8x8 Life board and a real FabX miner are mirrored from X Layer
// mainnet (free reads of rpc.xlayer.tech) into a TapeOutLocal processor, run through Overclock
// unattended, killed and resumed halfway, and recorded in a copy of web/runs.json.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync, mkdtempSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import { BrowserProvider, JsonRpcProvider, ContractFactory, parseEther } from 'ethers';
import { artifact } from '../src/chain.js';
import { createCPU } from '../src/tapeout.js';
import { MAINNET_RPC } from '../src/mirror.js';
import {
  Runner, buildQueue, planBeats, seedBits, bondOf, dryRun, upsertRun, dropRun, upsertCertificate, writeJsonAtomic, connectLocal,
} from '../src/runner.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const census = JSON.parse(readFileSync(new URL('../docs/census.json', import.meta.url)));
const seed = JSON.parse(readFileSync(new URL('../web/runs.json', import.meta.url)));
const tmp = () => mkdtempSync(join(tmpdir(), 'overclock-runner-'));

const OKSPACE = '0xb00f10bb4b2f32c561bf90e205e543d0a2395971:5';
const MINER = '0x87bfca3494aa228ff589ab9b642143a5e8c8f9a6:820';

// ---- unit ---------------------------------------------------------------------------------

describe('selection', () => {
  const queue = buildQueue(census);
  const machines = queue.filter((q) => q.kind === 'machine'), miners = queue.filter((q) => q.kind === 'miner');

  test('stuck machines come first, biggest first, then miner shapes biggest first', () => {
    assert.equal(machines.length, 25, '7 AlephTape nets + 18 other stuck machines');
    assert.ok(machines.every((m) => !m.name.startsWith('FAB')));
    assert.deepEqual(queue.slice(0, machines.length).map((q) => q.kind), machines.map(() => 'machine'), 'no miner before a machine');
    assert.equal(machines[0].name + machines[0].id, 'AlephTape21');
    for (let i = 1; i < machines.length; i++) assert.ok(machines[i - 1].gates >= machines[i].gates);
    for (let i = 1; i < miners.length; i++) assert.ok(miners[i - 1].gates >= miners[i].gates);
  });

  test('a miner shape is listed once, with the circuits that share it', () => {
    const shapes = miners.map((m) => m.shape);
    assert.equal(new Set(shapes).size, shapes.length);
    const big = miners.find((m) => m.shape === '463/18/17/51');
    assert.equal(big.members.length, 204, '205 identical circuits, one representative');
    assert.equal(miners.reduce((s, m) => s + 1 + m.members.length, 0), census.heldBack.filter((c) => c.processorName.startsWith('FAB')).length);
  });

  test('the order is deterministic', () => {
    assert.deepEqual(buildQueue(census).map((q) => q.key), queue.map((q) => q.key));
    assert.deepEqual(buildQueue({ ...census, heldBack: [...census.heldBack].reverse() }).map((q) => q.key), queue.map((q) => q.key));
  });

  test('beats exceed what a block allows, within the step cap; a circuit too big is skipped', () => {
    const lote = machines.find((m) => m.name === 'LoteGate' && m.id === 3);
    const p = planBeats(lote, { maxSteps: 1e9 });
    assert.ok(p.beats > lote.beatsPerBlock);
    assert.equal(p.steps, p.beats * (lote.gates + lote.nState));
    assert.equal(planBeats(machines[0], { maxSteps: 1e9 }).beats, 1, 'one beat is already more than a block');
    assert.equal(planBeats(lote, { maxSteps: 100 }), null);
    assert.ok(planBeats(lote, { maxSteps: 100_000 }) === null || planBeats(lote, { maxSteps: 100_000 }).steps <= 100_000);
  });

  test('dry run lists the plan without any chain', () => {
    const plan = dryRun(queue, { maxSteps: 20_000_000, only: new Set([OKSPACE, MINER]) });
    assert.deepEqual(plan.map((p) => p.key), [OKSPACE, MINER]);
    assert.ok(plan.every((p) => p.beats >= 1 && p.skip === null));
  });

  test('seeded inputs are deterministic and sized', () => {
    assert.deepEqual(seedBits('a:1', 40), seedBits('a:1', 40));
    assert.notDeepEqual(seedBits('a:1', 40), seedBits('a:2', 40));
    assert.equal(seedBits('a:1', 300).length, 300);
  });
});

describe('bond helper', () => {
  test('uses bondFor(jobId) when the contract has it, bond() otherwise', async () => {
    const v2 = { interface: { getFunction: () => ({}) }, bondFor: async (j) => 100n + BigInt(j), bond: async () => { throw new Error('old'); } };
    const v1 = { interface: { getFunction: () => { throw new Error('no such function'); } }, bond: async () => 7n, bondFor: async () => { throw new Error('absent'); } };
    assert.equal(await bondOf(v2, 3), 103n);
    assert.equal(await bondOf(v1, 3), 7n);
  });
});

describe('budget guard', () => {
  const make = (over = {}) => {
    const r = Object.create(Runner.prototype);
    Object.assign(r, {
      st: { items: {}, days: {} }, fee: 10n, reserve: 5n, floor: 100n, maxPerDay: 1000n, clock: () => Date.parse('2026-11-20T10:00:00Z'), say: () => {},
      oc: { jobCount: async () => 0n, interface: { getFunction: () => { throw new Error('v1'); } }, bond: async () => 50n }, bal: 1000n, ...over,
    });
    r.balance = async () => r.bal;
    return r;
  };

  test('stops new work below the floor (bond + fee + reserve + floor)', async () => {
    const r = make({ bal: 164n });
    assert.match(await r.budgetBlock(), /under the floor/);
    r.bal = 165n;
    assert.equal(await r.budgetBlock(), null);
  });

  test('stops at the per-day cap, and the cap resets the next day', async () => {
    const r = make();
    r.st.days['2026-11-20'] = '1000';
    assert.match(await r.budgetBlock(), /daily cap/);
    r.clock = () => Date.parse('2026-11-21T00:00:01Z');
    assert.equal(await r.budgetBlock(), null);
  });

  test('spend is the fall in balance plus locked bonds; locking a bond is not spending', async () => {
    const r = make({ bal: 1000n });
    r.st.lastAdj = '1000';
    r.bal = 970n; // fee and gas
    await r.account();
    assert.equal(r.spentToday(), 30n);
    r.bal = 920n; // 50 locked as a bond: the sum is unchanged
    r.st.items.x = { phase: 'claimed', claimedByMe: true, bond: '50' };
    await r.account();
    assert.equal(r.spentToday(), 30n);
    r.bal = 1020n; // the job finalized: bond and fee came back
    r.st.items.x.phase = 'done';
    await r.account();
    assert.equal(r.spentToday(), 30n, 'a gain never reduces what was spent');
    assert.equal(r.st.lastAdj, '1020');
  });
});

describe('runs.json writing', () => {
  const run = (jobId, status = 'final') => ({
    id: `1337:${jobId}`, chainId: 1337, overclock: '0x' + '1'.repeat(40), jobId, circuit: { processor: '0x' + '2'.repeat(40), id: jobId },
    what: 'x', beats: 2, steps: 10, status, txs: [{ what: 'post job', tx: '0x' + 'ab'.repeat(32), gas: 5 }],
  });

  test('keeps the seed, adds, updates in place, drops, and stamps the network and time', () => {
    const path = join(tmp(), 'runs.json');
    writeFileSync(path, JSON.stringify(seed));
    upsertRun(path, run(0, 'posted'), {}, Date.parse('2026-11-20T10:00:00Z'));
    upsertRun(path, run(0, 'final'), {}, Date.parse('2026-11-20T11:00:00Z'));
    upsertRun(path, run(1), {}, Date.parse('2026-11-20T11:00:00Z'));
    let d = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(d.schema, 1);
    assert.equal(d.updatedAt, '2026-11-20T11:00:00.000Z');
    assert.equal(d.runs.length, seed.runs.length + 2);
    assert.deepEqual(d.runs.slice(0, seed.runs.length), seed.runs, 'seed runs untouched');
    assert.equal(d.runs.find((r) => r.id === '1337:0').status, 'final');
    assert.ok(d.networks['196'] && d.networks['1337'].overclock);
    upsertCertificate(path, { id: 'cert:1337:1', runId: '1337:1', status: 'certified', mismatches: 0, inputs: 4 });
    dropRun(path, '1337:1');
    d = JSON.parse(readFileSync(path, 'utf8'));
    assert.equal(d.runs.some((r) => r.id === '1337:1'), false);
    assert.equal(d.certificates.length, 0, 'its certificate goes with it');
  });

  test('a missing file starts fresh, and writes are atomic (no temp file left)', () => {
    const dir = tmp(), path = join(dir, 'sub', 'runs.json');
    upsertRun(path, run(0), {});
    assert.equal(JSON.parse(readFileSync(path, 'utf8')).runs.length, 1);
    writeJsonAtomic(join(dir, 's.json'), { a: 1 });
    assert.deepEqual(execFileSync('ls', [dir]).toString().split('\n').filter(Boolean).sort(), ['s.json', 'sub']);
  });
});

describe('scripts/runner.js', () => {
  test('--dry-run prints the plan and needs no key', () => {
    const out = execFileSync(process.execPath, ['scripts/runner.js', '--dry-run', '--limit', '3'], { cwd: root, env: { PATH: process.env.PATH } }).toString();
    assert.match(out, /AlephTape #21/);
    assert.match(out, /dry run: 3 items, nothing sent/);
  });

  test('without RUNNER_KEY it refuses to start', () => {
    assert.throws(() => execFileSync(process.execPath, ['scripts/runner.js'], { cwd: root, env: { PATH: process.env.PATH, RPC_URL: 'http://127.0.0.1:1' }, stdio: 'pipe' }));
  });

  test('a failing start never prints the key', () => {
    const key = '0x' + 'ac09'.repeat(16);
    try {
      execFileSync(process.execPath, ['scripts/runner.js'], { cwd: root, env: { PATH: process.env.PATH, RPC_URL: 'http://127.0.0.1:1', RUNNER_KEY: key }, stdio: 'pipe', timeout: 60_000 });
      assert.fail('should not start');
    } catch (e) {
      assert.equal(`${e.stdout}${e.stderr}${e.message}`.includes(key), false);
    }
  });
});

// ---- end to end on ganache ----------------------------------------------------------------

describe('e2e: the real 8x8 board and a real FabX miner, mirrored and run unattended', () => {
  const WINDOW = 60, BOND = parseEther('0.001'), FEE = parseEther('0.0001');
  let provider, owner, treasury, factory, cpu, processor, oc, mainnet, dir, runsPath, statePath;

  const advance = async () => { await provider.send('evm_increaseTime', [WINDOW + 1]); await provider.send('evm_mine', []); };
  const events = [];
  const make = (over = {}) => new Runner({
    oc, signer: owner, provider, source: mainnet, mode: 'mirror', local: { circuits: cpu.circuits, transistors: cpu.transistors },
    queue, statePath, runsPath, fee: FEE, floor: parseEther('1'), reserve: parseEther('1'), maxPerDay: parseEther('500'),
    maxSteps: 2_000_000, pollMs: 0, sleep: advance, log: (e) => events.push(e), ...over,
  });
  const queue = buildQueue(census).filter((q) => q.key === OKSPACE || q.key === MINER);

  before(async () => {
    provider = new BrowserProvider(ganache.provider({
      logging: { quiet: true }, chain: { hardfork: 'shanghai' }, miner: { blockGasLimit: 2_000_000_000, callGasLimit: 2_000_000_000 },
      wallet: { totalAccounts: 3, defaultBalance: 10_000 },
    }), undefined, { cacheTimeout: -1 });
    [owner, treasury] = await Promise.all([0, 1].map((i) => provider.getSigner(i)));
    const f = artifact('TapeOutFactoryLocal');
    factory = await new ContractFactory(f.abi, f.bytecode, owner).deploy();
    await factory.waitForDeployment();
    cpu = await createCPU(owner, await factory.getAddress(), { name: 'Runner', symbol: 'RUN', story: '', supply: 10_000_000, mintPrice: 1n });
    processor = (await cpu.circuits.getAddress()).toLowerCase();
    const o = artifact('Overclock');
    oc = await new ContractFactory(o.abi, o.bytecode, owner).deploy(BOND, WINDOW, await factory.getAddress(), await treasury.getAddress(), 200);
    await oc.waitForDeployment();
    mainnet = new JsonRpcProvider(MAINNET_RPC, undefined, { cacheTimeout: -1 });
    dir = tmp();
    runsPath = join(dir, 'runs.json');
    statePath = join(dir, 'state.json');
    writeFileSync(runsPath, JSON.stringify(seed));
  });

  test('runs the board, killed and resumed mid-job, then the miner as a certificate; runs.json is exact', async () => {
    assert.equal(queue.length, 2);
    assert.deepEqual(queue.map((q) => q.key), [OKSPACE, MINER], 'machine first, then the miner shape');
    const refs = { [MINER]: { processor: '0x87BFCa3494Aa228fF589ab9B642143A5e8c8F9a6', id: 820, name: 'the miner itself' } };

    // A: two cycles = mirror + post, then claim. Then the process "dies".
    const a = make({ refs, limit: 1 });
    await a.run({ maxCycles: 2 });
    assert.equal(Number(await oc.jobCount()), 1);
    let st = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.equal(st.items[OKSPACE].phase, 'claimed');
    let d = JSON.parse(readFileSync(runsPath, 'utf8'));
    assert.equal(d.runs.find((r) => r.id === `${st.chainId}:0`).status, 'claimed', 'in flight shows as claimed');

    // A crash right after the post transaction, before it was saved: the next process must not post twice.
    const lost = structuredClone(st);
    Object.assign(lost.items[OKSPACE], { phase: 'mirrored', claimedByMe: undefined });
    delete lost.items[OKSPACE].jobId;
    writeFileSync(statePath, JSON.stringify(lost));
    const b = make({ refs, limit: 1 });
    await b.run({ maxCycles: 1 });
    assert.equal(Number(await oc.jobCount()), 1, 'the posted job was found, not posted again');
    assert.equal(JSON.parse(readFileSync(statePath, 'utf8')).items[OKSPACE].jobId, 0);

    // C: a fresh process (no memory at all) finishes it, then walks on to the miner.
    const c = make({ refs });
    const out = await c.run();
    assert.equal(out.remaining, 0);
    st = JSON.parse(readFileSync(statePath, 'utf8'));
    assert.deepEqual(Object.values(st.items).map((i) => i.phase), ['done', 'done']);
    assert.equal(Number(await oc.jobCount()), 2);

    d = JSON.parse(readFileSync(runsPath, 'utf8'));
    assert.deepEqual(d.runs.slice(0, seed.runs.length), seed.runs, 'the three mainnet runs are untouched');
    assert.equal(d.schema, 1);
    const chain = st.chainId;
    const [board, miner] = ['0', '1'].map((j) => d.runs.find((r) => r.id === `${chain}:${j}`));

    for (const r of [board, miner]) {
      assert.equal(r.status, 'final');
      assert.equal(r.overclock.toLowerCase(), (await oc.getAddress()).toLowerCase());
      assert.equal(r.fee, '0.0001');
      assert.equal(r.bond, '0.001');
      assert.ok(r.steps > 0 && r.directGas > 0);
      assert.equal(r.gas.honestPath, r.gas.post + r.gas.claim + r.gas.finalize);
      assert.deepEqual(r.txs.map((t) => t.what), ['post job', 'claim', 'finalize']);
      assert.ok(r.txs.every((t) => /^0x[0-9a-f]{64}$/.test(t.tx) && t.gas > 0));
      assert.equal(r.steps, Number(await oc.traceSize(r.jobId)), 'steps are the contract trace size');
      assert.ok(Date.parse(r.postedAt) <= Date.parse(r.finalizedAt));
    }
    assert.deepEqual([board.circuit.processor, board.circuit.id, board.circuit.name], ['0xb00f10bb4b2f32c561bf90e205e543d0a2395971', 5, 'OKspace'], 'keyed by the mainnet circuit, not the mirror');
    assert.ok(board.beats > 23, 'more beats than one block allows (23)');
    assert.match(board.what, /testnet mirror/);

    // the settled result is the mainnet evaluator's result
    const j = await oc.jobs(0);
    assert.equal(j.finalized, true);

    assert.equal(miner.circuit.id, 820);
    assert.equal(miner.beats, 127, 'a certificate: 2^7 - 1 LFSR inputs');
    const cert = d.certificates.find((x) => x.runId === miner.id);
    assert.equal(cert.status, 'certified');
    assert.equal(cert.mismatches, 0);
    assert.equal(cert.inputs, 127);
    assert.deepEqual([cert.circuit.processor, cert.circuit.id], [MINER.split(':')[0], 820]);
    assert.equal(cert.reference.id, 820);
    assert.match(miner.outcome, /matches its reference on all 127 inputs/);
    console.log(`    board: ${board.beats} beats, ${board.steps} steps, honest path ${board.gas.honestPath} gas; miner certificate: ${cert.inputs} inputs, ${miner.steps} steps`);
  });

  test('a second pass changes nothing: idempotent', async () => {
    const before = readFileSync(runsPath, 'utf8');
    const jobs = Number(await oc.jobCount());
    const out = await make().run();
    assert.equal(out.remaining, 0);
    assert.equal(Number(await oc.jobCount()), jobs);
    assert.equal(JSON.parse(readFileSync(runsPath, 'utf8')).runs.length, JSON.parse(before).runs.length);
  });

  test('the state file belongs to one chain and contract', async () => {
    const wrong = join(dir, 'other-state.json');
    writeFileSync(wrong, JSON.stringify({ version: 1, chainId: 1, overclock: '0x' + '0'.repeat(40), items: {}, days: {} }));
    await assert.rejects(make({ statePath: wrong }).run(), /belongs to chain 1/);
  });

  test('the floor pauses the runner before any transaction', async () => {
    const s = join(tmp(), 'state.json');
    const jobs = Number(await oc.jobCount());
    const r = make({ statePath: s, runsPath: join(tmp(), 'r.json'), floor: parseEther('1000000') });
    const out = await r.run();
    assert.match(out.paused, /under the floor/);
    assert.equal(Number(await oc.jobCount()), jobs);
    assert.deepEqual(JSON.parse(readFileSync(s, 'utf8')).items, {});
  });

  test('the daily cap lets the first item finish and stops the second', async () => {
    const s = join(tmp(), 'state.json'), rp = join(tmp(), 'r.json');
    const before = Number(await oc.jobCount());
    const r = make({ statePath: s, runsPath: rp, maxPerDay: 1n });
    const out = await r.run();
    assert.match(out.paused, /daily cap/);
    assert.equal(out.remaining, 1);
    const items = JSON.parse(readFileSync(s, 'utf8')).items;
    assert.deepEqual(Object.keys(items), [OKSPACE]);
    assert.equal(items[OKSPACE].phase, 'done', 'a job in flight is always seen through');
    assert.equal(Number(await oc.jobCount()), before + 1);
  });
});
