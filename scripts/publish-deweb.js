// Publish web/overclock.html as a DeWEB site in a TapeOut circuit's container on X Layer (TapeKit SPEC
// Appendix B). By default the site goes into the 8x8 Life board circuit (#5 on the OKspace processor), the
// circuit that ran the first mainnet job, so the job board lives in that circuit's own container.
//
//   PRIVATE_KEY=0x… node scripts/publish-deweb.js [--open] [--dry-run] [--circuit 5] [--cpu 0x…] [--file web/overclock.html]
//
// Opening a circuit's container (ERC-6551 account) costs a one-off fee (0.08 OKB on X Layer when written);
// the script only pays it with --open. Files cost gas only, and name activation is free on X Layer
// (DomainBinding.monthlyFee() is 0), so the script activates the name for the full 120 months when it is free.
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { JsonRpcProvider, Wallet, NonceManager, Contract, formatEther } from 'ethers';

const args = process.argv.slice(2);
const flag = (k, d) => { const i = args.indexOf(`--${k}`); return i < 0 ? d : args[i + 1]; };
const has = (k) => args.includes(`--${k}`);

const RPC = flag('rpc', process.env.RPC_URL ?? 'https://rpc.xlayer.tech');
const CPU = flag('cpu', '0xb00f10bb4b2f32c561bf90e205e543d0a2395971');
const ID = BigInt(flag('circuit', '5'));
const FILE = flag('file', 'web/overclock.html');
const PATH = 'index.html';
const TYPE = 'text/html; charset=utf-8';
const CHUNK = 24_000;
const X = {
  factory: '0x1f09daefa827f02cbb40967cc91b259763760761',
  opener: '0x536add8f30f03b69f6fbf29d425a816a0dc50106',
  registry: '0xd6efb7adcc9c83dc4924ad56f6a8e4e969b9adb6',
  binding: '0x68809fd2fb343aa57d0aeb7f33defe477c9666f9',
};

const provider = new JsonRpcProvider(RPC, undefined, { staticNetwork: true, batchMaxCount: 10 });
const key = new Wallet(process.env.PRIVATE_KEY, provider);
const wallet = new NonceManager(key);
wallet.address = key.address;
const factory = new Contract(X.factory, ['function cpuCount() view returns (uint256)', 'function cpuAt(uint256) view returns (address)'], provider);
const circuits = new Contract(CPU, ['function ownerOf(uint256) view returns (address)'], provider);
const opener = new Contract(X.opener, ['function isOpened(address,uint256) view returns (bool)', 'function accountOf(address,uint256) view returns (address)', 'function open(address,uint256) payable returns (address)'], wallet);
const registry = new Contract(X.registry, [
  'function fileInfo(address,string) view returns (uint32 size, string contentType, bytes32 sha256Hash, uint40 updatedAt, uint256 chunkCount)',
  'function putFile(address,string,string,bytes32,bytes)',
  'function appendChunk(address,string,uint256,bytes)',
], wallet);
const binding = new Contract(X.binding, ['function monthlyFee() view returns (uint256)', 'function isContainerLive(address) view returns (bool)', 'function bind(string,address,uint256) payable'], wallet);

const { chainId } = await provider.getNetwork();
if (chainId !== 196n) console.log(`note: chain ${chainId}, not X Layer mainnet (a fork?)`);
const owner = await circuits.ownerOf(ID);
if (owner.toLowerCase() !== wallet.address.toLowerCase()) throw new Error(`circuit #${ID} belongs to ${owner}, not ${wallet.address}`);

// the on-chain name: <id>.<area>.<processor index>.tape, X Layer is area 2
let index = -1;
const n = Number(await factory.cpuCount());
for (let i = 0; i < n && index < 0; i += 10) {
  const page = await Promise.all(Array.from({ length: Math.min(10, n - i) }, (_, k) => factory.cpuAt(i + k)));
  const k = page.findIndex((a) => a.toLowerCase() === CPU.toLowerCase());
  if (k >= 0) index = i + k;
}
if (index < 0) throw new Error(`${CPU} is not a TapeOut processor`);
const name = `${ID}.2.${index}.tape`;
const container = await opener.accountOf(CPU, ID);
const bytes = readFileSync(FILE);
const sha = '0x' + createHash('sha256').update(bytes).digest('hex');
const chunks = [];
for (let o = 0; o < bytes.length; o += CHUNK) chunks.push(bytes.subarray(o, o + CHUNK));
const balance = await provider.getBalance(wallet.address);
console.log(`site ${name} · container ${container} · ${FILE} ${bytes.length} bytes in ${chunks.length} chunks · sha256 ${sha}`);
console.log(`wallet ${wallet.address} holds ${formatEther(balance)} OKB`);

async function send(what, txp) {
  const tx = await txp;
  const r = await tx.wait();
  console.log(`${what}: ${r.gasUsed} gas, ${tx.hash}`);
  return r;
}

if (!(await opener.isOpened(CPU, ID))) {
  let fee = 0n;
  try { await opener.open.staticCall(CPU, ID, { value: 0 }); } catch (e) {
    // the opener reverts with (sent, required) under selector 0xf04f3db2 when the fee is wrong
    if (typeof e.data !== 'string' || !e.data.startsWith('0xf04f3db2')) throw e;
    fee = BigInt('0x' + e.data.slice(-64));
  }
  console.log(`the container is not open yet: opening it costs ${formatEther(fee)} OKB`);
  if (!has('open') || has('dry-run')) { console.log('re-run with --open to pay it'); process.exit(has('dry-run') ? 0 : 1); }
  if (balance < fee) throw new Error(`need ${formatEther(fee)} OKB plus gas, have ${formatEther(balance)}`);
  await send('open container', opener.open(CPU, ID, { value: fee }));
}

const info = await registry.fileInfo(container, PATH);
if (info.sha256Hash === sha && Number(info.size) === bytes.length && Number(info.chunkCount) === chunks.length) {
  console.log(`${PATH} is already up to date`);
} else if (has('dry-run')) {
  const gas = await registry.putFile.estimateGas(container, PATH, TYPE, sha, chunks[0]);
  const price = (await provider.getFeeData()).gasPrice;
  console.log(`dry run: first chunk ${gas} gas; whole file about ${gas * BigInt(chunks.length)} gas ≈ ${formatEther(gas * BigInt(chunks.length) * price)} OKB`);
} else {
  // an interrupted upload of the same bytes resumes where it stopped
  let k = info.sha256Hash === sha && Number(info.chunkCount) < chunks.length ? Number(info.chunkCount) : 0;
  if (k === 0) { await send(`put ${PATH} chunk 0`, registry.putFile(container, PATH, TYPE, sha, chunks[0])); k = 1; }
  for (; k < chunks.length; k++) await send(`append chunk ${k}`, registry.appendChunk(container, PATH, k, chunks[k]));
}

if (!(await binding.isContainerLive(container))) {
  const fee = await binding.monthlyFee();
  if (fee === 0n && !has('dry-run')) await send(`activate ${name} for 120 months (free)`, binding.bind(name, container, 120));
  else console.log(`${name} is not activated: ${formatEther(fee)} OKB per 30 days${has('dry-run') ? '' : '; activate it from the HashPort console or DomainBinding.bind'}`);
}

console.log(`\nopen it at https://${ID}-2-${index}.tapekit.org/  (status: https://${ID}-2-${index}.tapekit.org/.tape/status)`);
console.log(`or in a TapeKit browser at tape://${name}`);
