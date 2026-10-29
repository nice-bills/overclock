// Client for TapeOut's X Layer contracts: create a processor, mint transistors, tape out netlists,
// open a circuit's ERC-6551 account. Works the same against the real contracts (mainnet or a fork)
// and against contracts/TapeOutLocal.sol.

import { Contract } from 'ethers';
import { decode, NAND, LATCH } from './tap02.js';

export const XLAYER = {
  chainId: 196,
  rpc: 'https://rpc.xlayer.tech',
  factory: '0x1f09daefa827f02cbb40967cc91b259763760761',
  opener: '0x536add8f30f03b69f6fbf29d425a816a0dc50106',
  overclock: '0xe29FD6E33De7810181BdA3FcAE4A8B5B0824E710', // deployments/196.json
};

export const FACTORY_ABI = [
  'function createCPU(string name, string symbol, string story, uint256 transistorSupply, uint256 mintPrice) payable returns (address transistors, address circuits)',
  'function deployFee() view returns (uint256)',
  'function cpuCount() view returns (uint256)',
  'function cpus(uint256 i) view returns (address)',
  'function isCPU(address circuits) view returns (bool)',
  'event CPUCreated(address indexed circuits, address indexed transistors, address indexed creator, string name, uint256 supply, uint256 mintPrice)',
];
export const TRANSISTORS_ABI = [
  'function mint(uint256 id, uint256 amount) payable',
  'function mintPrice() view returns (uint256)',
  'function protocolFee() view returns (uint256)',
  'function balanceOf(address account, uint256 id) view returns (uint256)',
];
export const CIRCUITS_FULL_ABI = [
  'function tapeout(bytes nl, uint32 nIn, uint32 nOut) payable returns (uint256)',
  'function TAPEOUT_FEE() view returns (uint256)',
  'function circuitInfo(uint256 id) view returns (uint32 nIn, uint32 nOut, uint32 nState, uint32 gateCount)',
  'function netlist(uint256 id) view returns (bytes)',
  'function eval(uint256 id, bytes inputs) view returns (bytes)',
  'function step(uint256 id, bytes state, bytes inputs) view returns (bytes newState, bytes outputs)',
  'function nextId() view returns (uint256)',
  'function ownerOf(uint256 id) view returns (address)',
  'function transferFrom(address from, address to, uint256 id)',
  'function transistors() view returns (address)',
  'event TapedOut(uint256 indexed circuitId, address indexed author, uint32 gateCount, uint32 nState)',
];
export const OPENER_ABI = [
  'function FEE() view returns (uint256)',
  'function open(address circuits, uint256 tokenId) payable returns (address)',
  'function accountOf(address circuits, uint256 tokenId) view returns (address)',
  'function isOpened(address circuits, uint256 tokenId) view returns (bool)',
];
export const ACCOUNT_ABI = [
  'function execute(address to, uint256 value, bytes data, uint8 operation) payable returns (bytes)',
  'function owner() view returns (address)',
  'function token() view returns (uint256 chainId, address tokenContract, uint256 tokenId)',
];

const eventArgs = (rc, iface, name) => rc.logs.map((l) => { try { return iface.parseLog(l); } catch { return null; } }).find((e) => e?.name === name)?.args;

export async function createCPU(signer, factoryAddr, { name, symbol, story, supply, mintPrice }) {
  const f = new Contract(factoryAddr, FACTORY_ABI, signer);
  const rc = await (await f.createCPU(name, symbol, story, supply, mintPrice, { value: await f.deployFee() })).wait();
  const ev = eventArgs(rc, f.interface, 'CPUCreated');
  return {
    transistors: new Contract(ev.transistors, TRANSISTORS_ABI, signer),
    circuits: new Contract(ev.circuits, CIRCUITS_FULL_ABI, signer),
    receipt: rc,
  };
}

export async function mint(transistors, id, amount) {
  if (amount <= 0) return null;
  const value = BigInt(amount) * (await transistors.mintPrice()) + (await transistors.protocolFee());
  return (await transistors.mint(id, amount, { value })).wait();
}

// Transistors a tapeout burns: one per NAND and per LATCH record. REFs are free.
export function burnCost(netlist, nIn) {
  let nand = 0, latch = 0;
  for (const e of decode(netlist, nIn)) {
    if (e.op === NAND) nand++;
    else if (e.op === LATCH) latch++;
  }
  return { nand, latch };
}

export async function tapeout(circuits, { netlist, nIn, nOut }) {
  const rc = await (await circuits.tapeout(netlist, nIn, nOut, { value: await circuits.TAPEOUT_FEE() })).wait();
  const ev = eventArgs(rc, circuits.interface, 'TapedOut');
  return { id: ev.circuitId, gateCount: Number(ev.gateCount), nState: Number(ev.nState), receipt: rc };
}
