#!/usr/bin/env node
// Overclock command line. Network settings come from the environment:
//   RPC_URL      JSON-RPC endpoint (X Layer mainnet: https://rpc.xlayer.tech, chain 196)
//   PRIVATE_KEY  key for commands that send transactions
//   OVERCLOCK    address of the Overclock contract (default: the X Layer mainnet deployment)
//
//   overclock operator [--lie-at LEAF]     claim open jobs and defend the claims
//   overclock watch                        re-run every claim and challenge wrong ones
//   overclock post --cpu A --id N --beats B [--state HEX] [--inputs HEX] [--per-beat] [--fee OKB]
//   overclock trace --cpu A --id N --beats B [--state HEX] [--inputs HEX] [--per-beat]
//   overclock job N                        show a job and its result
//   overclock keeper --world A                advance an Overclock World whenever its epoch is final
//   overclock life --w 16 --h 16 --cpu A --cell-id N
//                                          print Game of Life netlists, ready to tape out

import { JsonRpcProvider, Wallet, Contract, parseEther, formatEther } from 'ethers';
import { Operator, Challenger, WorldKeeper } from '../src/agents.js';
import { artifact, loadCircuit, readJob } from '../src/chain.js';
import { traceJob, Tree } from '../src/trace.js';
import { hexToBytes, bytesToHex, pack, unpack, load } from '../src/tap02.js';
import { cellCircuit, boardCircuit } from '../src/life.js';
import { XLAYER } from '../src/tapeout.js';

const [cmd, ...rest] = process.argv.slice(2);
const flag = (k, d) => { const i = rest.indexOf(`--${k}`); return i < 0 ? d : rest[i + 1] ?? true; };
const has = (k) => rest.includes(`--${k}`);
const env = (k) => { if (!process.env[k]) { console.error(`set ${k}`); process.exit(2); } return process.env[k]; };

const provider = () => new JsonRpcProvider(env('RPC_URL'));
const signer = () => new Wallet(env('PRIVATE_KEY'), provider());
const overclock = (runner) => new Contract(process.env.OVERCLOCK || XLAYER.overclock, artifact('Overclock').abi, runner);
const log = (e) => console.log(`${new Date().toISOString()} ${e.who} ${e.what}${e.gas ? ` (${e.gas} gas, ${e.tx})` : ''}`);

async function loop(agent) {
  const every = Number(flag('poll', 4000));
  for (;;) {
    try { await agent.tick(); } catch (e) { console.error(e.shortMessage ?? e.message); }
    await new Promise((r) => setTimeout(r, every));
  }
}

function jobBits(c, beats) {
  const perBeat = has('per-beat');
  return {
    beats,
    perBeat,
    state: unpack(hexToBytes(flag('state', '0x')), c.nState),
    inputs: unpack(hexToBytes(flag('inputs', '0x')), perBeat ? beats * c.nIn : c.nIn),
  };
}

switch (cmd) {
  case 'operator': {
    const lieAt = flag('lie-at');
    const s = signer();
    await loop(new Operator({ oc: overclock(s), signer: s, name: 'operator', log, lie: lieAt ? () => Number(lieAt) : undefined }));
    break;
  }
  case 'watch': {
    const s = signer();
    await loop(new Challenger({ oc: overclock(s), signer: s, name: 'watcher', log }));
    break;
  }
  case 'keeper': {
    const s = signer();
    await loop(new WorldKeeper({ world: new Contract(flag('world'), artifact('World').abi, s), oc: overclock(s), signer: s, log }));
    break;
  }
  case 'post': {
    const s = signer();
    const c = await loadCircuit(s, flag('cpu'), BigInt(flag('id')));
    const beats = Number(flag('beats', 1));
    const j = jobBits(c, beats);
    const tx = await overclock(s).postJob(flag('cpu'), BigInt(flag('id')), bytesToHex(pack(j.inputs)), bytesToHex(pack(j.state)), beats, j.perBeat, { value: parseEther(flag('fee', '0')) });
    const rc = await tx.wait();
    const ev = rc.logs.map((l) => { try { return overclock(s).interface.parseLog(l); } catch { return null; } }).find((e) => e?.name === 'JobPosted');
    console.log(`job ${ev.args.jobId} posted (${rc.hash})`);
    break;
  }
  case 'trace': {
    const c = await loadCircuit(provider(), flag('cpu'), BigInt(flag('id')));
    const beats = Number(flag('beats', 1));
    const t = traceJob(c, jobBits(c, beats));
    const tree = new Tree(t.leaves);
    console.log(JSON.stringify({ gates: c.nGates, leaves: t.n, depth: tree.depth, root: tree.root, outputs: bytesToHex(pack(t.outputs)), newState: bytesToHex(pack(t.newState)) }, null, 1));
    break;
  }
  case 'job': {
    const oc = overclock(provider());
    const j = await readJob(oc, BigInt(rest[0]));
    console.log(JSON.stringify({ ...j, fee: formatEther(j.fee), jobId: String(j.jobId), id: String(j.id), inputBits: undefined, stateBits: undefined }, null, 1));
    break;
  }
  case 'life': {
    const w = Number(flag('w', 16)), h = Number(flag('h', 16));
    const cell = cellCircuit();
    const bd = boardCircuit(w, h, flag('cpu', '0x' + '00'.repeat(20)), Number(flag('cell-id', 0)));
    const cc = load(cell.netlist, 9, 1);
    console.log(JSON.stringify({
      cell: { nIn: 9, nOut: 1, nState: 0, gates: cc.nGates, netlist: bytesToHex(cell.netlist) },
      board: { nIn: 0, nOut: w * h, nState: w * h, refs: w * h, netlist: bytesToHex(bd.netlist) },
      note: 'Tape out the cell first, then the board with --cpu and --cell-id set to where the cell landed.',
    }, null, 1));
    break;
  }
  default:
    console.log('usage: overclock operator|watch|keeper|post|trace|job|life (see bin/overclock.js)');
}
