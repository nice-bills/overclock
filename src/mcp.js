// Overclock as an MCP server: the tools an AI agent needs to read jobs, check claims, post work,
// run as an operator or a watcher, and tape out circuits on TapeOut.
//
// Read-only tools always work, with no wallet. Tools that send transactions go through the user's
// own wallet: connect_wallet gives a local approval page where they connect OKX Wallet or MetaMask
// and approve each transaction (see wallet.js). A private key (OVERCLOCK_PRIVATE_KEY) is an opt-in
// fallback for unattended use.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Contract, formatEther, parseEther } from 'ethers';
import { artifact, loadCircuit, readJob, readGame, CLOSED } from './chain.js';
import { traceJob, Tree, layout } from './trace.js';
import { pack, unpack, bytesToHex, hexToBytes, NAND, LATCH, REF } from './tap02.js';
import { Operator, Challenger } from './agents.js';
import { createCPU, mint, burnCost, tapeout, CIRCUITS_FULL_ABI, TRANSISTORS_ABI, XLAYER } from './tapeout.js';
import { cellCircuit, boardCircuit } from './life.js';
import { labelled } from './wallet.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const hex = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, 'a 0x-prefixed hex string of whole bytes');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'a 0x-prefixed address');
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e.shortMessage ?? e.reason ?? e.message ?? String(e) }] });
const safe = (fn) => async (args) => { try { return ok(await fn(args ?? {})); } catch (e) { return fail(e); } };
const bitsOf = (h, n) => unpack(hexToBytes(h), n);
const bitString = (bits) => bits.join('');

// ctx: { provider, overclock (address), factory (optional address),
//        wallet (a WalletBridge, or null), signer (a key-backed Signer, or null), readOnly }
// Long-lived helpers (circuit cache, the watcher's open games) live on ctx so HTTP mode, which
// builds a server per request, keeps them between calls.
export function createServer(ctx) {
  const server = new McpServer({ name: 'overclock', version: '0.3.0' }, {
    instructions: [
      'Overclock runs TapeOut circuits on X Layer far beyond what fits in a block: an operator runs the job off-chain and posts the result with a bond; anyone can re-run it and, if it is wrong, prove the one wrong gate on-chain and take the bond.',
      'Bit vectors (inputs, state, outputs) are TAP-02 packed hex: bit i is (byte[i>>3] >> (i&7)) & 1. Amounts are in OKB (decimal strings).',
      'Typical flows: inspect with overclock_info, list_jobs, get_job, describe_circuit; check someone else\'s result with verify_claim before relying on it; preview a job for free with run_locally; then post_job / claim_job / challenge_claim / finalize_job.',
      'Transactions are approved by the user in their own wallet. If a transaction tool says no wallet is connected, call connect_wallet and give the user the link it returns; they open it once, connect OKX Wallet or MetaMask, and keep it open. Never ask the user for a private key.',
    ].join('\n'),
  });
  ctx.circuitCache ??= new Map();
  // Without an Overclock address only the TapeOut tools (circuits, local runs, tapeouts) are offered.
  const oc = ctx.overclock ? new Contract(ctx.overclock, artifact('Overclock').abi, ctx.provider) : null;
  const ocTool = oc ? server.registerTool.bind(server) : () => {};
  const circuit = (cpu, id) => loadCircuit(ctx.provider, cpu, BigInt(id), ctx.circuitCache);
  const now = async () => Number((await ctx.provider.send('eth_getBlockByNumber', ['latest', false])).timestamp);
  const params = async () => (ctx.params ??= {
    bond: await oc.bond(), window: Number(await oc.window()), feeBps: Number(await oc.feeBps()), factory: await oc.factory(),
  });

  function status(j, t, window) {
    if (j.finalized) return 'final';
    if (j.claimant === ZERO) return 'open';
    if (j.challenged) return 'disputed';
    return t >= j.claimedAt + window ? 'ready to finalize' : 'claimed';
  }

  async function summary(jobId) {
    const j = await readJob(oc, jobId);
    const { window } = await params();
    const t = await now();
    return {
      jobId: Number(jobId), status: status(j, t, window), processor: j.cpu, circuitId: Number(j.id), beats: j.beats,
      fee: formatEther(j.fee), claimant: j.claimant === ZERO ? null : j.claimant,
      challengeWindowEndsIn: j.claimant !== ZERO && !j.finalized ? Math.max(0, j.claimedAt + window - t) : null,
    };
  }

  // ------------------------------------------------------------------ read-only

  ocTool('overclock_info', {
    title: 'Overclock deployment',
    description: 'Network, contract addresses, bond, challenge window, protocol fee, number of jobs, and the configured wallet (if any).',
    inputSchema: {},
  }, safe(async () => {
    const p = await params();
    const net = await ctx.provider.getNetwork();
    return {
      chainId: Number(net.chainId), block: await ctx.provider.getBlockNumber(), overclock: ctx.overclock,
      tapeoutFactory: p.factory, bond: formatEther(p.bond), challengeWindowSeconds: p.window, protocolFeeBps: p.feeBps,
      jobs: Number(await oc.jobCount()),
      wallet: await walletInfo(),
    };
  }));

  ocTool('list_jobs', {
    title: 'List jobs',
    description: 'Jobs on Overclock, newest first, with their status (open, claimed, disputed, ready to finalize, final).',
    inputSchema: { status: z.enum(['open', 'claimed', 'disputed', 'ready to finalize', 'final', 'any']).default('any'), limit: z.number().int().min(1).max(100).default(20) },
  }, safe(async ({ status: want = 'any', limit = 20 }) => {
    const n = Number(await oc.jobCount());
    const out = [];
    for (let i = n - 1; i >= 0 && out.length < limit; i--) {
      const s = await summary(i);
      if (want === 'any' || s.status === want) out.push(s);
    }
    return { total: n, jobs: out };
  }));

  ocTool('get_job', {
    title: 'Get a job',
    description: 'Everything about one job: circuit, beats, inputs and starting state, the claim, and the result (outputs of the last beat and final state) as bits once claimed.',
    inputSchema: { jobId: z.number().int().min(0) },
  }, safe(async ({ jobId }) => {
    const j = await readJob(oc, jobId);
    const raw = await oc.jobs(jobId);
    return {
      ...(await summary(jobId)),
      poster: raw.poster, continuesJob: raw.parent > 0n ? Number(raw.parent) - 1 : null,
      perBeatInputs: j.perBeat, nIn: j.nIn, nOut: j.nOut, nState: j.nState,
      inputs: raw.inputs, startState: raw.state,
      traceLeaves: j.beats * (j.flat + j.nState), traceRoot: j.claimant === ZERO ? null : j.traceRoot,
      claimedOutputs: j.claimant === ZERO ? null : { hex: j.outputs, bits: bitString(bitsOf(j.outputs, j.nOut)) },
      claimedFinalState: j.claimant === ZERO ? null : { hex: j.newState, bits: bitString(bitsOf(j.newState, j.nState)) },
    };
  }));

  server.registerTool('describe_circuit', {
    title: 'Describe a TapeOut circuit',
    description: 'Pins, state bits, gates (flattened through REFs), the REF calls it makes, and how big one beat is for Overclock. Reads the netlist from the processor contract.',
    inputSchema: { processor: address.describe('the TapeOut circuits contract (processor) address'), circuitId: z.number().int().min(1) },
  }, safe(async ({ processor, circuitId }) => {
    const c = await circuit(processor, circuitId);
    const els = c.elements;
    const L = layout(c, 1);
    return {
      nIn: c.nIn, nOut: c.nOut, nState: c.nState, gatesFlattened: c.nGates,
      records: { nand: els.filter((e) => e.op === NAND).length, latch: els.filter((e) => e.op === LATCH).length, ref: els.filter((e) => e.op === REF).length },
      refs: [...new Set(els.filter((e) => e.op === REF).map((e) => `${e.cpu}#${e.id}`))],
      traceLeavesPerBeat: L.B,
      estimatedStepGas: 50_000 + 2_500 * c.nGates,
      note: 'estimatedStepGas uses TapeOut\'s measured ~2.5K gas per gate; X Layer blocks hold 210M gas.',
    };
  }));

  server.registerTool('run_locally', {
    title: 'Run a circuit locally',
    description: 'Run beats of a circuit off-chain with the TAP-02 evaluator, for free. Returns the outputs of the last beat, the final state and the trace root an honest claim would commit to.',
    inputSchema: {
      processor: address, circuitId: z.number().int().min(1), beats: z.number().int().min(1).max(100000).default(1),
      state: hex.default('0x').describe('starting state, packed'), inputs: hex.default('0x').describe('one beat of inputs, or every beat\'s when perBeat'),
      perBeat: z.boolean().default(false),
    },
  }, safe(async ({ processor, circuitId, beats = 1, state = '0x', inputs = '0x', perBeat = false }) => {
    const c = await circuit(processor, circuitId);
    const started = Date.now();
    const t = traceJob(c, { state: bitsOf(state, c.nState), inputs: bitsOf(inputs, perBeat ? beats * c.nIn : c.nIn), beats, perBeat });
    const tree = new Tree(t.leaves);
    return {
      outputs: { hex: bytesToHex(pack(t.outputs)), bits: bitString(t.outputs) },
      finalState: { hex: bytesToHex(pack(t.newState)), bits: bitString(t.newState) },
      traceRoot: tree.root, traceLeaves: t.n, ms: Date.now() - started,
    };
  }));

  ocTool('verify_claim', {
    title: 'Verify a claim',
    description: 'Re-run a claimed job independently and say whether the claim is correct. Use this before relying on a result that has not finalized yet. Free.',
    inputSchema: { jobId: z.number().int().min(0) },
  }, safe(async ({ jobId }) => {
    const j = await readJob(oc, jobId);
    if (j.claimant === ZERO) return { jobId, verdict: 'no claim yet' };
    const c = await circuit(j.cpu, j.id);
    const t = traceJob(c, { state: j.stateBits, inputs: j.inputBits, beats: j.beats, perBeat: j.perBeat });
    const root = new Tree(t.leaves).root;
    const claimed = [...bitsOf(j.outputs, j.nOut), ...bitsOf(j.newState, j.nState)];
    const honest = [...t.outputs, ...t.newState];
    const k = honest.findIndex((v, i) => v !== claimed[i]);
    const verdict = root !== j.traceRoot ? 'wrong: the trace differs (challenge_claim will bisect to the wrong gate)'
      : k >= 0 ? `wrong: result bit ${k} does not match the claimant's own trace (challenge_claim disproves it in one transaction)`
        : 'correct';
    return { jobId, verdict, finalized: j.finalized, correctOutputs: bytesToHex(pack(t.outputs)), correctFinalState: bytesToHex(pack(t.newState)) };
  }));

  server.registerTool('life_circuits', {
    title: 'Game of Life netlists',
    description: 'TAP-02 netlists for Conway\'s Game of Life: a 57-gate cell rule and a w x h board that REFs it once per cell. Tape out the cell first, then the board with that processor and cell id.',
    inputSchema: { w: z.number().int().min(3).max(64).default(16), h: z.number().int().min(3).max(64).default(16), processor: address.default(ZERO), cellId: z.number().int().min(0).default(0) },
  }, safe(async ({ w = 16, h = 16, processor = ZERO, cellId = 0 }) => {
    const cell = cellCircuit();
    const bd = boardCircuit(w, h, processor.toLowerCase(), cellId);
    return { cell: { netlist: bytesToHex(cell.netlist), nIn: 9, nOut: 1 }, board: { netlist: bytesToHex(bd.netlist), nIn: 0, nOut: w * h, nState: w * h } };
  }));

  async function walletInfo() {
    if (ctx.signer) {
      const address = await ctx.signer.getAddress();
      return { mode: 'private key (OVERCLOCK_PRIVATE_KEY)', address, balance: formatEther(await ctx.provider.getBalance(address)) };
    }
    if (!ctx.wallet || ctx.readOnly) return 'none: read-only tools only';
    const s = ctx.wallet.status();
    return s.connected ? { ...s, balance: formatEther(await ctx.provider.getBalance(s.address)) } : { ...s, note: 'call connect_wallet' };
  }

  if (ctx.readOnly || (!ctx.signer && !ctx.wallet)) return server;

  // ------------------------------------------------------------------ wallet

  if (ctx.wallet && !ctx.signer) {
    server.registerTool('connect_wallet', {
      title: 'Connect the user\'s wallet',
      description: 'Returns a link to a local approval page. The user opens it, connects OKX Wallet or MetaMask, and keeps it open; every transaction a tool sends then pops up in their wallet to approve or reject. No private key is shared. Call with waitSeconds 0 to get the link, show it to the user, then call again with a wait to know when they have connected.',
      inputSchema: { waitSeconds: z.number().int().min(0).max(600).default(0) },
    }, safe(async ({ waitSeconds = 0 }) => {
      await ctx.ensureWallet?.();
      await ctx.wallet.waitConnected(waitSeconds * 1000);
      const s = ctx.wallet.status();
      return s.connected ? s : { ...s, next: `Ask the user to open ${s.approvalPage}, connect their wallet and keep the page open.` };
    }));
  }

  // ------------------------------------------------------------------ transactions

  // The signer for a transaction: the opt-in key, or the user's connected wallet.
  const signer = async () => {
    if (ctx.signer) return ctx.signer;
    await ctx.ensureWallet?.();
    await ctx.wallet.signer.getAddress(); // throws NotConnected, with the link, when nobody is connected
    return ctx.wallet.signer;
  };
  const ocw = async () => oc.connect(await signer());
  // Check for a wallet first, so an agent without one gets the connect link rather than an unrelated error.
  const tx = (name, fn) => safe((args) => labelled(name, async () => { await signer(); return fn(args); }));

  const send = async (p) => {
    const rc = await (await p).wait();
    return { tx: rc.hash, gas: Number(rc.gasUsed), rc };
  };
  const evArg = (rc, name, key) => rc.logs.map((l) => { try { return oc.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === name)?.args[key];

  ocTool('post_job', {
    title: 'Post a job',
    description: 'Ask the network to run a circuit for some beats. Pays `fee` OKB, which goes to whoever\'s claim finalizes (minus the protocol fee). Sends a transaction.',
    inputSchema: {
      processor: address, circuitId: z.number().int().min(1), beats: z.number().int().min(1).max(1_000_000),
      state: hex.default('0x'), inputs: hex.default('0x'), perBeat: z.boolean().default(false), fee: z.string().default('0.01'),
    },
  }, tx('post_job', async ({ processor, circuitId, beats, state = '0x', inputs = '0x', perBeat = false, fee = '0.01' }) => {
    const c = await circuit(processor, circuitId);
    const st = bytesToHex(pack(bitsOf(state, c.nState)));
    const ins = bytesToHex(pack(bitsOf(inputs, perBeat ? beats * c.nIn : c.nIn)));
    const r = await send((await ocw()).postJob(processor, circuitId, ins, st, beats, perBeat, { value: parseEther(fee) }));
    return { jobId: Number(evArg(r.rc, 'JobPosted', 'jobId')), tx: r.tx, gas: r.gas };
  }));

  ocTool('continue_job', {
    title: 'Continue a job',
    description: 'Run more beats of the same circuit starting from a finalized job\'s final state, so a stateful machine keeps going. Pays `fee` OKB. Sends a transaction.',
    inputSchema: { parentJobId: z.number().int().min(0), beats: z.number().int().min(1).max(1_000_000), inputs: hex.default('0x'), perBeat: z.boolean().default(false), fee: z.string().default('0.01') },
  }, tx('continue_job', async ({ parentJobId, beats, inputs = '0x', perBeat = false, fee = '0.01' }) => {
    const pj = await readJob(oc, parentJobId);
    const ins = bytesToHex(pack(bitsOf(inputs, perBeat ? beats * pj.nIn : pj.nIn)));
    const r = await send((await ocw()).continueJob(parentJobId, ins, beats, perBeat, { value: parseEther(fee) }));
    return { jobId: Number(evArg(r.rc, 'JobPosted', 'jobId')), tx: r.tx, gas: r.gas };
  }));

  ocTool('claim_job', {
    title: 'Claim a job as operator',
    description: 'Run an open job off-chain and claim its result, locking the bond. If nobody proves it wrong within the challenge window, finalize_job returns the bond plus the fee. The claim is defended automatically while this server runs (advance_disputes). Sends a transaction.',
    inputSchema: { jobId: z.number().int().min(0) },
  }, tx('claim_job', async ({ jobId }) => {
    ctx.operator ??= new Operator({ oc, signer: await signer(), name: 'operator', circuits: ctx.circuitCache, log: (e) => (ctx.log ??= []).push(e) });
    ctx.operator.only ??= new Set();
    ctx.operator.only.add(jobId);
    const before = (ctx.log ?? []).length;
    await ctx.operator.tick();
    const j = await readJob(oc, jobId);
    return { jobId, claimant: j.claimant, traceRoot: j.traceRoot, actions: (ctx.log ?? []).slice(before) };
  }));

  ocTool('challenge_claim', {
    title: 'Challenge a wrong claim',
    description: 'Re-run a claimed job and, if the claim is wrong, challenge it: either disprove a wrong result directly, or bisect the trace with the claimant down to the single wrong gate and prove it on-chain. Locks the bond; winning returns both bonds. Plays for up to waitSeconds, then returns; call advance_disputes to keep going. Sends transactions.',
    inputSchema: { jobId: z.number().int().min(0), waitSeconds: z.number().int().min(0).max(600).default(60) },
  }, tx('challenge_claim', async ({ jobId, waitSeconds = 60 }) => {
    ctx.watcher ??= new Challenger({ oc, signer: await signer(), name: 'watcher', circuits: ctx.circuitCache, log: (e) => (ctx.log ??= []).push(e) });
    ctx.watcher.only ??= new Set();
    ctx.watcher.only.add(jobId);
    return advance(waitSeconds);
  }));

  ocTool('advance_disputes', {
    title: 'Advance disputes',
    description: 'Make the next moves in every dispute this server is part of (as watcher or as operator), for up to waitSeconds. Sends transactions when it is our turn.',
    inputSchema: { waitSeconds: z.number().int().min(0).max(600).default(30) },
  }, tx('advance_disputes', async ({ waitSeconds = 30 }) => advance(waitSeconds)));

  async function advance(waitSeconds) {
    const before = (ctx.log ?? []).length;
    const deadline = Date.now() + waitSeconds * 1000;
    let open;
    do {
      if (ctx.watcher) await ctx.watcher.tick();
      if (ctx.operator) await ctx.operator.tick();
      open = ctx.watcher ? ctx.watcher.games.size : 0;
      if (open === 0) break;
      await new Promise((r) => setTimeout(r, 1500));
    } while (Date.now() < deadline);
    const games = [];
    for (const g of ctx.watcher?.games.keys() ?? []) {
      const s = await readGame(oc, g);
      games.push({ gameId: g, jobId: Number(s.jobId), level: s.level, waitingFor: ['claimant', 'us (challenger)', 'leaf check', 'nobody (settled)'][s.turn] });
    }
    return { actions: (ctx.log ?? []).slice(before), openDisputes: games };
  }

  ocTool('finalize_job', {
    title: 'Finalize a job',
    description: 'After the challenge window, make an unchallenged claim final: pays the claimant bond plus fee and makes the result readable by any contract. Anyone can call it. Sends a transaction.',
    inputSchema: { jobId: z.number().int().min(0) },
  }, tx('finalize_job', async ({ jobId }) => {
    const r = await send((await ocw()).finalize(jobId));
    const [outputs, newState] = await oc.result(jobId);
    return { jobId, tx: r.tx, gas: r.gas, outputs, finalState: newState };
  }));

  server.registerTool('create_processor', {
    title: 'Create a TapeOut processor',
    description: 'Create your own TapeOut processor (transistor and circuit contracts) through the TapeOut factory. Pays the factory\'s deploy fee (0.0066 OKB on X Layer). Sends a transaction.',
    inputSchema: { name: z.string().min(1), symbol: z.string().min(1), story: z.string().default(''), supply: z.number().int().min(1).default(1_000_000), mintPrice: z.string().default('0.00001') },
  }, tx('create_processor', async ({ name, symbol, story = '', supply = 1_000_000, mintPrice = '0.00001' }) => {
    const factory = ctx.factory ?? (oc ? (await params()).factory : XLAYER.factory);
    const { transistors, circuits, receipt } = await createCPU(await signer(), factory, { name, symbol, story, supply, mintPrice: parseEther(mintPrice) });
    return { processor: await circuits.getAddress(), transistors: await transistors.getAddress(), tx: receipt.hash };
  }));

  server.registerTool('tapeout_circuit', {
    title: 'Tape out a circuit',
    description: 'Tape out a TAP-02 netlist on a TapeOut processor. Mints any NAND/LATCH transistors you are missing (one burns per NAND and per LATCH record; REFs are free), then pays TAPEOUT_FEE (0.0013 OKB on X Layer). Returns the new circuit id. Sends transactions.',
    inputSchema: { processor: address, netlist: hex, nIn: z.number().int().min(0), nOut: z.number().int().min(1) },
  }, tx('tapeout_circuit', async ({ processor, netlist, nIn, nOut }) => {
    const me = await (await signer()).getAddress();
    const circuits = new Contract(processor, CIRCUITS_FULL_ABI, await signer());
    const transistors = new Contract(await circuits.transistors(), TRANSISTORS_ABI, await signer());
    const bytes = hexToBytes(netlist);
    const need = burnCost(bytes, nIn);
    const minted = {};
    for (const [id, kind] of [[0, 'nand'], [1, 'latch']]) {
      const missing = need[kind] - Number(await transistors.balanceOf(me, id));
      if (missing > 0) { await mint(transistors, id, missing); minted[kind] = missing; }
    }
    const t = await tapeout(circuits, { netlist: bytes, nIn, nOut });
    return { circuitId: Number(t.id), gatesFlattened: t.gateCount, nState: t.nState, burned: need, minted, tx: t.receipt.hash };
  }));

  return server;
}
