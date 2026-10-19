// Deploy a complete Overclock playground to a chain without TapeOut (X Layer testnet, a local node):
// the TapeOut stand-in (contracts/TapeOutLocal.sol), one processor holding the ready-made machines
// (the Game of Life cell and 8x8 board, the 4-bit CPU), and Overclock itself. Writes
// deployments/<chainId>.json, which the MCP server reads for the default contract and machines.
//
//   RPC_URL=https://testrpc.xlayer.tech PRIVATE_KEY=0x... node scripts/deploy-stack.js [--bond 0.001] [--window 120]

import { JsonRpcProvider, Wallet, ContractFactory, parseEther, formatEther } from 'ethers';
import { writeFileSync, mkdirSync } from 'node:fs';
import { artifact } from '../src/chain.js';
import { createCPU, mint, burnCost, tapeout } from '../src/tapeout.js';
import { cellCircuit, boardCircuit } from '../src/life.js';
import { cpuCircuit } from '../src/cpu4.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const provider = new JsonRpcProvider(process.env.RPC_URL, undefined, { cacheTimeout: -1 });
// Public RPCs behind load balancers can answer a read from a node that has not seen the last block
// yet; a contract we just deployed then looks empty. Retry empty call results for a while.
const call = provider.call.bind(provider);
provider.call = async (tx) => {
  for (let i = 0; ; i++) {
    const r = await call(tx);
    if (r !== '0x' || i === 20) return r;
    await new Promise((ok) => setTimeout(ok, 1500));
  }
};
const me = new Wallet(process.env.PRIVATE_KEY, provider);
// The same lag can hand out a stale nonce: take the highest of a few answers once, then count.
let nonce = null;
me.getNonce = async () => {
  if (nonce === null) for (let i = 0; i < 5; i++) nonce = Math.max(nonce ?? 0, await provider.getTransactionCount(me.address, 'pending'));
  return nonce++;
};
const net = await provider.getNetwork();
const start = await provider.getBalance(me.address);
console.log(`chain ${net.chainId}, deployer ${me.address}, balance ${formatEther(start)}`);

const deploy = async (name, ...args) => {
  const a = artifact(name);
  const c = await new ContractFactory(a.abi, a.bytecode, me).deploy(...args);
  await c.waitForDeployment();
  console.log(`${name}: ${await c.getAddress()}`);
  return c;
};

const factory = await deploy('TapeOutFactoryLocal');
const { transistors, circuits } = await createCPU(me, await factory.getAddress(), { name: 'Overclock Playground', symbol: 'OCP', story: 'Ready-made machines for trying Overclock', supply: 1_000_000, mintPrice: 1n });
const processor = (await circuits.getAddress()).toLowerCase();
console.log(`processor: ${processor}`);

const put = async (label, c) => {
  const need = burnCost(c.netlist, c.nIn);
  for (const [id, kind] of [[0, 'nand'], [1, 'latch']]) {
    const have = Number(await transistors.balanceOf(me.address, id));
    if (need[kind] > have) await mint(transistors, id, need[kind] - have);
  }
  const t = await tapeout(circuits, c);
  console.log(`${label}: circuit #${t.id} (${t.gateCount} gates)`);
  return Number(t.id);
};
const cellId = await put('life cell', cellCircuit());
const boardId = await put('life 8x8 board', boardCircuit(8, 8, processor, cellId));
const cpuId = await put('4-bit CPU', cpuCircuit());

const bond = arg('bond', '0.001'), window = Number(arg('window', 120));
const oc = await deploy('Overclock', parseEther(bond), window, await factory.getAddress(), me.address, 200);
const out = {
  chainId: Number(net.chainId), overclock: await oc.getAddress(), factory: await factory.getAddress(),
  bond: parseEther(bond).toString(), window, feeBps: 200, treasury: me.address, tapeout: 'TapeOutLocal stand-in',
  machines: { life: { processor, circuitId: boardId }, cpu: { processor, circuitId: cpuId } },
};
mkdirSync('deployments', { recursive: true });
writeFileSync(`deployments/${net.chainId}.json`, JSON.stringify(out, null, 1) + '\n');
console.log(`wrote deployments/${net.chainId}.json; spent ${formatEther(start - await provider.getBalance(me.address))}`);
