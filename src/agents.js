// The two off-chain roles. Each is a poll-driven state machine: call tick() as often as you like.
//
// Operator: claims open jobs (computing the trace with the TAP-02 evaluator), answers bisection
// steps on its claims, and finalizes them after the window. Pass `lie` to make it cheat.
//
// Challenger: re-runs every claim, challenges any whose trace root or result differs from its own,
// plays the bisection, and proves the one wrong step.

import { traceJob, Tree } from './trace.js';
import { depsOf, resultPos, Bisector } from './game.js';
import { pack, bytesToHex, hexToBytes, unpack } from './tap02.js';
import { loadCircuit, readJob, readGame, Turn, CLOSED } from './chain.js';

class Agent {
  constructor({ oc, signer, name, log = () => {}, circuits = new Map() }) {
    this.oc = oc.connect(signer);
    this.signer = signer;
    this.name = name;
    this.log = log;
    this.circuits = circuits;
    this.traces = new Map(); // `${jobId}:${variant}` -> { t, tree, c }
  }

  async now() {
    const b = await this.oc.runner.provider.send('eth_getBlockByNumber', ['latest', false]);
    return Number(b.timestamp);
  }

  async address() {
    return (this._addr ??= (await this.signer.getAddress()).toLowerCase());
  }

  async trace(job, fault = -1) {
    const k = `${job.jobId}:${fault}`;
    if (!this.traces.has(k)) {
      const c = await loadCircuit(this.oc.runner, job.cpu, job.id, this.circuits);
      const started = Date.now();
      const t = traceJob(c, { state: job.stateBits, inputs: job.inputBits, beats: job.beats, perBeat: job.perBeat, fault });
      const tree = new Tree(t.leaves);
      this.traces.set(k, { t, tree, c, ms: Date.now() - started });
    }
    return this.traces.get(k);
  }

  async send(what, fn, ...args) {
    const value = args.at(-1)?.value !== undefined ? args.pop() : undefined;
    const tx = await this.oc[fn](...args, ...(value ? [value] : []));
    const rc = await tx.wait();
    const events = rc.logs.map((l) => { try { return this.oc.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
    this.log({ who: this.name, what, fn, gas: Number(rc.gasUsed), tx: rc.hash, events: events.map((e) => ({ name: e.name, args: plain(e.args) })) });
    return { rc, events };
  }
}

const plain = (args) => Object.fromEntries(Object.entries(args.toObject()).map(([k, v]) => [k, typeof v === 'bigint' ? v.toString() : v]));

export class Operator extends Agent {
  // lie(job, layout) -> leaf index to corrupt, or -1 to be honest
  constructor(opts) {
    super(opts);
    this.lie = opts.lie ?? (() => -1);
    this.mine = new Map(); // jobId -> fault used
    this.skip = new Set();
  }

  async tick() {
    const me = await this.address();
    const bond = (this._bond ??= await this.oc.bond());
    const window = (this._window ??= Number(await this.oc.window()));
    const now = await this.now();
    const nJobs = Number(await this.oc.jobCount());
    for (let i = 0; i < nJobs; i++) {
      if (this.skip.has(i)) continue;
      const job = await readJob(this.oc, i);
      if (job.finalized) { this.skip.add(i); continue; }
      if (job.claimant === '0x0000000000000000000000000000000000000000') {
        const fault = this.lie(job, { flat: job.flat, block: job.flat + job.nState });
        if (fault === null) continue; // this operator passes on the job
        const { t, tree, ms } = await this.trace(job, fault);
        this.mine.set(i, fault);
        this.log({ who: this.name, what: fault >= 0 ? `computed ${t.n} leaves and corrupted leaf ${fault}` : `computed ${t.n} leaves`, ms });
        await this.send(fault >= 0 ? 'claims a wrong result' : 'claims the result', 'claim', i, tree.root, bytesToHex(pack(t.outputs)), bytesToHex(pack(t.newState)), { value: bond });
      } else if (job.claimant.toLowerCase() === me && !job.challenged && now >= job.claimedAt + window) {
        await this.send('finalizes', 'finalize', i);
        this.skip.add(i);
      }
    }
    const nGames = Number(await this.oc.gameCount());
    for (let g = 0; g < nGames; g++) {
      const game = await readGame(this.oc, g);
      if (game.level === CLOSED || game.turn !== Turn.Claimant) continue;
      const job = await readJob(this.oc, game.jobId);
      if (job.claimant.toLowerCase() !== me || !this.mine.has(Number(game.jobId))) continue;
      const { tree } = await this.trace(job, this.mine.get(Number(game.jobId)));
      const l = game.level - 1;
      await this.send(`reveals level ${game.level}`, 'reveal', g, tree.node(l, 2 * game.index), tree.node(l, 2 * game.index + 1));
    }
  }
}

export class Challenger extends Agent {
  constructor(opts) {
    super(opts);
    this.checked = new Set(); // `${jobId}:${traceRoot}:${claimedAt}`
    this.games = new Map(); // gameId -> Bisector
  }

  async tick() {
    const me = await this.address();
    const bond = (this._bond ??= await this.oc.bond());
    const window = (this._window ??= Number(await this.oc.window()));
    const now = await this.now();
    const nJobs = Number(await this.oc.jobCount());
    for (let i = 0; i < nJobs; i++) {
      const job = await readJob(this.oc, i);
      if (job.finalized || job.challenged || job.claimant === '0x0000000000000000000000000000000000000000') continue;
      if (now >= job.claimedAt + window) continue;
      const key = `${i}:${job.traceRoot}:${job.claimedAt}`;
      if (this.checked.has(key)) continue;
      this.checked.add(key);
      const { t, tree, c } = await this.trace(job);
      if (tree.root !== job.traceRoot) {
        this.log({ who: this.name, what: `re-ran job ${i}: trace root differs, challenging` });
        const { events } = await this.send('challenges', 'challenge', i, { value: bond });
        const gameId = events.find((e) => e.name === 'Challenged').args.gameId;
        this.games.set(Number(gameId), new Bisector(tree));
        continue;
      }
      const claimed = [...unpack(hexToBytes(job.outputs), job.nOut), ...unpack(hexToBytes(job.newState), job.nState)];
      const honest = [...t.outputs, ...t.newState];
      const k = honest.findIndex((v, idx) => v !== claimed[idx]);
      if (k < 0) {
        this.log({ who: this.name, what: `re-ran job ${i}: claim is correct` });
        continue;
      }
      const pos = resultPos(c, job.beats, k);
      this.log({ who: this.name, what: `re-ran job ${i}: trace is right but result bit ${k} is not` });
      await this.send('disputes the result', 'disputeOutput', i, k, [{ pos, bit: t.leaves[pos], siblings: tree.proof(pos) }], { value: bond });
    }
    for (const [g, bis] of this.games) {
      const game = await readGame(this.oc, g);
      if (game.level === CLOSED) { this.games.delete(g); continue; }
      if (game.challenger.toLowerCase() !== me) continue;
      if (game.turn === Turn.Challenger) {
        const [left, right] = await this.oc.pending(g);
        const goLeft = bis.choose(game.level, game.index, left, right);
        await this.send(`picks ${goLeft ? 'left' : 'right'} at level ${game.level}`, 'pick', g, !goLeft);
      } else if (game.turn === Turn.Leaf) {
        const job = await readJob(this.oc, game.jobId);
        const { t, c } = await this.trace(job);
        const q = game.index;
        const deps = q < t.n ? depsOf(c, q, job.beats).map((pos) => ({ pos, bit: t.leaves[pos], siblings: bis.siblings(pos, q) })) : [];
        this.log({ who: this.name, what: `narrowed the dispute to leaf ${q}`, leaf: q, deps: deps.length });
        await this.send('proves the wrong step', 'resolveLeaf', g, deps);
        this.games.delete(g);
      } else if (game.turn === Turn.Claimant && now > game.deadline) {
        await this.send('claims a timeout', 'timeout', g);
        this.games.delete(g);
      }
    }
  }
}
