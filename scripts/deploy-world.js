// Deploy an Overclock World (Red vs Blue Life, contracts/World.sol) next to an existing Overclock: tape out
// the two-colour cell and the 16x16 world on a TapeOut processor, deploy World, and record it in
// deployments/<chainId>.json under "world", where the MCP server's keeper and the site find it.
//
//   RPC_URL=https://testrpc.xlayer.tech PRIVATE_KEY=0x... node scripts/deploy-world.js \
//     [--processor 0x...] [--beats 20] [--epochs 20] [--price 0.0005] [--job-fee 0.0001] [--tip 0.00002] [--fund 0.002]
//     [--hub 0x...] [--adopt 0xOpener]
//
// The processor defaults to the one holding this network's ready-made machines (on mainnet, our Overclock Life
// processor). TapeOut's hub only sends for processors with the original Circuits code, the first 387 the
// factory made; a newer processor's world would never get its season messages out, so this refuses one.
// On X Layer mainnet the world announces each season over TapeSend (--hub defaults to TapeOut's hub there), and
// --adopt hands the world circuit to World and opens its container (TapeOut's opener fee, 0.08 OKB), so every
// epoch is posted by the circuit's own account and the season message comes from it.

import { JsonRpcProvider, Wallet, Contract, ContractFactory, parseEther, formatEther, keccak256 } from 'ethers';
import { readFileSync, writeFileSync } from 'node:fs';
import { artifact } from '../src/chain.js';
import { CIRCUITS_FULL_ABI, TRANSISTORS_ABI, OPENER_ABI, mint, burnCost, tapeout } from '../src/tapeout.js';
import { colourCellCircuit, worldCircuit } from '../src/world.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const provider = new JsonRpcProvider(process.env.RPC_URL, undefined, { cacheTimeout: -1 });
const me = new Wallet(process.env.PRIVATE_KEY, provider);
const net = await provider.getNetwork();
const file = `deployments/${net.chainId}.json`;
const dep = JSON.parse(readFileSync(file, 'utf8'));
const OUR_PROCESSOR = { 196: '0xB00f10BB4b2f32c561BF90e205e543d0a2395971' };
const processor = (arg('processor') ?? dep.machines?.life?.processor ?? OUR_PROCESSOR[Number(net.chainId)]).toLowerCase();
const HUB_CODEHASH = '0x57aa306fd0be97087da3534e03398f5ff4efd533b5be4e45a405ce86fa6717d5';
if (net.chainId === 196n && keccak256(await provider.getCode(processor)) !== HUB_CODEHASH) throw new Error(`TapeOut's hub will not send for ${processor}: pick a processor with the original Circuits code`);
const start = await provider.getBalance(me.address);
console.log(`chain ${net.chainId}, deployer ${me.address}, balance ${formatEther(start)}, processor ${processor}`);

const circuits = new Contract(processor, CIRCUITS_FULL_ABI, me);
const transistors = new Contract(await circuits.transistors(), TRANSISTORS_ABI, me);
const put = async (label, c) => {
  const need = burnCost(c.netlist, c.nIn);
  for (const [id, kind] of [[0, 'nand'], [1, 'latch']]) {
    const have = Number(await transistors.balanceOf(me.address, id));
    if (need[kind] > have) await mint(transistors, id, need[kind] - have);
  }
  const t = await tapeout(circuits, c);
  console.log(`${label}: circuit #${t.id} (${t.gateCount} gates, ${t.nState} state bits)`);
  return Number(t.id);
};

const cellId = await put('colour cell', colourCellCircuit());
const worldId = await put('16x16 world', worldCircuit(16, 16, processor, cellId));
const params = {
  epochBeats: Number(arg('beats', 20)), epochsPerSeason: Number(arg('epochs', 20)),
  cellPrice: parseEther(arg('price', '0.0005')), jobFee: parseEther(arg('job-fee', '0.0001')), keeperTip: parseEther(arg('tip', '0.00002')),
};
const HUBS = { 196: '0xe61A9C7213a6Aa616C246a2B569e555B417b25ee' };
const hub = arg('hub', HUBS[Number(net.chainId)] ?? '0x0000000000000000000000000000000000000000');
const a = artifact('World');
const world = await new ContractFactory(a.abi, a.bytecode, me).deploy(dep.overclock, processor, worldId, params.epochBeats, params.epochsPerSeason, params.cellPrice, params.jobFee, params.keeperTip, hub);
await world.waitForDeployment();
const address = await world.getAddress();
console.log(`World: ${address}`);
let container = null;
if (arg('adopt')) {
  const opener = new Contract(arg('adopt'), OPENER_ABI, me);
  await (await circuits.transferFrom(me.address, address, worldId)).wait();
  await (await world.adopt(opener, parseEther('0.0013'), { value: await opener.FEE() })).wait();
  container = await world.container();
  console.log(`World holds circuit #${worldId}; its container is ${container}`);
}
const fund = parseEther(arg('fund', '0.002'));
if (fund > 0n) await (await world.fund({ value: fund })).wait();

dep.world = {
  address, processor, cellId, circuitId: worldId, w: 16, h: 16, hub, container,
  epochBeats: params.epochBeats, epochsPerSeason: params.epochsPerSeason,
  cellPrice: params.cellPrice.toString(), jobFee: params.jobFee.toString(), keeperTip: params.keeperTip.toString(),
};
writeFileSync(file, JSON.stringify(dep, null, 1) + '\n');
console.log(`wrote ${file}; spent ${formatEther(start - await provider.getBalance(me.address))}`);
