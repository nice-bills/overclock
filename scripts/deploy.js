// Deploy Overclock to any EVM chain. Overclock reads circuits from whichever TapeOut processor a
// job names, so one deployment serves every circuit on the chain.
//
//   RPC_URL=https://rpc.xlayer.tech PRIVATE_KEY=0x... node scripts/deploy.js [--bond 0.05] [--window 3600]

import { JsonRpcProvider, Wallet, ContractFactory, parseEther } from 'ethers';
import { artifact } from '../src/chain.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const provider = new JsonRpcProvider(process.env.RPC_URL ?? 'https://rpc.xlayer.tech');
const wallet = new Wallet(process.env.PRIVATE_KEY, provider);
const net = await provider.getNetwork();
const a = artifact('Overclock');
const bond = parseEther(arg('bond', '0.05')), window = Number(arg('window', 3600));
console.log(`deploying Overclock to chain ${net.chainId} from ${wallet.address} (bond ${arg('bond', '0.05')}, window ${window}s)`);
const c = await new ContractFactory(a.abi, a.bytecode, wallet).deploy(bond, window);
await c.waitForDeployment();
console.log(`Overclock: ${await c.getAddress()}`);
console.log(`export OVERCLOCK=${await c.getAddress()}`);
