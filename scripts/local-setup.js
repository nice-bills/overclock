// Local playground: deploy a mock TapeOut processor and store the Game of Life circuits in it.
//   RPC_URL=http://localhost:8545 PRIVATE_KEY=0x... node scripts/local-setup.js [--w 8] [--h 8]
import { JsonRpcProvider, Wallet, ContractFactory } from 'ethers';
import { artifact } from '../src/chain.js';
import { cellCircuit, boardCircuit } from '../src/life.js';
import { load } from '../src/tap02.js';
const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? Number(process.argv[i + 1]) : d; };
const W = arg('w', 8), H = arg('h', 8);
const w = new Wallet(process.env.PRIVATE_KEY, new JsonRpcProvider(process.env.RPC_URL));
const a = artifact('MockProcessor');
const cpu = await new ContractFactory(a.abi, a.bytecode, w).deploy(); await cpu.waitForDeployment();
const addr = (await cpu.getAddress()).toLowerCase();
const cell = cellCircuit(); const cc = load(cell.netlist, 9, 1);
await (await cpu.store(cell.netlist, 9, 1, 0, cc.nGates)).wait();
const bd = boardCircuit(W, H, addr, 1);
await (await cpu.store(bd.netlist, 0, W * H, W * H, W * H * cc.nGates)).wait();
console.log(JSON.stringify({ cpu: addr, cellId: 1, boardId: 2, w: W, h: H }));
