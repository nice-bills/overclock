// Reading circuits from a processor contract, and the Overclock ABI helpers shared by the bots.

import { Contract } from 'ethers';
import { readFileSync } from 'node:fs';
import { decode, load, hexToBytes, unpack, REF } from './tap02.js';

export const CIRCUITS_ABI = [
  'function netlist(uint256 id) view returns (bytes)',
  'function circuitInfo(uint256 id) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)',
];

export const artifact = (name) => JSON.parse(readFileSync(new URL(`../build/${name}.json`, import.meta.url)));

// Fetch (cpu, id) and every circuit it REFs, then load it with the TAP-02 evaluator.
export async function loadCircuit(runner, cpu, id, cache = new Map()) {
  const key = (a, i) => `${a.toLowerCase()}:${BigInt(i)}`;
  const raw = new Map();
  const fetch = async (a, i) => {
    const k = key(a, i);
    if (raw.has(k) || cache.has(k)) return;
    const p = new Contract(a, CIRCUITS_ABI, runner);
    const [nl, info] = await Promise.all([p.netlist(i), p.circuitInfo(i)]);
    const bytes = hexToBytes(nl);
    raw.set(k, { bytes, nIn: Number(info.nIn), nOut: Number(info.nOut) });
    for (const e of decode(bytes, Number(info.nIn))) if (e.op === REF) await fetch(e.cpu, e.id);
  };
  await fetch(cpu, id);
  const resolve = (a, i) => {
    const k = key(a, i);
    if (cache.has(k)) return cache.get(k);
    const r = raw.get(k);
    if (!r) return null;
    const c = load(r.bytes, r.nIn, r.nOut, resolve);
    cache.set(k, c);
    return c;
  };
  return resolve(cpu, id);
}

// Overclock.jobs(i) as plain JS, with the job's inputs and state unpacked to bits.
export async function readJob(oc, jobId) {
  const j = await oc.jobs(jobId);
  const job = {
    jobId: BigInt(jobId),
    cpu: j.cpu,
    id: j.id,
    beats: Number(j.beats),
    perBeat: j.perBeat,
    nIn: Number(j.nIn),
    nOut: Number(j.nOut),
    nState: Number(j.nState),
    flat: Number(j.flat),
    fee: j.fee,
    claimant: j.claimant,
    traceRoot: j.traceRoot,
    outputs: j.outputs,
    newState: j.newState,
    claimedAt: Number(j.claimedAt),
    challenged: j.challenged,
    finalized: j.finalized,
  };
  job.inputBits = unpack(hexToBytes(j.inputs), job.perBeat ? job.beats * job.nIn : job.nIn);
  job.stateBits = unpack(hexToBytes(j.state), job.nState);
  return job;
}

export async function readGame(oc, gameId) {
  const g = await oc.games(gameId);
  return { gameId: BigInt(gameId), jobId: g.jobId, challenger: g.challenger, level: Number(g.level), index: Number(g.index), node: g.node, turn: Number(g.turn), deadline: Number(g.deadline) };
}

export const Turn = { Claimant: 0, Challenger: 1, Leaf: 2 };
export const CLOSED = 255;
