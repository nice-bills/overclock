// Deploys a throwaway Overclock stack on a local dev node (ganache, hardhat): a mock TapeOut
// processor holding a real mainnet circuit (an 8-bit popcount), and Overclock v2 itself.
// Used by the examples and the tests; a real app points at a deployment instead.
import { readFileSync } from 'node:fs';
import { ContractFactory, parseEther } from 'ethers';
import { artifact, load, hexToBytes } from '../src/index.js';

const vectors = JSON.parse(readFileSync(new URL('../../../vendor-tap02/vectors.json', import.meta.url)));
const ZERO = '0x0000000000000000000000000000000000000000';

async function deploy(name, signer, ...args) {
  const a = artifact(name);
  const c = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args);
  await c.waitForDeployment();
  return c;
}

/// Returns { overclock, processor, circuits: { popcount: id }, window, store(netlistHex, nIn, nOut, resolve?) -> id }.
/// Overclock's constructor (v2): (bond, window, factory, treasury, feeBps, bondBps, maxLeafGas, forcedRunner).
export async function deployLocalStack(signer, { bond = parseEther('1'), window = 3600, feeBps = 200, bondBps = 10000 } = {}) {
  const me = await signer.getAddress();
  const cpu = await deploy('MockProcessor', signer);
  const oc = await deploy('Overclock', signer, bond, window, ZERO, me, feeBps, bondBps, 0, ZERO);
  // resolve(addr, id) -> loaded circuit, for a netlist that REFs another
  const store = async (netlistHex, nIn, nOut, resolve = null) => {
    const c = load(hexToBytes(netlistHex), nIn, nOut, resolve);
    const id = await cpu.nextId();
    await (await cpu.store(netlistHex, nIn, nOut, c.nState, c.nGates)).wait();
    return id;
  };
  const pop = vectors.valid.find((v) => v.name === 'popcount8_3151');
  return {
    overclock: await oc.getAddress(),
    processor: await cpu.getAddress(),
    circuits: { popcount: await store(pop.netlist, pop.nIn, pop.nOut) },
    window,
    store,
  };
}
