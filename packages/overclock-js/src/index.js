// overclock-js: post a TapeOut circuit job to Overclock, watch it settle, read a verified result.
//
//   const app = connect({ signer, overclock: '0x...' });
//   const { jobId } = await app.postJob({ processor, circuitId, beats: 1, inputs: [1, 0, 1], fee: 10n ** 16n });
//   await app.watchJob(jobId);            // resolves once an operator's claim has finalized
//   const { outputs } = await app.getResult(jobId);
//
// Everything heavy is the repository's own code (src/): the TAP-02 evaluator, the trace and its
// Merkle tree, the circuit reader and the job reader. This file only wraps them in a small API.

import { Contract } from 'ethers';
import { readJob, CIRCUITS_ABI } from '../../../src/chain.js';
import { Challenger } from '../../../src/agents.js';
import { pack, unpack, hexToBytes, bytesToHex } from '../../../src/tap02.js';
import { OVERCLOCK_ABI } from './abi.js';

export { OVERCLOCK_ABI };
// Re-exported so an app can go further (run its own operator or watcher) without a second import.
export { Operator, Challenger } from '../../../src/agents.js';
export { loadCircuit, readJob, artifact } from '../../../src/chain.js';
export { traceJob, Tree, layout, flatSize } from '../../../src/trace.js';
export { load, beat, pack, unpack, hexToBytes, bytesToHex } from '../../../src/tap02.js';

const ZERO = '0x0000000000000000000000000000000000000000';

/// Where a job is in its life. 'finalizable': the challenge window is over and nobody disputes the claim.
export const Status = Object.freeze({
  Unclaimed: 'unclaimed', // posted, no operator has claimed it (or its claim was overturned)
  Claimed: 'claimed', // claimed, inside the challenge window
  Challenged: 'challenged', // a dispute is open against the claim
  Finalizable: 'finalizable', // window over, no dispute: anyone can call finalize
  Finalized: 'finalized', // settled: the result is readable
});

export class NotFinalizedError extends Error {
  constructor(jobId, status) {
    super(`job ${jobId} is not final yet (status: ${status})`);
    this.name = 'NotFinalizedError';
    this.jobId = BigInt(jobId);
    this.status = status;
  }
}

// ---------------------------------------------------------------- bit vectors

// Bits as an array of 0/1 (or booleans), or already packed (hex string / bytes).
function toBits(v, n, what) {
  let bits;
  if (v === undefined || v === null) bits = [];
  else if (Array.isArray(v)) bits = v.map((x) => (x ? 1 : 0));
  else if (typeof v === 'string' || v instanceof Uint8Array) bits = unpack(typeof v === 'string' ? hexToBytes(v) : v, n);
  else throw new TypeError(`${what}: expected an array of bits or packed bytes`);
  if (bits.length > n) throw new RangeError(`${what}: ${bits.length} bits given, the circuit takes ${n}`);
  while (bits.length < n) bits.push(0);
  return bits;
}

const packed = (bits) => bytesToHex(pack(bits));

let localJobs = 0;

// ---------------------------------------------------------------- client

/// Connect to an Overclock deployment.
///   signer   an ethers Signer: needed to post jobs and to finalize
///   provider an ethers Provider: enough for everything that only reads (omit when a signer is given)
///   overclock address of the Overclock contract
///   abi      optional: the full ABI (build/Overclock.json) if you want `client.contract` to reach every method
///   stream   optional: options for the streaming trace engine used on very large jobs (src/stream-trace.js)
export function connect({ signer, provider, overclock, abi = OVERCLOCK_ABI, stream } = {}) {
  const runner = signer ?? provider;
  if (!runner) throw new TypeError('connect: pass a signer or a provider');
  if (!overclock) throw new TypeError('connect: pass the Overclock contract address');
  const oc = new Contract(overclock, abi, runner);
  const chain = runner.provider ?? runner;
  const circuitCache = new Map();
  // The repository's Challenger already knows how to recompute a trace (in memory, or streamed
  // when it is huge); we use it only for that and never let it send anything.
  const tracer = new Challenger({ oc, signer: runner, name: 'overclock-js', circuits: circuitCache, ...(stream ? { stream } : {}) });

  const chainTime = async () => Number((await chain.getBlock('latest')).timestamp);
  const needSigner = (what) => {
    if (!signer) throw new Error(`${what} sends a transaction: connect with a signer`);
  };
  const circuitInfo = async (processor, circuitId) => {
    const info = await new Contract(processor, CIRCUITS_ABI, runner).circuitInfo(circuitId);
    return { nIn: Number(info.nIn), nOut: Number(info.nOut), nState: Number(info.nState), gates: Number(info.gateCount) };
  };

  /// Post a job: run circuit `circuitId` of `processor` for `beats` beats.
  ///   inputs   bits (array of 0/1) or packed bytes. One beat's inputs, applied every beat; or, with
  ///            perBeat, beats * nIn bits (beat b's input i is bit b * nIn + i). Missing bits are 0.
  ///   state    starting state bits, default all 0
  ///   perBeat  default: true when `inputs` is an array longer than one beat's inputs
  ///   fee      wei paid to whoever's claim finalizes (the operator's reward); also sets the job's bond
  /// Returns { jobId, bond, txHash, receipt }: `bond` is what an operator or challenger has to put up.
  async function postJob({ processor, circuitId, beats = 1, inputs = [], state = [], perBeat, fee = 0n } = {}) {
    needSigner('postJob');
    if (!processor) throw new TypeError('postJob: processor is required');
    if (circuitId === undefined) throw new TypeError('postJob: circuitId is required');
    if (!Number.isInteger(beats) || beats < 1) throw new RangeError('postJob: beats must be a whole number, at least 1');
    const { nIn, nState } = await circuitInfo(processor, circuitId);
    const many = perBeat ?? (Array.isArray(inputs) && inputs.length > nIn);
    const inBits = toBits(inputs, many ? beats * nIn : nIn, 'inputs');
    const stBits = toBits(state, nState, 'state');
    const tx = await oc.postJob(processor, circuitId, packed(inBits), packed(stBits), beats, many, { value: BigInt(fee) });
    const receipt = await tx.wait();
    const ev = receipt.logs.map((l) => { try { return oc.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'JobPosted');
    if (!ev) throw new Error(`postJob: transaction ${receipt.hash} emitted no JobPosted event`);
    const jobId = ev.args.jobId;
    return { jobId, bond: await oc.bondFor(jobId), txHash: receipt.hash, receipt };
  }

  /// The job as plain JS: what was posted, the current claim (if any) and its status.
  async function getJob(jobId) {
    const j = await readJob(oc, jobId);
    const now = await chainTime();
    const window = Number(await oc.window());
    const claimed = j.claimant !== ZERO;
    const windowEndsAt = claimed ? j.claimedAt + window : null;
    const status = j.finalized ? Status.Finalized
      : !claimed ? Status.Unclaimed
      : j.openGames > 0 ? Status.Challenged
      : now >= windowEndsAt ? Status.Finalizable
      : Status.Claimed;
    return {
      jobId: j.jobId,
      status,
      processor: j.cpu,
      circuitId: j.id,
      beats: j.beats,
      perBeat: j.perBeat,
      fee: j.fee,
      bond: await oc.bondFor(jobId),
      inputs: j.inputBits,
      state: j.stateBits,
      claimant: claimed ? j.claimant : null,
      traceRoot: claimed ? j.traceRoot : null,
      claimedAt: claimed ? j.claimedAt : null,
      windowEndsAt,
      openGames: j.openGames,
      // the claim as the operator made it: only a result once the job is final
      claimedOutputs: claimed ? unpack(hexToBytes(j.outputs), j.nOut) : null,
      claimedState: claimed ? unpack(hexToBytes(j.newState), j.nState) : null,
      finalized: j.finalized,
    };
  }

  /// Poll a job until it reaches `until` (a status or a list of them; default 'finalized').
  /// Calls onUpdate(job) whenever the status changes. Rejects on timeoutMs or when `signal` aborts.
  async function watchJob(jobId, { until = Status.Finalized, intervalMs = 2000, timeoutMs, signal, onUpdate } = {}) {
    const goals = [].concat(until);
    const started = Date.now();
    let last;
    for (;;) {
      signal?.throwIfAborted();
      const job = await getJob(jobId);
      if (job.status !== last) {
        last = job.status;
        onUpdate?.(job);
      }
      if (job.finalized || goals.includes(job.status)) return job; // a final job never changes again
      if (timeoutMs !== undefined && Date.now() - started >= timeoutMs) throw new Error(`watchJob: job ${jobId} still ${job.status} after ${timeoutMs} ms`);
      await new Promise((ok, no) => {
        const t = setTimeout(ok, intervalMs);
        signal?.addEventListener('abort', () => { clearTimeout(t); no(signal.reason); }, { once: true });
      });
    }
  }

  /// Settle a job whose challenge window is over. Anyone may call it; the claimant is paid.
  async function finalize(jobId) {
    needSigner('finalize');
    const receipt = await (await oc.finalize(jobId)).wait();
    return { txHash: receipt.hash, receipt };
  }

  /// The result of a finalized job: the last beat's outputs and the final state, as bits and as packed hex.
  /// Throws NotFinalizedError until the claim has settled. With verify: true it also recomputes the
  /// job on this machine and reports whether the settled result matches (`verified`).
  async function getResult(jobId, { verify = false } = {}) {
    const j = await readJob(oc, jobId);
    if (!j.finalized) throw new NotFinalizedError(jobId, (await getJob(jobId)).status);
    const [outputsHex, stateHex] = await oc.result(jobId);
    const res = {
      jobId: j.jobId,
      outputs: unpack(hexToBytes(outputsHex), j.nOut),
      newState: unpack(hexToBytes(stateHex), j.nState),
      outputsHex,
      newStateHex: stateHex,
      claimant: j.claimant,
    };
    if (verify) res.verified = (await verifyClaim(jobId)).verdict === 'honest';
    return res;
  }

  /// Run a circuit on this machine with the TAP-02 evaluator, no chain transaction. Either describe
  /// the job like postJob, or pass { jobId } to run a posted job exactly as posted. Returns
  /// { outputs, newState, traceRoot, leaves }: the root is what an honest claim commits to.
  async function runLocally(spec = {}) {
    let job;
    if (spec.jobId !== undefined) {
      job = await readJob(oc, spec.jobId);
    } else {
      const { processor, circuitId, beats = 1, inputs = [], state = [], perBeat } = spec;
      if (!processor || circuitId === undefined) throw new TypeError('runLocally: pass { processor, circuitId } or { jobId }');
      const { nIn, nOut, nState } = await circuitInfo(processor, circuitId);
      const many = perBeat ?? (Array.isArray(inputs) && inputs.length > nIn);
      job = {
        jobId: `local-${++localJobs}`, cpu: processor, id: BigInt(circuitId), beats, perBeat: many, nIn, nOut, nState,
        inputBits: toBits(inputs, many ? beats * nIn : nIn, 'inputs'),
        stateBits: toBits(state, nState, 'state'),
      };
    }
    try {
      const { t, tree } = await tracer.trace(job);
      return { outputs: t.outputs, newState: t.newState, outputsHex: packed(t.outputs), newStateHex: packed(t.newState), traceRoot: tree.root, leaves: t.n };
    } finally {
      tracer.forget(job.jobId);
    }
  }

  /// Check an operator's claim on a job by recomputing it: the same test the repository's challenger
  /// bot runs. 'honest': the trace root and the result both match. 'cheating': either differs
  /// (reason says which). 'no-claim': nobody has claimed the job.
  async function verifyClaim(jobId) {
    const job = await readJob(oc, jobId);
    if (job.claimant === ZERO) return { jobId: job.jobId, verdict: 'no-claim', reason: 'nobody has claimed this job' };
    try {
      const { t, tree } = await tracer.trace(job);
      const claimed = [...unpack(hexToBytes(job.outputs), job.nOut), ...unpack(hexToBytes(job.newState), job.nState)];
      const right = [...t.outputs, ...t.newState];
      const bad = right.findIndex((v, i) => v !== claimed[i]);
      const rootOk = tree.root.toLowerCase() === job.traceRoot.toLowerCase();
      return {
        jobId: job.jobId,
        verdict: rootOk && bad < 0 ? 'honest' : 'cheating',
        reason: !rootOk ? 'trace root differs from the recomputed trace' : bad >= 0 ? `result bit ${bad} differs from the recomputed result` : null,
        claimant: job.claimant,
        claimedRoot: job.traceRoot,
        computedRoot: tree.root,
        computed: { outputs: t.outputs, newState: t.newState },
      };
    } finally {
      tracer.forget(job.jobId);
    }
  }

  return { contract: oc, address: overclock, postJob, getJob, watchJob, finalize, getResult, runLocally, verifyClaim };
}
