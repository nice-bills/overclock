// Mirror any X Layer mainnet TapeOut circuit, and everything it REFs, into a local
// TapeOutLocal stand-in (the same contract the testnet playground runs), rewiring every REF to the
// mirrored processor and ids. Reads mainnet through free view calls only; the only transactions are
// on the destination chain, which is refused if it is mainnet.
//
//   node scripts/mirror.js [processor] [circuitId] [options]
//
// With no circuit it mirrors our 8x8 Life board (0xb00f…#5, which REFs the cell rule at #4).
//
// Options:
//   --rpc <url>          mainnet RPC (default https://rpc.xlayer.tech)
//   --chain <id>         expected source chain id (default 196)
//   --dry-run            fetch, rewrite and print the plan; no transactions and no key
//   --dest-rpc <url>     destination RPC (default $RPC_URL, else http://127.0.0.1:8545)
//   --key <hex>          destination signer (default $PRIVATE_KEY)
//   --factory <addr>     existing TapeOutFactoryLocal (default: deploy one)
//   --cpu <addr>         existing TapeOutLocal processor (default: create one)
//   --name/--symbol      name and symbol for a new processor
//   --supply <n>         transistor supply cap (default 1000000)
//   --mint-price <wei>   transistor price in wei (default 1)
//   --out <file>         mapping file (default deployments/mirror-<src>-to-<dst>.json)
//
//   node scripts/mirror.js --dry-run
//   RPC_URL=http://127.0.0.1:8545 PRIVATE_KEY=0x... node scripts/mirror.js

import { writeFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { Contract, ContractFactory, JsonRpcProvider, Wallet, formatEther } from 'ethers';
import { artifact } from '../src/chain.js';
import { CIRCUITS_FULL_ABI, TRANSISTORS_ABI, createCPU } from '../src/tapeout.js';
import { decode, REF } from '../src/tap02.js';
import {
  MAINNET_CHAIN_ID, MAINNET_RPC, XLAYER_LIFE,
  collectCircuits, mappingDocument, mirrorCircuit, previewMapping, refKey, rewriteRefs, sameNetlistExceptRefs,
} from '../src/mirror.js';

const FLAGS = new Set(['dry-run', 'help']);
const opts = {};
const positional = [];
for (let i = 0; i < process.argv.length - 2; i++) {
  const a = process.argv[i + 2];
  if (!a.startsWith('--')) { positional.push(a); continue; }
  const eq = a.indexOf('=');
  const k = eq > 0 ? a.slice(2, eq) : a.slice(2);
  if (eq > 0) opts[k] = a.slice(eq + 1);
  else if (FLAGS.has(k)) opts[k] = true;
  else opts[k] = process.argv[++i + 2];
}

const usage = `Mirror a mainnet TapeOut circuit and its REFs into a TapeOutLocal processor.

  node scripts/mirror.js [processor] [circuitId] [options]

  --dry-run            fetch, rewrite and print the plan; no key, no transactions
  --rpc <url>          source RPC (default ${MAINNET_RPC})
  --dest-rpc <url>     destination RPC (default $RPC_URL or http://127.0.0.1:8545)
  --key <hex>          destination signer (default $PRIVATE_KEY)
  --factory <addr>     existing TapeOutFactoryLocal (default: deploy one)
  --cpu <addr>         existing TapeOutLocal processor (default: create one)
  --out <file>         mapping file (default deployments/mirror-<src>-to-<dst>.json)

With no circuit: our mainnet 8x8 Life board ${XLAYER_LIFE.processor}#${XLAYER_LIFE.boardId}.`;

if (opts.help) {
  console.log(usage);
  process.exit(0);
}

const short = (a) => `${a.slice(0, 8)}…${a.slice(-4)}`;
const processor = positional[0] ?? XLAYER_LIFE.processor;
const id = BigInt(positional[1] ?? XLAYER_LIFE.boardId);
if (!/^0x[0-9a-fA-F]{40}$/.test(processor)) {
  console.error(`not a processor address: ${processor}\n\n${usage}`);
  process.exit(1);
}
if (!positional[0]) console.log(`no circuit given: using the 8x8 Life board ${processor}#${id}`);

const source = new JsonRpcProvider(opts.rpc ?? MAINNET_RPC, undefined, { cacheTimeout: -1 });
const sourceNet = await source.getNetwork();
const wanted = BigInt(opts.chain ?? MAINNET_CHAIN_ID);
if (BigInt(sourceNet.chainId) !== wanted) {
  console.error(`source is chain ${sourceNet.chainId}, expected ${wanted} (use --chain to allow another)`);
  process.exit(1);
}

console.log(`reading ${processor}#${id} and its REFs from chain ${sourceNet.chainId} (${opts.rpc ?? MAINNET_RPC})`);
const graph = await collectCircuits(source, processor, id);
for (const c of graph.order) {
  console.log(`  ${c.processor}#${c.id}: ${c.nIn} in, ${c.nOut} out, ${c.nState} state, ${c.gateCount} gates, ${c.refs.length} REFs (${c.netlist.length} bytes)`);
}

if (opts['dry-run']) {
  // Predict the ids a fresh TapeOutLocal assigns: dependencies first, starting at 1. With --cpu
  // and a reachable destination we can read its nextId() and rewrite against the real address.
  let target = opts.cpu ? String(opts.cpu).toLowerCase() : `0x${'00'.repeat(20)}`;
  let startId = 1n;
  if (opts.cpu && (opts['dest-rpc'] || process.env.RPC_URL)) {
    const provider = new JsonRpcProvider(opts['dest-rpc'] ?? process.env.RPC_URL, undefined, { cacheTimeout: -1 });
    const counter = new Contract(target, ['function nextId() view returns (uint256)'], provider);
    startId = (await counter.nextId()) + 1n;
  }
  const mapping = previewMapping(graph.order, target, startId);
  console.log(`\nmirror plan (dry run), ${graph.order.length} circuit${graph.order.length === 1 ? '' : 's'} to ${target}:`);
  for (const c of graph.order) {
    const rewritten = rewriteRefs(c.netlist, c.nIn, mapping);
    const targetId = mapping.get(refKey(c.processor, c.id)).id;
    const refs = decode(rewritten, c.nIn).filter((e) => e.op === REF);
    const untouched = sameNetlistExceptRefs(c.netlist, rewritten);
    console.log(`  ${c.processor}#${c.id} -> ${target}#${targetId}: ${refs.length} REFs rewired, rest of netlist ${untouched ? 'unchanged' : 'CHANGED'}`);
    if (!untouched) process.exitCode = 1;
  }
  console.log(`\nmapping ${processor}#${id} -> ${target}#${startId + BigInt(graph.order.length - 1)}`);
  if (opts.out) {
    const doc = {
      sourceChainId: Number(sourceNet.chainId),
      targetChainId: null,
      dryRun: true,
      source: { processor: processor.toLowerCase(), id: Number(id) },
      target: { processor: target },
      mapping: graph.order.map((c) => {
        const to = mapping.get(refKey(c.processor, c.id));
        return { from: { processor: c.processor, id: Number(c.id) }, to: { processor: to.processor, id: Number(to.id) }, nIn: c.nIn, nOut: c.nOut, nState: c.nState, gateCount: c.gateCount, refs: c.refs.length, netlistBytes: c.netlist.length };
      }),
    };
    mkdirSync(dirname(opts.out), { recursive: true });
    writeFileSync(opts.out, JSON.stringify(doc, null, 1) + '\n');
    console.log(`wrote ${opts.out}`);
  }
  process.exit(process.exitCode ?? 0);
}

const destRpc = opts['dest-rpc'] ?? process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const key = opts.key ?? process.env.PRIVATE_KEY;
if (!key) {
  console.error(`no destination key: pass --key or set PRIVATE_KEY (or use --dry-run)\n\n${usage}`);
  process.exit(1);
}
const dest = new JsonRpcProvider(destRpc, undefined, { cacheTimeout: -1 });
const destNet = await dest.getNetwork();
if (BigInt(destNet.chainId) === 196n) {
  console.error('refusing to write to X Layer mainnet: the mirror belongs on a test chain or a local node');
  process.exit(1);
}
const signer = new Wallet(key, dest);
console.log(`\nwriting to chain ${destNet.chainId} at ${destRpc} as ${signer.address} (${formatEther(await dest.getBalance(signer.address))} native)`);

let circuits, transistors, factoryAddr = opts.factory ?? null;
if (opts.cpu) {
  circuits = new Contract(String(opts.cpu), CIRCUITS_FULL_ABI, signer);
  transistors = new Contract(await circuits.transistors(), TRANSISTORS_ABI, signer);
  console.log(`using processor ${await circuits.getAddress()}`);
} else {
  if (!factoryAddr) {
    const a = artifact('TapeOutFactoryLocal');
    const f = new ContractFactory(a.abi, a.bytecode, signer);
    const deployed = await f.deploy();
    await deployed.waitForDeployment();
    factoryAddr = await deployed.getAddress();
    console.log(`deployed TapeOutFactoryLocal at ${factoryAddr}`);
  }
  const cpu = await createCPU(signer, factoryAddr, {
    name: opts.name ?? 'Overclock Mirror',
    symbol: opts.symbol ?? 'OCM',
    story: 'Mainnet circuits mirrored for local and testnet runs.',
    supply: Number(opts.supply ?? 1_000_000),
    mintPrice: BigInt(opts['mint-price'] ?? 1),
  });
  ({ circuits, transistors } = cpu);
  console.log(`created processor ${await circuits.getAddress()}`);
}

const result = await mirrorCircuit({
  provider: source,
  processor,
  id,
  circuits,
  transistors,
  log: (line) => console.log(line),
});
if (factoryAddr) result.target.factory = factoryAddr;

const out = opts.out ?? `deployments/mirror-${result.source.chainId}-to-${result.target.chainId}.json`;
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(mappingDocument(result), null, 1) + '\n');
console.log(`\nmirror ${short(result.source.processor)}#${result.source.id} on chain ${result.target.chainId}`);
for (const e of result.mapping) console.log(`  ${e.from.processor}#${e.from.id} -> ${e.to.processor}#${e.to.id}`);
console.log(`wrote ${out}`);
