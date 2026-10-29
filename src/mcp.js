// Overclock as an MCP server: the tools an AI agent needs to read jobs, check claims, post work,
// run as an operator or a watcher, and tape out circuits on TapeOut.
//
// Read-only tools always work, with no wallet. Tools that send transactions go through the user's
// own wallet: the tool hands back a link to an approval page where they connect OKX Wallet or
// MetaMask and approve (see wallet.js), and transaction_status picks up the result. A private key
// (OVERCLOCK_PRIVATE_KEY) is an opt-in fallback for unattended use.
//
// Ready-made machines (the 8x8 Game of Life board and the 4-bit CPU on X Layer) let people ask in
// plain words ("run a glider for 10 generations") without addresses or hex.

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { Contract, formatEther, parseEther } from 'ethers';
import { artifact, loadCircuit, readJob, readGame, CLOSED } from './chain.js';
import { traceJob, Tree, layout } from './trace.js';
import { pack, unpack, bytesToHex, hexToBytes, NAND, LATCH, REF } from './tap02.js';
import { Operator, Challenger } from './agents.js';
import { createCPU, mint, burnCost, tapeout, CIRCUITS_FULL_ABI, TRANSISTORS_ABI, XLAYER } from './tapeout.js';
import { cellCircuit, boardCircuit, board, PATTERNS, render } from './life.js';
import { worldStep } from './world.js';
import { toState, fromState, fibonacciMachine } from './cpu4.js';
import { labelled, txLink } from './wallet.js';

const ZERO = '0x0000000000000000000000000000000000000000';
const hex = z.string().regex(/^0x([0-9a-fA-F]{2})*$/, 'a 0x-prefixed hex string of whole bytes');
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, 'a 0x-prefixed address');
const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 1) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: e.shortMessage ?? e.reason ?? e.message ?? String(e) }] });
const safe = (fn) => async (args) => { try { return ok(await fn(args ?? {})); } catch (e) { return fail(e); } };
const bitsOf = (h, n) => unpack(hexToBytes(h), n);
const bitString = (bits) => bits.join('');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Ready-made machines anyone can run by name. Where they live depends on the network: on X Layer
// mainnet the circuits below; elsewhere deployments/<chainId>.json (scripts/deploy-stack.js) says.
export const MACHINES = {
  life: {
    processor: '0xb00f10bb4b2f32c561bf90e205e543d0a2395971', circuitId: 5, w: 8, h: 8,
    about: 'Conway\'s Game of Life on an 8x8 wrap-around board. One beat is one generation. Start from a named pattern.',
    state: ({ pattern = 'glider' }) => board(8, 8, [[PATTERNS[pattern], 1, 1]]),
    show: (bits) => ({ picture: render(bits, 8) }),
  },
  cpu: {
    processor: '0xb00f10bb4b2f32c561bf90e205e543d0a2395971', circuitId: 6,
    about: 'A 4-bit CPU running an 8-bit Fibonacci program. 16 beats compute the next Fibonacci number (mod 256).',
    state: () => toState(fibonacciMachine()),
    show: (bits) => { const m = fromState(bits); return { fibonacci: { previous: m.ram[0] | (m.ram[1] << 4), latest: m.ram[2] | (m.ram[3] << 4), note: 'mod 256' } }; },
  },
};

// ctx: { provider, overclock (address), factory (optional address),
//        wallet (a WalletBridge, or null), signer (a key-backed Signer, or null), readOnly }
// Long-lived helpers (circuit cache, the watcher's open games) live on ctx so HTTP mode, which
// builds a server per request, keeps them between calls.
export function createServer(ctx) {
  const server = new McpServer({ name: 'overclock', version: '0.4.0' }, {
    instructions: [
      'Overclock runs circuits on X Layer that are far too big for one block: someone runs the job off-chain and posts the result with a bond, and anyone who finds it wrong can prove the one wrong gate on-chain and take the bond.',
      'Users speak plainly. Ready-made machines need no addresses or hex: machine "life" (8x8 Game of Life; pattern glider, blinker, toad, lwss or rpentomino; beats = generations) and machine "cpu" (Fibonacci on a 4-bit CPU). For "show me", "try it" or "what would happen", use run_locally: it is free and instant. Use post_job only when they want it done on-chain.',
      'Transactions: call the tool directly, with no setup step. Within seconds it either returns the result or returns status "waiting for approval" with an approve link. Show that link to the user as one tappable link, say it opens their wallet (OKX Wallet or MetaMask) to approve, and that on a phone they can use phone.openInOkxWalletApp instead. When they say they approved (or after a short while), call transaction_status with the requestId. Never ask for a private key or seed phrase.',
      'Before a paid action, say in one line what it costs (post_job: the fee, default 0.0001 OKB, plus a little gas).',
      'Overclock World (when the network has one): a shared Red vs Blue Game of Life. world_status shows the board, world_forecast tries a move for free, world_place buys cells, world_advance moves it on, world_claim collects winnings. Show boards exactly as given, in a code block.',
      'Amounts are OKB as decimal strings. Raw bit vectors are TAP-02 packed hex (bit i is (byte[i>>3] >> (i&7)) & 1); only needed for circuits other than the ready-made machines.',
    ].join('\n'),
  });
  ctx.circuitCache ??= new Map();
  // Without an Overclock address only the TapeOut tools (circuits, local runs, tapeouts) are offered.
  const oc = ctx.overclock ? new Contract(ctx.overclock, artifact('Overclock').abi, ctx.provider) : null;
  const ocTool = oc ? server.registerTool.bind(server) : () => {};
  const circuit = (cpu, id) => loadCircuit(ctx.provider, cpu, BigInt(id), ctx.circuitCache);
  // this network's machines: the kinds above, at the addresses the deployment gives
  const machines = Object.fromEntries(Object.entries(MACHINES).map(([k, m]) => [k, { ...m, ...(ctx.machines?.[k] ?? {}), processor: String(ctx.machines?.[k]?.processor ?? m.processor).toLowerCase() }]));
  const machineOf = (processor, id) => Object.entries(machines).find(([, m]) => m.processor === String(processor).toLowerCase() && m.circuitId === Number(id));
  const machine = (j) => machineOf(j.cpu, j.id);
  // A ready-made machine by name, or an explicit processor and circuit id.
  const MACHINE_ARGS = {
    machine: z.enum(['life', 'cpu']).optional().describe('a ready-made machine; leave processor and circuitId out when using one'),
    pattern: z.enum(Object.keys(PATTERNS)).optional().describe('starting pattern for machine "life" (default glider)'),
    processor: address.optional().describe('the TapeOut circuits contract, for circuits other than the ready-made machines'),
    circuitId: z.number().int().min(1).optional(),
  };
  const pick = (a) => {
    if (a.processor && a.circuitId) return { processor: a.processor, circuitId: a.circuitId, state: a.state ?? '0x', m: machineOf(a.processor, a.circuitId)?.[1] };
    const m = machines[a.machine ?? 'life'];
    return { processor: m.processor, circuitId: m.circuitId, state: a.state ?? bytesToHex(pack(m.state(a))), m };
  };
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
      ...(machine(j) && j.claimant !== ZERO ? { machine: machine(j)[0], claimedResult: machine(j)[1].show(bitsOf(j.newState, j.nState)) } : {}),
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
    title: 'Run a machine (free)',
    description: 'Run a machine or circuit right now, off-chain and for free, and show the result. With no arguments it runs one generation of a glider on the Game of Life board. Use this whenever the user wants to see or try something; it costs nothing and needs no wallet.',
    inputSchema: {
      ...MACHINE_ARGS, beats: z.number().int().min(1).max(100000).default(1).describe('how many steps (generations for life)'),
      state: hex.optional().describe('starting state, packed hex; ready-made machines fill this in'), inputs: hex.default('0x').describe('one beat of inputs, or every beat\'s when perBeat'),
      perBeat: z.boolean().default(false),
    },
  }, safe(async (a) => {
    const { beats = 1, inputs = '0x', perBeat = false } = a;
    const { processor, circuitId, state, m } = pick(a);
    const c = await circuit(processor, circuitId);
    const started = Date.now();
    const t = traceJob(c, { state: bitsOf(state, c.nState), inputs: bitsOf(inputs, perBeat ? beats * c.nIn : c.nIn), beats, perBeat });
    const tree = new Tree(t.leaves);
    return {
      outputs: { hex: bytesToHex(pack(t.outputs)), bits: bitString(t.outputs) },
      finalState: { hex: bytesToHex(pack(t.newState)), bits: bitString(t.newState) },
      traceRoot: tree.root, traceLeaves: t.n, ms: Date.now() - started,
      ...(m ? { start: m.show(bitsOf(state, c.nState)), result: m.show(t.newState) } : {}),
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

  // ------------------------------------------------------------------ Overclock World

  // Red vs Blue on a shared 16x16 Life board (contracts/World.sol), when this network has one (ctx.world).
  const world = ctx.world && oc ? new Contract(ctx.world, artifact('World').abi, ctx.provider) : null;
  const worldTool = world ? server.registerTool.bind(server) : () => {};
  const WN = 256, TEAMS = { red: 1, blue: 2 }, TEAM_NAME = ['nobody', 'red', 'blue'];
  const cellsOf = (aliveMask, blueMask) => Array.from({ length: WN }, (_, k) => ((aliveMask >> BigInt(k)) & 1n ? ((blueMask >> BigInt(k)) & 1n ? 2 : 1) : 0));
  const picture = (cells, extra = new Map()) => Array.from({ length: 16 }, (_, y) => Array.from({ length: 16 }, (_, x) => {
    const k = y * 16 + x, v = extra.get(k) ?? cells[k];
    return v === 1 ? '🟥' : v === 2 ? '🟦' : '·';
  }).join('')).join('\n');
  const scoreOf = (cells) => ({ red: cells.filter((v) => v === 1).length, blue: cells.filter((v) => v === 2).length });
  const worldParams = async () => (ctx.worldParams ??= {
    epochBeats: Number(await world.epochBeats()), epochsPerSeason: Number(await world.epochsPerSeason()),
    cellPrice: await world.cellPrice(), keeperTip: await world.keeperTip(), container: await world.container(),
  });
  const me = async () => ctx.signer ? ctx.signer.getAddress() : ctx.wallet?.address ?? null;
  // Cells to place: a named pattern at (x, y), or a list of [x, y] cells. x is the column (0 left), y the row (0 top).
  const PLACE_ARGS = {
    pattern: z.enum(Object.keys(PATTERNS)).optional().describe('a named Life pattern, placed with its top-left corner at x, y'),
    x: z.number().int().min(0).max(15).default(0), y: z.number().int().min(0).max(15).default(0),
    cells: z.array(z.tuple([z.number().int().min(0).max(15), z.number().int().min(0).max(15)])).optional().describe('cells as [x, y] pairs, instead of a pattern'),
  };
  const placement = ({ pattern, x = 0, y = 0, cells }) => {
    const ks = new Set();
    if (cells?.length) for (const [cx, cy] of cells) ks.add(cy * 16 + cx);
    else board(16, 16, [[PATTERNS[pattern ?? 'glider'], x, y]]).forEach((v, k) => { if (v) ks.add(k); });
    return [...ks];
  };
  async function worldNow() {
    const who = await me();
    const s = await world.status(who ?? ZERO);
    const p = await worldParams();
    const board_ = cellsOf(s.alive_, s.blue_), pending = cellsOf(s.pendingAlive_, s.pendingBlue_);
    return { s, p, who, board: board_, pending, next: board_.map((v, k) => pending[k] || v) };
  }

  worldTool('world_status', {
    title: 'Overclock World: the board',
    description: 'The shared Red vs Blue Game of Life on X Layer: the 16x16 board (🟥 red, 🟦 blue), the score, the season, the pot, the epoch running as an Overclock job, cells bought for the next epoch, and the connected player\'s team. Free; no wallet needed.',
    inputSchema: {},
  }, safe(async () => {
    const { s, p, who, board: b, pending } = await worldNow();
    const job = s.running_ > 0n ? await summary(s.running_ - 1n) : null;
    const season = Number(s.season_), epoch = Number(s.epoch_);
    const pend = new Map(pending.map((v, k) => [k, v]).filter(([, v]) => v));
    const past = [];
    for (let i = season - 1; i >= Math.max(0, season - 3); i--) {
      const x = await world.seasonInfo(i);
      past.push({ season: i + 1, winner: TEAM_NAME[Number(x.winner)], red: Number(x.red), blue: Number(x.blue_), pot: formatEther(x.pot) });
    }
    return {
      board: picture(b), score: scoreOf(b),
      season: season + 1, generation: epoch * p.epochBeats, generationsPerSeason: p.epochsPerSeason * p.epochBeats,
      pot: formatEther(s.pot), cellPrice: formatEther(p.cellPrice), fuel: formatEther(s.fuel_),
      boughtForNextEpoch: pend.size ? { cells: pend.size, nextBoard: picture(b, pend) } : null,
      epoch: job ? { ...job, generations: `${epoch * p.epochBeats + 1}-${(epoch + 1) * p.epochBeats}` } : null,
      canMoveOn: job ? job.status === 'final' : pend.size > 0 || b.some(Boolean),
      you: who ? { address: who, team: TEAM_NAME[Number(s.team)], cellsThisSeason: Number(s.placed) } : null,
      pastSeasons: past,
      worldAccount: p.container !== ZERO ? p.container : null,
      rules: `Pick a team and buy cells (up to 12 at a time); they join the board at the next epoch. Each epoch runs ${p.epochBeats} generations of two-colour Life as one Overclock job; survivors keep their colour, newborns take their parents' majority colour. After ${p.epochsPerSeason} epochs the team with more live cells splits the pot by cells bought. x is the column (0 left), y the row (0 top).`,
    };
  }));

  worldTool('world_forecast', {
    title: 'Overclock World: what happens if',
    description: 'Run the world forward off-chain, for free, from the next epoch\'s starting board, optionally with cells you are thinking of buying, and show the board and score after that many generations. Use it to plan a move before world_place.',
    inputSchema: { ...PLACE_ARGS, team: z.enum(['red', 'blue']).optional().describe('the team of the cells to try; leave out to forecast the board as it is'), generations: z.number().int().min(1).max(1000).optional().describe('default: one epoch') },
  }, safe(async (a) => {
    const { p, next } = await worldNow();
    let cells = next.slice();
    const tried = a.team ? placement(a) : [];
    for (const k of tried) cells[k] = TEAMS[a.team];
    const g = a.generations ?? p.epochBeats;
    const start = scoreOf(cells);
    for (let i = 0; i < g; i++) cells = worldStep(cells, 16, 16);
    return { tried: tried.length ? { team: a.team, cells: tried.length, cost: formatEther(p.cellPrice * BigInt(tried.length)) } : null, start, after: { generations: g, score: scoreOf(cells), board: picture(cells) } };
  }));

  if (ctx.readOnly || (!ctx.signer && !ctx.wallet)) return server;

  // ------------------------------------------------------------------ wallet

  if (ctx.wallet && !ctx.signer) {
    server.registerTool('connect_wallet', {
      title: 'Connect the user\'s wallet',
      description: 'Optional: transaction tools hand out the approval link themselves. Returns the link to the user\'s approval page, where they connect OKX Wallet or MetaMask, and whether a wallet is connected. Use it when the user asks to connect or which wallet is connected.',
      inputSchema: { waitSeconds: z.number().int().min(0).max(600).default(0) },
    }, safe(async ({ waitSeconds = 0 }) => {
      await ctx.ensureWallet?.();
      await ctx.wallet.waitConnected(waitSeconds * 1000);
      const s = ctx.wallet.status();
      return s.connected ? s : { ...s, next: `Give the user ${s.approvalPage} to open and connect their wallet.` };
    }));

    server.registerTool('transaction_status', {
      title: 'Check a transaction waiting for approval',
      description: 'The result of a transaction tool that returned "waiting for approval": call it with that requestId once the user says they approved (it waits up to waitSeconds). Returns the finished result, an error if they rejected it, or still waiting.',
      inputSchema: { requestId: z.string(), waitSeconds: z.number().int().min(0).max(120).default(20) },
    }, safe(async ({ requestId, waitSeconds = 20 }) => {
      const run = ctx.runs?.get(requestId);
      if (!run) throw new Error(`No transaction request ${requestId}. It may have finished and been read already, or the server restarted; run the tool again.`);
      await follow(run, waitSeconds * 1000);
      return settle(run);
    }));
  }

  // ------------------------------------------------------------------ transactions

  // The signer for a transaction: the opt-in key, or the user's wallet (waiting for them to connect).
  const signer = async () => {
    if (ctx.signer) return ctx.signer;
    await ctx.wallet.signer.getAddress();
    return ctx.wallet.signer;
  };
  const ocw = async () => oc.connect(await signer());

  // With the user's wallet, a transaction tool runs in the background: if it has not finished
  // within a few seconds (the user still has to approve), it returns an approve link and a
  // requestId for transaction_status, so the chat never hangs on a phone switching apps.
  ctx.runs ??= new Map();
  ctx.nextRun ??= 1;
  const WAIT = ctx.approvalWaitMs ?? 15_000;
  // Wait for the run to finish, but give up once it has been waiting on the user (no wallet yet,
  // or a transaction sitting in their wallet) for `patience` ms. A merely slow tool keeps going.
  async function follow(run, patience) {
    let stuck = 0;
    while (!run.done && stuck < patience) {
      const t = Date.now();
      await Promise.race([run.promise, sleep(250)]);
      const onUser = !ctx.wallet.address ? 4 : ctx.wallet.pending.size ? 1 : 0; // no wallet yet: hand out the link sooner
      stuck = onUser ? stuck + (Date.now() - t) * onUser : 0;
    }
  }
  function settle(run) {
    if (!run.done) {
      return {
        status: 'waiting for approval', requestId: run.id, approve: ctx.wallet.url, phone: ctx.wallet.links(),
        next: 'Show the user the approve link (on a phone, phone.openInOkxWalletApp opens it in OKX Wallet). They connect their wallet if asked and approve. Then call transaction_status with this requestId.',
      };
    }
    ctx.runs.delete(run.id);
    if (run.error) throw run.error;
    return run.result;
  }
  const tx = (name, fn) => safe(async (args) => {
    if (ctx.signer) return labelled(name, () => fn(args));
    await ctx.ensureWallet?.();
    const run = { id: String(ctx.nextRun++), tool: name, done: false };
    run.promise = labelled(name, () => fn(args)).then((r) => { run.result = r; }, (e) => { run.error = e; }).finally(() => { run.done = true; });
    ctx.runs.set(run.id, run);
    await follow(run, WAIT);
    return settle(run);
  });

  const send = async (p) => {
    const rc = await (await p).wait();
    return { tx: rc.hash, gas: Number(rc.gasUsed), rc };
  };
  const evArg = (rc, name, key) => rc.logs.map((l) => { try { return oc.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === name)?.args[key];

  ocTool('post_job', {
    title: 'Run a machine on-chain',
    description: 'Post a job to X Layer so an operator runs it and the result is settled on-chain, checkable by anyone. With no arguments: one generation of a glider on the Game of Life board. Pays `fee` OKB (default 0.0001) to whoever\'s result finalizes, plus gas. The user approves it in their wallet.',
    inputSchema: {
      ...MACHINE_ARGS, beats: z.number().int().min(1).max(1_000_000).default(1).describe('how many steps (generations for life)'),
      state: hex.optional().describe('starting state, packed hex; ready-made machines fill this in'), inputs: hex.default('0x'), perBeat: z.boolean().default(false),
      fee: z.string().default('0.0001').describe('OKB paid to the operator'),
    },
  }, tx('post_job', async (a) => {
    const { beats = 1, inputs = '0x', perBeat = false, fee = '0.0001' } = a;
    const { processor, circuitId, state } = pick(a);
    const c = await circuit(processor, circuitId);
    const st = bytesToHex(pack(bitsOf(state, c.nState)));
    const ins = bytesToHex(pack(bitsOf(inputs, perBeat ? beats * c.nIn : c.nIn)));
    const r = await send((await ocw()).postJob(processor, circuitId, ins, st, beats, perBeat, { value: parseEther(fee) }));
    return { jobId: Number(evArg(r.rc, 'JobPosted', 'jobId')), tx: r.tx, gas: r.gas, explorer: txLink((await ctx.provider.getNetwork()).chainId, r.tx), next: 'An operator claims it and the result becomes final after the challenge window; get_job shows its status and result.' };
  }));

  ocTool('continue_job', {
    title: 'Continue a job',
    description: 'Run more beats of the same circuit starting from a finalized job\'s final state, so a stateful machine keeps going. Pays `fee` OKB. Sends a transaction.',
    inputSchema: { parentJobId: z.number().int().min(0), beats: z.number().int().min(1).max(1_000_000), inputs: hex.default('0x'), perBeat: z.boolean().default(false), fee: z.string().default('0.0001') },
  }, tx('continue_job', async ({ parentJobId, beats, inputs = '0x', perBeat = false, fee = '0.0001' }) => {
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

  // ------------------------------------------------------------------ Overclock World: playing

  worldTool('world_place', {
    title: 'Overclock World: buy cells',
    description: 'Buy cells for red or blue: a named pattern at x, y or a list of cells, up to 12 at a time. They join the board at the next epoch. Costs the cell price per cell (half goes to the season pot); you stay on one team for the season. The user approves it in their wallet.',
    inputSchema: { team: z.enum(['red', 'blue']), ...PLACE_ARGS },
  }, tx('world_place', async (a) => {
    const ks = placement(a);
    if (ks.length > 12) throw new Error(`That is ${ks.length} cells; at most 12 at a time.`);
    const { s: st, p, pending } = await worldNow();
    const taken = ks.filter((k) => pending[k]);
    if (taken.length) throw new Error(`Already bought for the next epoch: ${taken.map((k) => `[${k % 16}, ${Math.floor(k / 16)}]`).join(', ')}. Pick other cells.`);
    if (Number(st.team) && Number(st.team) !== TEAMS[a.team]) throw new Error(`You are ${TEAM_NAME[Number(st.team)]} this season (one team a season); buy ${TEAM_NAME[Number(st.team)]} cells or wait for the next season.`);
    const mask = ks.reduce((m, k) => m | (1n << BigInt(k)), 0n);
    const value = p.cellPrice * BigInt(ks.length);
    const r = await send(world.connect(await signer()).place(TEAMS[a.team], mask, { value }));
    return { team: a.team, cells: ks.length, paid: formatEther(value), tx: r.tx, explorer: txLink((await ctx.provider.getNetwork()).chainId, r.tx), next: 'The cells drop onto the board when the next epoch starts; world_advance starts it if nobody else does.' };
  }));

  worldTool('world_advance', {
    title: 'Overclock World: move the world on',
    description: 'Start the next epoch (posting it as an Overclock job, paid by the world) once the running one is final, or when cells are waiting. Ends the season when it is over. Anyone can call it and earns the keeper tip. The user approves it in their wallet.',
    inputSchema: {},
  }, tx('world_advance', async () => {
    const before = Number(await world.season());
    const r = await send(world.connect(await signer()).advance());
    const ev = (name) => r.rc.logs.map((l) => { try { return world.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === name);
    const ended = ev('SeasonEnded'), started = ev('EpochStarted');
    return {
      tx: r.tx, seasonEnded: ended ? { season: before + 1, winner: TEAM_NAME[Number(ended.args.winner)], red: Number(ended.args.red), blue: Number(ended.args.blue), pot: formatEther(ended.args.pot), announcedOverTapeSend: !!ev('Announced') } : null,
      jobId: started ? Number(started.args.jobId) : null, tip: formatEther((await worldParams()).keeperTip),
    };
  }));

  worldTool('world_claim', {
    title: 'Overclock World: claim winnings',
    description: 'Collect your share of a season your team won (seasons are numbered from 1, as world_status shows them). The user approves it in their wallet.',
    inputSchema: { season: z.number().int().min(1) },
  }, tx('world_claim', async ({ season }) => {
    const r = await send(world.connect(await signer()).claim(season - 1));
    const ev = r.rc.logs.map((l) => { try { return world.interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'Claimed');
    return { season, paid: ev ? formatEther(ev.args.amount) : null, tx: r.tx };
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
