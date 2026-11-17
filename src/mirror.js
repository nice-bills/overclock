// Mirror a mainnet TapeOut circuit and everything it REFs into a local TapeOut stand-in
// (contracts/TapeOutLocal.sol), rewriting each REF's processor address and circuit id to the
// mirrored copy. A mirrored netlist evaluates exactly like the mainnet one, so any machine on
// X Layer can be run on testnet or a local chain for free.
//
// Reads use only free view calls, so a mainnet RPC is enough. Writes go to a TapeOutLocal
// processor the caller owns; ids there start at 1 and are assigned in dependency order, which is
// why the mapping file matters.

import { Contract, getAddress } from 'ethers';
import { CIRCUITS_ABI } from './chain.js';
import { bytesToHex, decode, hexToBytes, load, NAND, LATCH, REF } from './tap02.js';
import { burnCost, tapeout, mint as mintTokens } from './tapeout.js';

export const MAINNET_RPC = 'https://rpc.xlayer.tech';
export const MAINNET_CHAIN_ID = 196;
// Our mainnet processor, with the 8x8 Life cell at #4 and the board that REFs it at #5.
export const XLAYER_LIFE = {
  processor: '0xb00f10bb4b2f32c561bf90e205e543d0a2395971',
  cellId: 4n,
  boardId: 5n,
};

const NAND_BYTES = 7;
const LATCH_BYTES = 4;
const REF_HEADER_BYTES = 31;

/// Key for a (processor, circuit id) pair, case-insensitive on the address.
export function refKey(processor, id) {
  return `${String(processor).toLowerCase()}:${BigInt(id)}`;
}

function u64At(bytes, off) {
  let v = 0n;
  for (let i = 0; i < 8; i++) v = (v << 8n) | BigInt(bytes[off + i]);
  return v;
}

function writeU64(bytes, off, value) {
  let v = BigInt(value);
  for (let i = 7; i >= 0; i--) {
    bytes[off + i] = Number(v & 0xffn);
    v >>= 8n;
  }
}

function addressBytes(processor) {
  if (typeof processor !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(processor)) {
    throw new Error(`not an address: ${processor}`);
  }
  return hexToBytes(processor);
}

function mappingTarget(mapping, processor, id) {
  const key = refKey(processor, id);
  const v = mapping instanceof Map ? mapping.get(key) : mapping?.[key];
  if (v == null) return null;
  if (Array.isArray(v)) return { processor: v[0], id: BigInt(v[1]) };
  const target = v.processor ?? v.cpu ?? v.address;
  if (target == null || v.id == null) throw new Error(`bad mapping value for ${key}`);
  return { processor: target, id: BigInt(v.id) };
}

/// Rewrite every REF record to its mirrored (processor, id). Other bytes are copied unchanged.
/// Throws on a malformed netlist or a REF missing from the mapping, so a partial mirror can never
/// be taped out silently.
export function rewriteRefs(netlist, nIn, mapping) {
  const src = netlist instanceof Uint8Array ? netlist : hexToBytes(netlist);
  decode(src, nIn); // validates opcodes and record lengths before we touch the bytes
  const out = Uint8Array.from(src);
  let off = 0;
  while (off < src.length) {
    const op = src[off];
    if (op === NAND) off += NAND_BYTES;
    else if (op === LATCH) off += LATCH_BYTES;
    else if (op === REF) {
      const processor = bytesToHex(src.subarray(off + 1, off + 21));
      const id = u64At(src, off + 21);
      const target = mappingTarget(mapping, processor, id);
      if (!target) throw new Error(`REF ${processor}#${id} at byte ${off} has no mirror`);
      if (target.id < 0n || target.id >= 1n << 64n) throw new Error(`mirror id out of range for ${processor}#${id}: ${target.id}`);
      out.set(addressBytes(target.processor), off + 1);
      writeU64(out, off + 21, target.id);
      off += REF_HEADER_BYTES + 3 * src[off + 29];
    } else {
      throw new Error(`unknown opcode 0x${op.toString(16)} at byte ${off}`);
    }
  }
  return out;
}

/// True if two netlists are equal outside every REF's processor address and circuit id.
export function sameNetlistExceptRefs(a, b) {
  const x = a instanceof Uint8Array ? a : hexToBytes(a);
  const y = b instanceof Uint8Array ? b : hexToBytes(b);
  if (x.length !== y.length) return false;
  for (let off = 0; off < x.length; ) {
    const op = x[off];
    if (op === NAND) {
      for (let i = 0; i < NAND_BYTES; i++) if (x[off + i] !== y[off + i]) return false;
      off += NAND_BYTES;
    } else if (op === LATCH) {
      for (let i = 0; i < LATCH_BYTES; i++) if (x[off + i] !== y[off + i]) return false;
      off += LATCH_BYTES;
    } else {
      for (let i = 0; i < REF_HEADER_BYTES + 3 * x[off + 29]; i++) {
        // byte 0 is the opcode; bytes 1..28 are the target address and id
        if (i > 0 && i <= 28) continue;
        if (x[off + i] !== y[off + i]) return false;
      }
      off += REF_HEADER_BYTES + 3 * x[off + 29];
    }
  }
  return true;
}

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
const RETRYABLE = /missing response|timeout|fetch failed|bad response|network error|ECONNRESET|ETIMEDOUT|rate limit|429|502|503|504|SERVER_ERROR/i;

async function withRetry(fn, tries = 4) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i + 1 >= tries || !RETRYABLE.test(`${e?.code} ${e?.message}`)) throw e;
      await sleep(400 * 2 ** i);
    }
  }
}

/// One circuit from a live processor: raw netlist bytes plus its TAP-02 sizes.
export async function fetchCircuit(provider, processor, id) {
  const cpu = getAddress(processor);
  const counter = new Contract(cpu, CIRCUITS_ABI, provider);
  const [netlistHex, info] = await withRetry(() => Promise.all([counter.netlist(id), counter.circuitInfo(id)]));
  const netlist = hexToBytes(netlistHex);
  const circuit = {
    processor: cpu.toLowerCase(),
    id: BigInt(id),
    nIn: Number(info.nIn),
    nOut: Number(info.nOut),
    nState: Number(info.nState),
    gateCount: Number(info.gateCount),
    netlist,
    refs: decode(netlist, Number(info.nIn)).filter((e) => e.op === REF).map((e) => ({ processor: e.cpu.toLowerCase(), id: e.id })),
  };
  if (circuit.nOut < 1) throw new Error(`${cpu}#${id} has no outputs`);
  return circuit;
}

/// Fetch a circuit and everything it REFs, recursively. The returned `order` has every
/// dependency before the circuits that use it, which is the order the mirror must tape them out
/// in. `fetch` can be replaced in tests to avoid a network.
export async function collectCircuits(provider, processor, id, { fetch = null } = {}) {
  const read = fetch ?? ((cpu, cid) => fetchCircuit(provider, cpu, cid));
  const byKey = new Map();
  const order = [];
  const visiting = [];

  const visit = async (cpu, cid) => {
    const key = refKey(cpu, cid);
    const cached = byKey.get(key);
    if (cached) return cached;
    if (visiting.includes(key)) throw new Error(`REF cycle: ${[...visiting.slice(visiting.indexOf(key)), key].join(' -> ')}`);
    visiting.push(key);
    const circuit = await read(cpu, BigInt(cid));
    for (const ref of circuit.refs) await visit(ref.processor, ref.id);
    visiting.pop();
    byKey.set(key, circuit);
    order.push(circuit);
    return circuit;
  };

  const root = await visit(processor, BigInt(id));
  return { root, order, byKey };
}

/// Map every source circuit to the ids a fresh TapeOutLocal processor would assign it, in the
/// same dependency order. Used by --dry-run to rewrite and print a plan without deploying.
export function previewMapping(order, processor, startId = 1n) {
  const mapping = new Map();
  order.forEach((c, i) => mapping.set(refKey(c.processor, c.id), { processor, id: BigInt(startId) + BigInt(i) }));
  return mapping;
}

/// Copy a mainnet circuit graph into a TapeOutLocal processor.
///
///   mirrorCircuit({ provider, processor, id, circuits, transistors })
///
/// `circuits` and `transistors` are the TapeOutLocal contracts from src/tapeout.js (createCPU),
/// connected to the funded signer that pays the tapeout fees. Returns the source/target identity,
/// one mapping entry per circuit, and the rewritten netlists.
export async function mirrorCircuit({ provider, processor, id, circuits, transistors, mint = true, log = () => {} }) {
  const graph = await collectCircuits(provider, processor, id);
  const sourceNet = await withRetry(() => provider.getNetwork());
  const signer = circuits.runner;
  if (!signer || typeof signer.getAddress !== 'function') throw new Error('circuits must be connected to a signer');
  const signerAddress = await signer.getAddress();
  const targetProvider = signer.provider;
  const targetNet = targetProvider ? await targetProvider.getNetwork() : null;
  const targetProcessor = (await circuits.getAddress()).toLowerCase();

  const refMap = new Map(); // source key -> mirror (processor, id)
  const local = new Map(); // mirror key -> loaded circuit, for validating the next tapeout
  const entries = [];
  log(`mirroring ${graph.order.length} circuit${graph.order.length === 1 ? '' : 's'} from chain ${sourceNet.chainId} to ${targetProcessor}`);

  for (const c of graph.order) {
    const netlist = rewriteRefs(c.netlist, c.nIn, refMap);
    const resolved = load(netlist, c.nIn, c.nOut, (a, sid) => local.get(refKey(a, sid)) ?? null);
    if (resolved.nGates !== c.gateCount || resolved.nState !== c.nState) {
      throw new Error(`rewritten ${c.processor}#${c.id} disagrees with the source: ${resolved.nGates}/${resolved.nState} vs ${c.gateCount}/${c.nState}`);
    }

    if (mint) {
      const need = burnCost(netlist, c.nIn);
      for (const [token, kind] of [[0, 'nand'], [1, 'latch']]) {
        if (!need[kind]) continue;
        const have = Number(await transistors.balanceOf(signerAddress, token));
        if (need[kind] > have) await mintTokens(transistors, token, need[kind] - have);
      }
    }

    const minted = await tapeout(circuits, { netlist, nIn: c.nIn, nOut: c.nOut });
    const targetId = BigInt(minted.id);
    const [nIn, nOut, nState, gateCount] = await circuits.circuitInfo(targetId);
    if (Number(nIn) !== c.nIn || Number(nOut) !== c.nOut || Number(nState) !== c.nState || Number(gateCount) !== c.gateCount) {
      throw new Error(`mirror ${targetProcessor}#${targetId} stored different sizes`);
    }

    const target = { processor: targetProcessor, id: targetId };
    refMap.set(refKey(c.processor, c.id), target);
    local.set(refKey(targetProcessor, targetId), resolved);
    entries.push({
      from: { processor: c.processor, id: c.id },
      to: target,
      nIn: c.nIn,
      nOut: c.nOut,
      nState: c.nState,
      gateCount: c.gateCount,
      netlistBytes: netlist.length,
      refs: c.refs.length,
    });
    log(`  ${c.processor}#${c.id} (${c.gateCount} gates, ${c.refs.length} REFs) -> ${targetProcessor}#${targetId}`);
  }

  return {
    source: { chainId: Number(sourceNet.chainId), processor: graph.root.processor, id: graph.root.id },
    target: { chainId: targetNet ? Number(targetNet.chainId) : null, processor: targetProcessor },
    mapping: entries,
    refMap,
    order: graph.order,
  };
}

/// The JSON shape written by scripts/mirror.js: mainnet processor/id -> mirror processor/id.
export function mappingDocument(result) {
  return {
    sourceChainId: result.source.chainId,
    targetChainId: result.target.chainId,
    source: { processor: result.source.processor, id: Number(result.source.id) },
    target: { processor: result.target.processor, ...(result.target.factory ? { factory: result.target.factory } : {}) },
    mapping: result.mapping.map((e) => ({
      from: { processor: e.from.processor, id: Number(e.from.id) },
      to: { processor: e.to.processor, id: Number(e.to.id) },
      nIn: e.nIn,
      nOut: e.nOut,
      nState: e.nState,
      gateCount: e.gateCount,
      refs: e.refs,
      netlistBytes: e.netlistBytes,
    })),
  };
}
