// Deploy Overclock to any EVM chain. Overclock reads circuits from whichever TapeOut processor a
// job names, so one deployment serves every circuit on the chain.
//
//   RPC_URL=https://rpc.xlayer.tech PRIVATE_KEY=0x... node scripts/deploy.js [--bond 0.001] [--window 600]
//     [--factory 0x...] [--treasury 0x...] [--fee-bps 200]
//
// The treasury defaults to the deploying wallet. Prints the address and writes deployments/<chainId>.json.

import { JsonRpcProvider, Wallet, ContractFactory, parseEther } from 'ethers';
import { writeFileSync, mkdirSync } from 'node:fs';
import { artifact } from '../src/chain.js';
import { XLAYER } from '../src/tapeout.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const provider = new JsonRpcProvider(process.env.RPC_URL ?? 'https://rpc.xlayer.tech');
const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
const net = await provider.getNetwork();
const a = artifact('Overclock');
const bond = parseEther(arg('bond', '0.001')), window = Number(arg('window', 600));
const factory = arg('factory', XLAYER.factory), treasury = arg('treasury', wallet.address), feeBps = Number(arg('fee-bps', 200));
console.log(`deploying Overclock to chain ${net.chainId} from ${wallet.address} (bond ${arg('bond', '0.001')}, window ${window}s, factory ${factory}, fee ${feeBps} bps)`);
const c = await new ContractFactory(a.abi, a.bytecode, wallet).deploy(bond, window, factory, treasury, feeBps);
await c.waitForDeployment();
const rc = await c.deploymentTransaction().wait();
const address = await c.getAddress();
console.log(`Overclock: ${address} (tx ${rc.hash}, ${rc.gasUsed} gas, block ${rc.blockNumber})`);
console.log(`export OVERCLOCK=${address}`);
mkdirSync('deployments', { recursive: true });
writeFileSync(`deployments/${net.chainId}.json`, JSON.stringify({ chainId: Number(net.chainId), overclock: address, tx: rc.hash, block: rc.blockNumber, gas: Number(rc.gasUsed), bond: bond.toString(), window, factory, treasury, feeBps }, null, 1) + '\n');
