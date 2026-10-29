// Rehearse an Overclock World season against the real TapeOut contracts on a local fork of X Layer mainnet
// (npm run fork), and print what each step cost in gas. Nothing is broadcast to X Layer.
//
//   node scripts/rehearse-world.js [--fork http://127.0.0.1:8545] [--processor 0x... | --processor new]
//
// The world is taped out on our own processor by default. TapeOut's hub only sends for processors with the
// original Circuits code (the first 387 the factory made, ours among them); a processor created today gets
// newer code and the hub refuses it (error 0x853f2907), so a world on one could never announce its seasons.
//
// The flow is the mainnet launch: create a processor, tape out the colour cell and the 16x16 world, deploy
// Overclock and World (with TapeOut's real DeWEB hub), hand the world circuit to World and open its
// container through TapeOut's real opener, buy cells, run one epoch as an Overclock job posted by that
// container, and end the season with a TapeSend message from the container.

import { JsonRpcProvider, Wallet, Contract, ContractFactory, parseEther, formatEther, formatUnits, keccak256, toUtf8Bytes } from 'ethers';
import { load, pack, unpack, hexToBytes, bytesToHex } from '../src/tap02.js';
import { traceJob, buildTree } from '../src/trace.js';
import { artifact } from '../src/chain.js';
import { XLAYER, createCPU, mint, burnCost, tapeout, OPENER_ABI, CIRCUITS_FULL_ABI, TRANSISTORS_ABI } from '../src/tapeout.js';
import { colourCellCircuit, worldCircuit, fromWorldState } from '../src/world.js';

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const HUB = '0xe61A9C7213a6Aa616C246a2B569e555B417b25ee';
const OUR_PROCESSOR = '0xB00f10BB4b2f32c561BF90e205e543d0a2395971'; // Overclock Life, ours on mainnet
const HUB_ABI = ['event Sent(bytes32 indexed to, address indexed from, bytes32 indexed ref, uint256 inboxIndex, uint256 outboxIndex, bytes payload)'];
const W = 16, H = 16, BEATS = 2, BOND = parseEther('0.001'), WINDOW = 600;
const PRICE = parseEther('0.0005'), JOB_FEE = parseEther('0.0001'), TIP = parseEther('0.00002');

const provider = new JsonRpcProvider(arg('fork', 'http://127.0.0.1:8545'), undefined, { polling: true, pollingInterval: 250, cacheTimeout: -1 });
const net = await provider.getNetwork();
if (net.chainId !== 196n) throw new Error(`expected a fork of X Layer mainnet (196), got ${net.chainId}`);
const [me, op, red, blue, keeper] = [0, 1, 2, 3, 4].map((i) => new Wallet(keccak256(toUtf8Bytes(`overclock-world-fork:${i}`)), provider));
for (const w of [me, op, red, blue, keeper]) await provider.send('hardhat_setBalance', [w.address, '0x3635c9adc5dea00000']);

const gas = [];
const note = (what, rc, value = 0n) => {
  gas.push({ what, gas: rc.gasUsed, value });
  console.log(`  ${what.padEnd(46)} ${rc.gasUsed.toLocaleString().padStart(12)} gas${value ? `  + ${formatEther(value)} OKB` : ''}`);
  return rc;
};
const deploy = async (name, ...args) => {
  const c = await new ContractFactory(artifact(name).abi, artifact(name).bytecode, me).deploy(...args);
  note(`deploy ${name}`, await c.deploymentTransaction().wait());
  return c;
};

let cpu;
if (arg('processor', OUR_PROCESSOR) === 'new') {
  const factory = new Contract(XLAYER.factory, ['function deployFee() view returns (uint256)'], provider);
  const deployFee = await factory.deployFee();
  cpu = await createCPU(me, XLAYER.factory, { name: 'Overclock World', symbol: 'OCWORLD', story: 'Red vs Blue, a shared Game of Life run by Overclock.', supply: 1_000_000, mintPrice: parseEther('0.00001') });
  note('createCPU', cpu.receipt, deployFee);
} else {
  const circuits = new Contract(arg('processor', OUR_PROCESSOR), CIRCUITS_FULL_ABI, me);
  cpu = { circuits, transistors: new Contract(await circuits.transistors(), TRANSISTORS_ABI, me) };
}
const cpuAddr = (await cpu.circuits.getAddress()).toLowerCase();
const put = async (label, c) => {
  const need = burnCost(c.netlist, c.nIn);
  for (const [id, kind] of [[0, 'nand'], [1, 'latch']]) {
    if (!need[kind]) continue;
    const value = BigInt(need[kind]) * (await cpu.transistors.mintPrice()) + (await cpu.transistors.protocolFee());
    note(`mint ${need[kind]} ${kind} transistors`, await mint(cpu.transistors, id, need[kind]), value);
  }
  const t = await tapeout(cpu.circuits, c);
  note(`tapeout ${label} (#${t.id}, ${t.gateCount} gates)`, t.receipt, await cpu.circuits.TAPEOUT_FEE());
  return Number(t.id);
};
const cell = colourCellCircuit();
const cellId = await put('colour cell', cell);
const wd = worldCircuit(W, H, cpuAddr, cellId);
const worldId = await put('16x16 world', wd);
const cc = load(cell.netlist, cell.nIn, cell.nOut);
const wc = load(wd.netlist, wd.nIn, wd.nOut, (a, i) => (a.toLowerCase() === cpuAddr && Number(i) === cellId ? cc : null));

const oc = await deploy('Overclock', BOND, WINDOW, XLAYER.factory, me.address, 200);
const world = await deploy('World', await oc.getAddress(), cpuAddr, worldId, BEATS, 1, PRICE, JOB_FEE, TIP, HUB);
const opener = new Contract(XLAYER.opener, OPENER_ABI, me);
note('hand the world circuit to World', await (await cpu.circuits.transferFrom(me.address, await world.getAddress(), worldId)).wait());
const openFee = await opener.FEE();
note('adopt: open its container', await (await world.adopt(XLAYER.opener, parseEther('0.0013'), { value: openFee })).wait(), openFee);
const container = await world.container();
console.log(`  container ${container}`);

const mask = (cells) => cells.reduce((m, [x, y]) => m | (1n << BigInt(y * W + x)), 0n);
note('place 3 blue cells', await (await world.connect(blue).place(2, mask([[3, 3], [4, 3], [5, 3]]), { value: PRICE * 3n })).wait(), PRICE * 3n);
note('place 4 red cells', await (await world.connect(red).place(1, mask([[10, 10], [11, 10], [10, 11], [11, 11]]), { value: PRICE * 4n })).wait(), PRICE * 4n);
const fuel = parseEther('0.005');
note('fund', await (await world.fund({ value: fuel })).wait(), fuel);

const rc = note('advance: container posts the epoch', await (await world.connect(keeper).advance()).wait());
const jobId = rc.logs.map((l) => { try { return world.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === 'EpochStarted').args.jobId;
const j = await oc.jobs(jobId);
if (j.poster.toLowerCase() !== container.toLowerCase()) throw new Error(`job ${jobId} was posted by ${j.poster}, not the container`);
const t = traceJob(wc, { state: unpack(hexToBytes(j.state), 2 * W * H), beats: BEATS });
note('operator claims', await (await oc.connect(op).claim(jobId, buildTree(t.leaves).root, bytesToHex(pack(t.outputs)), bytesToHex(pack(t.newState)), { value: BOND })).wait(), BOND);
await provider.send('evm_increaseTime', [WINDOW + 1]);
await provider.send('evm_mine', []);
note('operator finalizes', await (await oc.connect(op).finalize(jobId)).wait());

const end = note('advance: season ends, TapeSend announcement', await (await world.connect(keeper).advance()).wait());
const hub = new Contract(HUB, HUB_ABI, provider);
const sent = end.logs.filter((l) => l.address.toLowerCase() === HUB.toLowerCase()).map((l) => hub.interface.parseLog(l)).find((x) => x?.name === 'Sent');
const failed = end.logs.map((l) => { try { return world.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === 'AnnounceFailed');
if (!sent || failed) throw new Error('the season was not announced over TapeSend');
if (sent.args.from.toLowerCase() !== container.toLowerCase()) throw new Error(`sent from ${sent.args.from}, not the container`);
const msg = JSON.parse(new TextDecoder().decode(hexToBytes(sent.args.payload).slice(4)));
console.log(`\n  TapeSend from the world's container (inbox #${sent.args.inboxIndex}):\n  ${msg.subject}\n${msg.body.split('\n').map((l) => `    ${l}`).join('\n')}`);
console.log(`  board after the epoch: ${fromWorldState(t.newState).filter(Boolean).length} live cells`);

const { gasPrice } = await new JsonRpcProvider(XLAYER.rpc).getFeeData();
const launch = gas.filter((g) => /createCPU|mint|tapeout|deploy|hand|adopt/.test(g.what));
const launchGas = launch.reduce((s, g) => s + g.gas, 0n), launchValue = launch.reduce((s, g) => s + g.value, 0n);
console.log(`\n  launch: ${launchGas.toLocaleString()} gas at ${formatUnits(gasPrice, 'gwei')} gwei = ${formatEther(launchGas * gasPrice)} OKB, plus ${formatEther(launchValue)} OKB paid to TapeOut (processor, transistors, tapeouts, container)`);
