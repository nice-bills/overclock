// A local v2 stack for the circuit-tool tests (mcp-circuits.test.js and mcp-circuits-e2e.test.js):
// ganache, the TapeOut stand-in, one processor holding real FabX data taped out by `owner`, and an
// Overclock v2 (the 8-argument constructor).
//
//   design   GC-094 miner #2346's actual netlist (fails official vector 17 at cycle 4)
//   ref      GC-094's official reference
//   good     a second copy of the reference: a miner that passes every official vector
//   zeroDesign / zeroRef   a GC-098-style constant-output pair (an unsound reference)
//   stranger  a circuit nobody registered as a FabX miner
import ganache from 'ganache';
import { JsonRpcProvider, Wallet, ContractFactory, parseEther } from 'ethers';
import { hexToBytes } from '../../src/tap02.js';
import { Builder } from '../../src/hdl.js';
import { artifact } from '../../src/chain.js';
import { createCPU, mint, burnCost, tapeout } from '../../src/tapeout.js';
import { GC094 } from '../fixtures/gc094.js';

export const WINDOW = 3600;
export const BOND = parseEther('1');
const ZERO = '0x0000000000000000000000000000000000000000';

// one input, one state, always outputs 0
function zeroTicker() {
  const b = new Builder(1);
  const q = b.latch();
  b.setLatch(q, b.zero);
  return b.build([q]);
}

export async function startStack() {
  const port = 20000 + Math.floor(Math.random() * 20000);
  const server = ganache.server({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, wallet: { deterministic: true, totalAccounts: 4, defaultBalance: 1000 } });
  await server.listen(port);
  const keys = Object.values(server.provider.getInitialAccounts()).map((a) => a.secretKey);
  const url = `http://127.0.0.1:${port}`;
  const provider = new JsonRpcProvider(url, undefined, { cacheTimeout: -1 });
  const owner = new Wallet(keys[0], provider);
  const deploy = async (name, ...args) => {
    const a = artifact(name);
    const c = await new ContractFactory(a.abi, a.bytecode, owner).deploy(...args);
    await c.waitForDeployment();
    return c;
  };
  const factory = await deploy('TapeOutFactoryLocal');
  const cpu = await createCPU(owner, await factory.getAddress(), { name: 'Circuits', symbol: 'CIR', story: '', supply: 1_000_000, mintPrice: 1n });
  const processor = (await cpu.circuits.getAddress()).toLowerCase();
  const put = async ({ netlist, nIn, nOut }) => {
    const need = burnCost(netlist, nIn);
    await mint(cpu.transistors, 0, need.nand);
    await mint(cpu.transistors, 1, need.latch);
    return Number((await tapeout(cpu.circuits, { netlist, nIn, nOut })).id);
  };
  const gc = (c) => ({ netlist: hexToBytes(c.netlist), nIn: c.nIn, nOut: c.nOut });
  const ids = {
    design: await put(gc(GC094.design)),
    ref: await put(gc(GC094.reference)),
    good: await put(gc(GC094.reference)),
  };
  const zero = zeroTicker();
  ids.zeroDesign = await put(zero);
  ids.zeroRef = await put(zero);
  ids.stranger = await put(zero);
  const overclock = await deploy('Overclock', BOND, WINDOW, await factory.getAddress(), owner.address, 200, 5000, 0, ZERO);
  const zeroVectors = Array.from({ length: 4 }, (_, index) => ({ index, input: '0x0000', expectedOut: '0x0000' }));
  const fixture = {
    miners: { [`${processor}#${ids.design}`]: 94, [`${processor}#${ids.good}`]: 94, [`${processor}#${ids.zeroDesign}`]: 98 },
    tasks: {
      94: { ...GC094.task, refCircuits: processor, refCircuitId: ids.ref },
      98: { taskId: 98, name: 'GC-098 test constant zero', kind: 1, cycles: 2, nIn: 1, nOut: 1, refCircuits: processor, refCircuitId: ids.zeroRef },
    },
    vectors: { 94: GC094.vectors, 98: zeroVectors },
  };
  return {
    server, keys, url, provider, owner, processor, ids, fixture,
    overclock: await overclock.getAddress(), oc: overclock, factory: await factory.getAddress(),
    close: () => server.close(),
  };
}
