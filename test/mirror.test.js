// B4: mirror a mainnet TapeOut circuit graph into a TapeOutLocal stand-in.
//
// Unit tests cover the REF rewriting itself. The end-to-end test mirrors the real 8x8 Game of Life
// board (processor 0xb00f…#4 cell, #5 board, 64 REFs) from X Layer mainnet into ganache, checks the
// mirror reproduces mainnet job 0 bit for bit, and settles an Overclock job on it.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import ganache from 'ganache';
import { BrowserProvider, JsonRpcProvider, Contract, ContractFactory, parseEther } from 'ethers';
import { bytesToHex, decode, hexToBytes, load, pack, unpack, LATCH, NAND, REF } from '../src/tap02.js';
import { traceJob, Tree } from '../src/trace.js';
import { artifact, loadCircuit } from '../src/chain.js';
import { createCPU } from '../src/tapeout.js';
import { Builder } from '../src/hdl.js';
import {
  MAINNET_RPC, XLAYER_LIFE,
  collectCircuits, mirrorCircuit, previewMapping, refKey, rewriteRefs, sameNetlistExceptRefs,
} from '../src/mirror.js';

const run = promisify(execFile);
const live = JSON.parse(readFileSync(new URL('../web/live-run.json', import.meta.url)));
const W = 8, H = 8, BEATS = 40;
const BOND = parseEther('0.1'), WINDOW = 3600, FEE = parseEther('0.01');
const MAINNET_OVERCLOCK = '0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710';

const SOURCE = '0x' + '11'.repeat(20);
const TARGET = '0x' + '22'.repeat(20);
const short = (a) => `${a.slice(0, 8)}…${a.slice(-4)}`;

// Two REFs: a 64-bit id and a small one, with different pin counts.
function twoRefs() {
  const b = new Builder(2);
  const big = b.ref(SOURCE, 0x0102030405060708n, 1, [b.in[0]]);
  const small = b.ref(SOURCE, 7n, 2, [b.in[1], big[0]]);
  return b.build([...small]); // the second REF's outputs are the last signals
}

describe('REF rewriting', () => {
  test('rewrites processor and 64-bit id, and copies every other byte', () => {
    const { netlist, nIn } = twoRefs();
    const before = bytesToHex(netlist);
    const sourceRefs = decode(netlist, nIn).filter((e) => e.op === REF);
    assert.deepEqual(sourceRefs.map((e) => e.id), [0x0102030405060708n, 7n]);
    assert.deepEqual(sourceRefs.map((e) => e.cpu), [SOURCE, SOURCE]);

    const mapping = new Map([
      [refKey(SOURCE, 0x0102030405060708n), { processor: TARGET, id: 9n }],
      [refKey(SOURCE, 7n), [TARGET, 12n]], // array form works too
    ]);
    const out = rewriteRefs(netlist, nIn, mapping);
    assert.equal(bytesToHex(netlist), before, 'the source netlist was not mutated');
    assert.deepEqual([...out.subarray(0, 1)], [netlist[0]], 'opcode unchanged');
    assert.equal(sameNetlistExceptRefs(netlist, out), true);

    const rewritten = decode(out, nIn).filter((e) => e.op === REF);
    assert.deepEqual(rewritten.map((e) => e.cpu), [TARGET, TARGET]);
    assert.deepEqual(rewritten.map((e) => e.id), [9n, 12n]);
    assert.deepEqual(rewritten.map((e) => e.ins), sourceRefs.map((e) => e.ins), 'pin wiring unchanged');
    assert.deepEqual(rewritten.map((e) => e.nOut), sourceRefs.map((e) => e.nOut));

    const bumped = Uint8Array.from(netlist);
    bumped[31] ^= 1; // a REF input pin, not its target
    assert.equal(sameNetlistExceptRefs(netlist, bumped), false);
    assert.equal(sameNetlistExceptRefs(netlist, netlist.subarray(0, netlist.length - 1)), false);
  });

  test('accepts a plain-object mapping and leaves NAND/LATCH records untouched', () => {
    const b = new Builder(1);
    const x = b.not(b.in[0]);
    const y = b.ref(SOURCE, 5n, 1, [x]);
    const { netlist } = b.build([...y]);
    const mapping = { [refKey(SOURCE, 5n)]: { processor: TARGET, id: 1n } };
    const out = rewriteRefs(netlist, 1, mapping);
    const src = decode(netlist, 1), dst = decode(out, 1);
    assert.deepEqual(dst.filter((e) => e.op !== REF), src.filter((e) => e.op !== REF));
    assert.equal(dst.find((e) => e.op === REF).id, 1n);
    const high = rewriteRefs(netlist, 1, { [refKey(SOURCE, 5n)]: { processor: TARGET, id: 0xffffffffffffffffn } });
    assert.equal(decode(high, 1).find((e) => e.op === REF).id, 0xffffffffffffffffn);
    assert.throws(() => rewriteRefs(netlist, 1, { [refKey(SOURCE, 5n)]: { processor: TARGET, id: 1n << 64n } }), /out of range/);
  });

  test('rejects a REF whose mirror is missing, a malformed netlist, and a bad address', () => {
    const { netlist, nIn } = twoRefs();
    assert.throws(() => rewriteRefs(netlist, nIn, new Map()), /has no mirror/);
    assert.throws(() => rewriteRefs(netlist, nIn, new Map([[refKey(SOURCE, 7n), { processor: TARGET, id: 1n }]])), /has no mirror/);
    assert.throws(() => rewriteRefs(new Uint8Array([NAND, 0, 0]), 1), /truncated/);
    assert.throws(() => rewriteRefs(new Uint8Array([9]), 0), /unknown opcode/);
    const bad = new Map([[refKey(SOURCE, 7n), { processor: 'nope', id: 1n }], [refKey(SOURCE, 0x0102030405060708n), { processor: TARGET, id: 2n }]]);
    assert.throws(() => rewriteRefs(netlist, nIn, bad), /not an address/);
  });

  test('collectCircuits returns dependencies first, once each, and detects cycles', async () => {
    const A = '0x' + 'aa'.repeat(20), B = '0x' + 'bb'.repeat(20);
    const circuitOf = (processor, id, refs) => {
      const b = new Builder(0);
      let outs = refs.map((r) => b.ref(r.processor, r.id, 1, [])[0]);
      if (!outs.length) outs = [b.nand(b.zero, b.one)];
      const built = b.build(outs);
      return {
        processor, id: BigInt(id), nIn: 0, nOut: built.nOut, nState: 0,
        gateCount: decode(built.netlist, 0).length, netlist: built.netlist,
        refs: decode(built.netlist, 0).filter((e) => e.op === REF).map((e) => ({ processor: e.cpu.toLowerCase(), id: e.id })),
      };
    };
    const graph = new Map([
      [refKey(A, 1n), circuitOf(A, 1n, [])],
      [refKey(B, 1n), circuitOf(B, 1n, [{ processor: A, id: 1n }])],
      [refKey(A, 3n), circuitOf(A, 3n, [{ processor: B, id: 1n }, { processor: B, id: 1n }, { processor: A, id: 1n }])],
    ]);
    const calls = [];
    const fetch = async (cpu, id) => {
      calls.push(refKey(cpu, id));
      return graph.get(refKey(cpu, id));
    };
    const { root, order } = await collectCircuits(null, A, 3n, { fetch });
    assert.equal(root.id, 3n);
    assert.deepEqual(order.map((c) => refKey(c.processor, c.id)), [refKey(A, 1n), refKey(B, 1n), refKey(A, 3n)]);
    assert.equal(calls.length, 3, 'a repeated REF is fetched once');

    const preview = previewMapping(order, TARGET, 5n);
    assert.deepEqual([...preview.values()].map((v) => v.id), [5n, 6n, 7n]);

    const cyc = new Map([
      [refKey(A, 1n), circuitOf(A, 1n, [{ processor: B, id: 1n }])],
      [refKey(B, 1n), circuitOf(B, 1n, [{ processor: A, id: 1n }])],
    ]);
    await assert.rejects(collectCircuits(null, A, 1n, { fetch: async (c, i) => cyc.get(refKey(c, i)) }), /REF cycle/);
  });
});

describe('mainnet 8x8 Life board mirrored into TapeOutLocal', () => {
  let provider, owner, claimant, treasury, factory, cpu, localCpu, mirror, boardId;
  let mainnet, mainnetJob, direct, copied, tree;

  before(async () => {
    provider = new BrowserProvider(ganache.provider({
      logging: { quiet: true },
      chain: { hardfork: 'shanghai' },
      miner: { blockGasLimit: 2_000_000_000, callGasLimit: 2_000_000_000 },
      wallet: { totalAccounts: 4, defaultBalance: 1000 },
    }), undefined, { cacheTimeout: -1 });
    [owner, claimant, treasury] = await Promise.all([0, 1, 2].map((i) => provider.getSigner(i)));

    const a = artifact('TapeOutFactoryLocal');
    factory = await new ContractFactory(a.abi, a.bytecode, owner).deploy();
    await factory.waitForDeployment();
    cpu = await createCPU(owner, await factory.getAddress(), {
      name: 'Overclock Mirror', symbol: 'OCM', story: 'Mainnet mirror', supply: 1_000_000, mintPrice: 1n,
    });
    localCpu = (await cpu.circuits.getAddress()).toLowerCase();

    mainnet = new JsonRpcProvider(MAINNET_RPC, undefined, { cacheTimeout: -1 });
    mirror = await mirrorCircuit({
      provider: mainnet, processor: XLAYER_LIFE.processor, id: XLAYER_LIFE.boardId,
      circuits: cpu.circuits, transistors: cpu.transistors,
    });
    boardId = mirror.mapping.find((e) => e.from.id === XLAYER_LIFE.boardId).to.id;

    // The mainnet job 0 record: what actually settled on chain 196.
    const ocAbi = ['function jobs(uint256) view returns (address cpu, uint256 id, bytes inputs, bytes state, uint256 fee, uint32 beats, bool perBeat, uint32 nIn, uint32 nOut, uint64 nState, uint64 flat, address poster, uint256 parent, address claimant, bytes32 traceRoot, bytes outputs, bytes newState, uint64 claimedAt, uint32 openGames, bool finalized)'];
    mainnetJob = await new Contract(MAINNET_OVERCLOCK, ocAbi, mainnet).jobs(0);

    // The mainnet netlist run directly through src/tap02.js, and the mirrored netlist run the same way.
    const start = unpack(hexToBytes(live.generations[0]), W * H);
    assert.equal(bytesToHex(pack(start)), mainnetJob.state.toLowerCase(), 'the recorded start is mainnet job 0 state');
    direct = traceJob(await loadCircuit(mainnet, XLAYER_LIFE.processor, XLAYER_LIFE.boardId), { state: start, beats: BEATS });
    copied = traceJob(await loadCircuit(provider, localCpu, boardId), { state: start, beats: BEATS });
    tree = new Tree(copied.leaves);
  });

  test('copies #4 and #5 into the stand-in and rewires all 64 REFs', async () => {
    assert.deepEqual(mirror.order.map((c) => Number(c.id)), [4, 5], 'cell before the board');
    assert.equal(mirror.mapping.length, 2);
    const cellId = mirror.mapping.find((e) => e.from.id === 4n).to.id;
    assert.equal(mirror.mapping.find((e) => e.from.id === 5n).to.id, boardId);
    assert.notEqual(Number(cellId), 4, 'local ids are assigned fresh');

    const info = await cpu.circuits.circuitInfo(boardId);
    assert.deepEqual([Number(info.nIn), Number(info.nOut), Number(info.nState), Number(info.gateCount)], [0, 64, 64, 3712]);
    const netlist = hexToBytes(await cpu.circuits.netlist(boardId));
    const refs = decode(netlist, 0).filter((e) => e.op === REF);
    assert.equal(refs.length, 64);
    for (const e of refs) {
      assert.equal(e.cpu, localCpu);
      assert.equal(e.id, cellId);
    }
    assert.equal(sameNetlistExceptRefs(mirror.order.find((c) => c.id === 5n).netlist, netlist), true, 'only REF targets changed');
    assert.equal(decode(netlist, 0).filter((e) => e.op === LATCH).length, 64);
  });

  test('the mirror reproduces mainnet job 0 and an Overclock job on it finalizes', async () => {
    assert.equal(mainnetJob.finalized, true);
    assert.equal(bytesToHex(pack(direct.outputs)), mainnetJob.outputs.toLowerCase());
    assert.equal(bytesToHex(pack(direct.newState)), mainnetJob.newState.toLowerCase());
    assert.equal(bytesToHex(pack(direct.newState)), live.generations[BEATS], 'matches web/live-run.json');
    assert.deepEqual(copied.newState, direct.newState);
    assert.deepEqual(copied.outputs, direct.outputs);
    assert.equal(tree.root, new Tree(direct.leaves).root, 'identical trace root');

    const a = artifact('Overclock');
    const oc = await new ContractFactory(a.abi, a.bytecode, owner).deploy(
      BOND, WINDOW, await factory.getAddress(), await treasury.getAddress(), 200,
    );
    await oc.waitForDeployment();
    const state = bytesToHex(hexToBytes(live.generations[0]));
    const post = await (await oc.postJob(localCpu, boardId, '0x', state, BEATS, false, { value: FEE })).wait();
    const jobId = Number(post.logs.map((l) => { try { return oc.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'JobPosted').args.jobId);
    const claim = await (await oc.connect(claimant).claim(
      jobId, tree.root, bytesToHex(pack(copied.outputs)), bytesToHex(pack(copied.newState)), { value: BOND },
    )).wait();
    assert.ok(claim.gasUsed > 0n);
    await provider.send('evm_increaseTime', [WINDOW + 1]);
    await provider.send('evm_mine', []);
    await (await oc.finalize(jobId)).wait();

    const j = await oc.jobs(jobId);
    assert.equal(j.finalized, true);
    const [outs, newState] = await oc.result(jobId);
    assert.equal(outs, mainnetJob.outputs.toLowerCase());
    assert.equal(newState, mainnetJob.newState.toLowerCase());
    assert.equal(newState, live.generations[BEATS]);
    assert.equal(bytesToHex(pack(unpack(hexToBytes(newState), W * H))), live.generations[BEATS]);
    console.log(`    mirrored ${short(localCpu)}#${boardId} reproduced mainnet job 0 (40 generations); Overclock job ${jobId} finalized`);
  });

  test('scripts/mirror.js --dry-run fetches, rewrites and prints the plan', async () => {
    const { stdout } = await run(process.execPath, ['scripts/mirror.js', '--dry-run'], { cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 120_000 });
    assert.match(stdout, /reading 0xb00f10bb4b2f32c561bf90e205e543d0a2395971#5/);
    assert.match(stdout, /#4: 9 in, 1 out, 0 state, 57 gates, 0 REFs/);
    assert.match(stdout, /#5: 0 in, 64 out, 64 state, 3712 gates, 64 REFs/);
    assert.match(stdout, /mirror plan \(dry run\), 2 circuits/);
    assert.match(stdout, /#5 -> 0x0{40}#2: 64 REFs rewired, rest of netlist unchanged/);
  });
});
