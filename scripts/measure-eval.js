// Gas of a direct TapeOut eval() too big for an X Layer block (and for estimateGas to search over).
//
//   npx ganache --fork.url https://rpc.xlayer.tech --chain.chainId 196 --chain.hardfork shanghai \
//     --miner.blockGasLimit 2000000000 --miner.callGasLimit 2000000000 --port 8546
//   node scripts/measure-eval.js http://127.0.0.1:8546 [processor] [id] [inputs]
//
// Deploys contracts/GasProbe.sol on the fork and eth_calls eval through it. Hardhat's node runs
// out of memory tracing a call this size; ganache does not. Defaults: the digit net on the 7.

import { JsonRpcProvider, ContractFactory, Wallet, keccak256, toUtf8Bytes, Interface } from 'ethers';
import { artifact } from '../src/chain.js';
import { DIGIT_NET, DIGITS } from '../src/digits.js';

const [rpc = 'http://127.0.0.1:8546', cpu = DIGIT_NET.processor, id = DIGIT_NET.id, inputs = DIGITS[7]] = process.argv.slice(2);
const p = new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1 });
const w = new Wallet(keccak256(toUtf8Bytes('overclock-fork:9')), p);
const rich = '0x3635c9adc5dea00000';
await p.send('hardhat_setBalance', [w.address, rich]).catch(() => p.send('evm_setAccountBalance', [w.address, rich]));
const a = artifact('GasProbe');
const probe = await new ContractFactory(a.abi, a.bytecode, w).deploy();
await probe.waitForDeployment();
const i = new Interface(['function eval(uint256 id, bytes inputs) view returns (bytes)']);
const started = Date.now();
const [gas, ret] = await probe.measure(cpu, i.encodeFunctionData('eval', [BigInt(id), inputs]), { gasLimit: 1_990_000_000 });
console.log(JSON.stringify({ cpu, id: String(id), inputs, gas: Number(gas), outputs: i.decodeFunctionResult('eval', ret)[0], blocks: Number(gas) / 210e6, ms: Date.now() - started }));
