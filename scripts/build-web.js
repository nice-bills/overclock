// Inline web/demo-run.json, the mainnet run web/live-run.json (which the replay prefers), the job board script and its event snapshot,
// the circuit census (docs/census.json), the evaluator (src/tap02.js), web/try.js, web/run.js and web/world.js
// with their network configs into web/index.html, producing one
// self-contained page (web/overclock.html) that can be uploaded as a DeWEB site or opened from disk.
//
//   node scripts/build-web.js [run.json] [out.html]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const json = (path) => readFileSync(path, 'utf8').trim().replace(/</g, '\\u003c');
const page = readFileSync('web/index.html', 'utf8');
const run = json(process.argv[2] ?? 'web/demo-run.json');
const live = existsSync('web/live-run.json') ? json('web/live-run.json') : 'null';
const snapshot = existsSync('web/board-snapshot.json') ? json('web/board-snapshot.json') : 'null';
const board = readFileSync('web/board.js', 'utf8').replace(/<\/script/gi, '<\\/script');
const tryJs = readFileSync('web/try.js', 'utf8').replace(/<\/script/gi, '<\\/script');
// src/tap02.js as a classic script exposing TAP02, for web/try.js.
const tap02 = 'const TAP02 = (function () {\n' + readFileSync('src/tap02.js', 'utf8').replace(/^export /gm, '') +
  '\nreturn { NAND, LATCH, REF, hexToBytes, bytesToHex, decode, load, beat, pack, unpack };\n})();';
// The census summary and the circuits the page lists, not every row.
const census = existsSync('docs/census.json')
  ? (({ summary, featured }) => JSON.stringify({ summary, featured }).replace(/</g, '\\u003c'))(JSON.parse(readFileSync('docs/census.json', 'utf8')))
  : 'null';
const runJs = readFileSync('web/run.js', 'utf8').replace(/<\/script/gi, '<\\/script');
// Where "Run a job" posts: the testnet playground (scripts/deploy-stack.js), whose hosted MCP server runs an
// operator. The CPU's starting state (the Fibonacci program in ROM) is computed here from src/cpu4.js.
const { toState, fibonacciMachine } = await import('../src/cpu4.js');
const { pack, bytesToHex } = await import('../src/tap02.js');
const t = JSON.parse(readFileSync('deployments/1952.json', 'utf8'));
const OKB = { name: 'OKB', symbol: 'OKB', decimals: 18 };
const runConfig = JSON.stringify({
  default: 'testnet',
  cpuState: bytesToHex(pack(toState(fibonacciMachine()))),
  networks: {
    testnet: {
      name: 'X Layer testnet', chainId: 1952, rpc: ['https://testrpc.xlayer.tech'],
      chain: { chainId: '0x7a0', chainName: 'X Layer Testnet', nativeCurrency: OKB, rpcUrls: ['https://testrpc.xlayer.tech'], blockExplorerUrls: ['https://www.oklink.com/x-layer-testnet'] },
      explorer: 'https://www.oklink.com/x-layer-testnet', faucet: 'https://www.okx.com/xlayer/faucet',
      operatorUrl: 'https://overclock-mcp-testnet.onrender.com/',
      overclock: t.overclock, processor: t.machines.life.processor,
      machines: { life: t.machines.life.circuitId, cpu: t.machines.cpu.circuitId },
    },
  },
});
// Overclock World (#world): the mainnet world if there is one, else the testnet one. WORLD_DEPLOYMENT and WORLD_RPC
// point the page at another (a local fork, say) for development.
const NETS = {
  196: { name: 'X Layer', rpc: ['https://rpc.xlayer.tech'], explorer: 'https://www.oklink.com/x-layer', chain: { chainId: '0xc4', chainName: 'X Layer', nativeCurrency: OKB, rpcUrls: ['https://rpc.xlayer.tech'], blockExplorerUrls: ['https://www.oklink.com/x-layer'] } },
  1952: { name: 'X Layer testnet', rpc: ['https://testrpc.xlayer.tech'], explorer: 'https://www.oklink.com/x-layer-testnet', chain: runConfig && JSON.parse(runConfig).networks.testnet.chain },
};
const worldDep = [process.env.WORLD_DEPLOYMENT, 'deployments/196.json', 'deployments/1952.json'].filter(Boolean).map((f) => JSON.parse(readFileSync(f, 'utf8'))).find((d) => d.world);
let worldConfig = 'null';
if (worldDep) {
  const { Interface } = await import('ethers');
  const art = (n) => new Interface(JSON.parse(readFileSync(`build/${n}.json`, 'utf8')).abi);
  const w = art('World'), o = art('Overclock'), sel = (i, f) => i.getFunction(f).selector;
  const n = NETS[worldDep.chainId] ?? NETS[196];
  const d = worldDep.world;
  worldConfig = JSON.stringify({
    ...n, ...(process.env.WORLD_RPC ? { rpc: [process.env.WORLD_RPC] } : {}), chainId: Number(worldDep.chainId),
    world: d.address, overclock: worldDep.overclock, container: d.container ?? null,
    epochBeats: d.epochBeats, epochsPerSeason: d.epochsPerSeason, cellPrice: d.cellPrice, keeperTip: d.keeperTip,
    sel: {
      status: sel(w, 'status'), place: sel(w, 'place'), advance: sel(w, 'advance'), claim: sel(w, 'claim'),
      seasonInfo: sel(w, 'seasonInfo'), teamOf: sel(w, 'teamOf'), placedBy: sel(w, 'placedBy'), claimed: sel(w, 'claimed'),
      jobs: sel(o, 'jobs'), window: sel(o, 'window'),
    },
  });
}
const worldJs = readFileSync('web/world.js', 'utf8').replace(/<\/script/gi, '<\\/script');
const out = process.argv[3] ?? 'web/overclock.html';

const swap = (s, from, to) => {
  if (!s.includes(from)) throw new Error(`web/index.html is missing ${from}`);
  return s.replace(from, () => to);
};
let html = swap(page, '<script id="run-data" type="application/json">null</script>', `<script id="run-data" type="application/json">${run}</script>`);
html = swap(html, '<script id="live-run-data" type="application/json">null</script>', `<script id="live-run-data" type="application/json">${live}</script>`);
html = swap(html, '<script id="board-data" type="application/json">null</script>', `<script id="board-data" type="application/json">${snapshot}</script>`);
html = swap(html, '<script src="board.js"></script>', `<script>\n${board}</script>`);
html = swap(html, '<script id="census-data" type="application/json">null</script>', `<script id="census-data" type="application/json">${census}</script>`);
html = swap(html, '<script src="tap02.js"></script>', `<script>\n${tap02}</script>`);
html = swap(html, '<script src="try.js"></script>', `<script>\n${tryJs}</script>`);
html = swap(html, '<script id="run-config" type="application/json">null</script>', `<script id="run-config" type="application/json">${runConfig}</script>`);
html = swap(html, '<script src="run.js"></script>', `<script>\n${runJs}</script>`);
html = swap(html, '<script id="world-config" type="application/json">null</script>', `<script id="world-config" type="application/json">${worldConfig}</script>`);
html = swap(html, '<script src="world.js"></script>', `<script>\n${worldJs}</script>`);
writeFileSync(out, html);
console.log(`wrote ${out} (${(Buffer.byteLength(html) / 1024).toFixed(1)} KB)`);
