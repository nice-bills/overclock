// Certify FabX miners, locally, by shape.
//
//   node scripts/certify.js --top 5                 # the five largest miner shapes
//   node scripts/certify.js --known-failing         # #2346, #4890, #4897 (docs/fabx-research.md)
//   node scripts/certify.js --id 2346               # one miner
//   node scripts/certify.js --id 2346 --shape       # one miner, covers its whole shape
//   node scripts/certify.js --top 5 --dry-run       # run the jobs, write nothing
//
// Reads are free mainnet eth_calls plus FabX's public vector API. Every transaction goes to a
// throwaway in-process ganache (chain 31337) with a local TapeOutLocal processor and Overclock:
// no node, no key, no mainnet or testnet transaction. Each certificate lands in
// docs/certificates/<processor>-<id>.json and as an entry in web/runs.json.
//
// Requires build/ artifacts: run `node scripts/compile.js` (or `npm test`) first.

import { readFileSync, writeFileSync } from 'node:fs';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, JsonRpcProvider, parseEther } from 'ethers';
import { artifact } from '../src/chain.js';
import { createCPU } from '../src/tapeout.js';
import {
  KNOWN_FAILING, MAINNET_RPC, MINER_PROCESSOR,
  applyCertificate, certificateDocumentPath, challengeName, certifyMiner, mainnetSource,
  scanProcessor, writeCertificate,
} from '../src/certify.js';

const args = process.argv.slice(2);
const arg = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);

const LOCAL_CHAIN_ID = 31337;
const BOND = parseEther('1');
const WINDOW = 3600;
const FEE = 0n;

const usage = `Certify FabX miners against their Gate Challenge's official reference.

  node scripts/certify.js --top 5
  node scripts/certify.js --known-failing
  node scripts/certify.js --processor 0x87BF…F9a6 --id 2346 [--shape]
  node scripts/certify.js --top 5 --dry-run

  --top <n>            certify the n largest shapes by miner count (default 5)
  --known-failing      certify #2346 (GC-094), #4890 (GC-013), #4897 (GC-014)
  --id <n>             certify one miner; with --processor, else the miner processor
  --shape              one miner's certificate covers every circuit with its netlist
  --dry-run            run the jobs but write no files and no web/runs.json entries
  --out-dir <dir>      certificate directory (default docs/certificates)
  --runs <file>        runs index (default web/runs.json)
  --rpc <url>          source RPC (default ${MAINNET_RPC})

Every transaction goes to an in-process ganache on chain ${LOCAL_CHAIN_ID}.`;

if (flag('help')) {
  console.log(usage);
  process.exit(0);
}

const topRaw = arg('top', null);
const top = topRaw !== null && topRaw !== undefined && !String(topRaw).startsWith('--') ? Number(topRaw) : (args.includes('--top') ? 5 : null);
const known = flag('known-failing');
const oneId = arg('id', null) !== null ? Number(arg('id')) : null;
const oneProcessor = arg('processor', MINER_PROCESSOR);
const shapeMode = flag('shape');
const dryRun = flag('dry-run');
const outDir = arg('out-dir', 'docs/certificates');
const runsPath = arg('runs', 'web/runs.json');
const rpc = arg('rpc', process.env.RPC_URL ?? MAINNET_RPC);

if (top === null && !known && oneId === null) {
  console.error(`nothing to certify\n\n${usage}`);
  process.exit(1);
}
if (top !== null && !(top >= 1)) {
  console.error('--top needs a positive number');
  process.exit(1);
}

const short = (a) => `${a.slice(0, 8)}…${a.slice(-4)}`;
const log = (...line) => console.log(...line);

async function localDestination() {
  const provider = new BrowserProvider(ganache.provider({
    logging: { quiet: true },
    chain: { chainId: LOCAL_CHAIN_ID, hardfork: 'shanghai' },
    miner: { blockGasLimit: 2_000_000_000, callGasLimit: 2_000_000_000 },
    wallet: { totalAccounts: 3, defaultBalance: 1000 },
  }));
  const [owner] = await Promise.all([0].map((i) => provider.getSigner(i)));
  const factoryArt = artifact('TapeOutFactoryLocal');
  const factory = await new ContractFactory(factoryArt.abi, factoryArt.bytecode, owner).deploy();
  await factory.waitForDeployment();
  const cpu = await createCPU(owner, await factory.getAddress(), {
    name: 'Overclock Certifier', symbol: 'OCC', story: 'Local FabX certification bench.', supply: 1_000_000, mintPrice: 1n,
  });
  const ocArt = artifact('Overclock');
  const overclock = await new ContractFactory(ocArt.abi, ocArt.bytecode, owner).deploy(
    BOND, WINDOW, await factory.getAddress(), await owner.getAddress(), 0,
  );
  await overclock.waitForDeployment();
  const chainId = Number((await provider.getNetwork()).chainId);
  if (chainId === 196 || chainId === 1952) throw new Error(`certification must not run on chain ${chainId}`);
  return {
    provider,
    chainId,
    processor: (await cpu.circuits.getAddress()).toLowerCase(),
    circuits: cpu.circuits,
    transistors: cpu.transistors,
    overclock,
    signer: owner,
    window: WINDOW,
    bond: BOND,
    fee: FEE,
    advance: async () => {
      await provider.send('evm_increaseTime', [WINDOW + 1]);
      await provider.send('evm_mine', []);
    },
  };
}

function pickTargets(groups) {
  const out = [];
  const seen = new Set();
  const add = (processor, id, shape) => {
    const key = `${processor.toLowerCase()}:${id}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ processor, id, shape });
  };
  if (top !== null) {
    for (const g of groups.slice(0, top)) add(g.processors[0], g.ids[0], g);
  }
  if (known) {
    for (const k of KNOWN_FAILING) {
      const g = groups.find((x) => x.taskId === k.taskId && x.covers.some((c) => c.processor.toLowerCase() === k.processor.toLowerCase() && c.id === k.id));
      add(k.processor, k.id, g ?? null);
    }
  }
  if (oneId !== null) {
    const g = groups.find((x) => x.covers.some((c) => c.processor.toLowerCase() === oneProcessor.toLowerCase() && c.id === oneId)) ?? null;
    add(oneProcessor, oneId, shapeMode ? g : null);
  }
  return out;
}

async function main() {
  let groups = [];
  if (top !== null || known || (oneId !== null && shapeMode)) {
    log(`reading ${oneProcessor} from chain 196 (${rpc}); this scans every miner once…`);
    const scanProvider = new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
    const scan = await scanProcessor({
      provider: scanProvider,
      processor: oneProcessor,
      log: (line) => log(`  ${line}`),
    });
    groups = scan.groups;
    log(`  block ${scan.block}: ${scan.miners} claimed miners in ${groups.length} shapes`);
  }

  const targets = pickTargets(groups);
  if (!targets.length) throw new Error('no certification target matched');

  const source = mainnetSource({ provider: new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 }) });
  const dest = await localDestination();
  log(`\nlocal destination: chain ${dest.chainId}, processor ${dest.processor}`);
  log(`overclock ${await dest.overclock.getAddress()}\n`);

  const certs = [];
  for (const t of targets) {
    log(`certifying ${short(t.processor)}#${t.id}${t.shape ? ` (shape ${t.shape.key.slice(0, 26)}…, ${t.shape.count} circuits)` : ''}`);
    const cert = await certifyMiner({
      processor: t.processor,
      id: t.id,
      source,
      dest,
      shape: t.shape,
      covers: t.shape?.covers,
      log: (line) => log(`  ${line}`),
    });
    certs.push(cert);
    log(`  ${cert.verdict.toUpperCase()}: ${cert.mismatches} mismatch${cert.mismatches === 1 ? '' : 'es'} in ${cert.inputs} inputs${cert.firstFailingInput ? `, first ${cert.firstFailingInput}` : ''}; job ${cert.job.runId}`);
    if (cert.caveat) log(`  caveat: ${cert.caveat}`);
  }

  if (dryRun) {
    log('\ndry run: no certificate files or runs.json entries written');
  } else {
    for (const cert of certs) {
      const file = writeCertificate(cert, outDir);
      log(`wrote ${file}`);
    }
    const doc = JSON.parse(readFileSync(runsPath, 'utf8'));
    let next = doc;
    for (const cert of certs) next = applyCertificate(next, cert);
    writeFileSync(runsPath, JSON.stringify(next, null, 2) + '\n');
    log(`wrote ${runsPath} (${certs.length} certificate${certs.length === 1 ? '' : 's'})`);
  }

  log('\nSUMMARY');
  for (const c of certs) {
    const file = certificateDocumentPath(c.design.processor, c.design.id, outDir);
    log(`  ${challengeName(c.challenge.taskId).padEnd(7)} ${String(c.design.id).padStart(5)}  ${c.verdict.padEnd(9)} ${String(c.mismatches).padStart(3)}/${String(c.inputs).padEnd(6)} ${c.firstFailingInput ?? '-'}  ${c.job.runId}  ${file}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
