// Collect every Overclock event on X Layer into web/board-snapshot.json, so the job board can link each
// job to its transactions without scanning the whole chain from the browser. Public X Layer nodes serve
// eth_getLogs 100 blocks at a time, so the board itself only scans the blocks after this snapshot.
// Re-running continues from the previous snapshot.
//
//   node scripts/snapshot-board.js [RPC_URL]
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const deployment = JSON.parse(readFileSync('deployments/196.json', 'utf8'));
const out = 'web/board-snapshot.json';
const rpcUrl = process.argv[2] ?? process.env.RPC_URL ?? 'https://rpc.xlayer.tech';
const SPAN = 100;
const BATCH = 5; // larger batches of eth_getLogs hit the public nodes' rate limit
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let id = 0;
async function batch(calls) {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(calls.map(([method, params]) => ({ jsonrpc: '2.0', id: ++id, method, params }))),
      });
      const body = await res.json();
      const list = Array.isArray(body) ? body : [body];
      list.sort((a, b) => a.id - b.id);
      const bad = list.find((r) => r.error);
      if (bad) throw new Error(bad.error.message);
      return list.map((r) => r.result);
    } catch (e) {
      if (attempt >= 4) throw e;
      await sleep(1000 * 2 ** attempt);
    }
  }
}
const hex = (n) => '0x' + n.toString(16);

const prev = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : null;
const same = prev && prev.contract.toLowerCase() === deployment.overclock.toLowerCase();
const logs = same ? prev.logs : [];
const blockTimes = same ? prev.blockTimes ?? {} : {};
const from = same ? prev.toBlock + 1 : deployment.block;
const [latestHex] = await batch([['eth_blockNumber', []]]);
const to = Number(latestHex) - 2;

const windows = [];
for (let b = from; b <= to; b += SPAN) windows.push([b, Math.min(b + SPAN - 1, to)]);
for (let i = 0; i < windows.length; i += BATCH) {
  const part = windows.slice(i, i + BATCH);
  const res = await batch(part.map(([a, z]) => ['eth_getLogs', [{ address: deployment.overclock, fromBlock: hex(a), toBlock: hex(z) }]]));
  for (const list of res) for (const l of list) {
    logs.push({ block: Number(l.blockNumber), tx: l.transactionHash, i: Number(l.logIndex), topics: l.topics, data: l.data });
  }
  await sleep(250);
  if ((i / BATCH) % 20 === 0) process.stdout.write(`\rblocks ${part[0][0]}..${part.at(-1)[1]} of ${to}, ${logs.length} events`);
}

const need = [...new Set(logs.map((l) => l.block))].filter((b) => !blockTimes[b]);
for (let i = 0; i < need.length; i += BATCH) {
  const res = await batch(need.slice(i, i + BATCH).map((b) => ['eth_getBlockByNumber', [hex(b), false]]));
  res.forEach((blk, k) => { blockTimes[need[i + k]] = Number(blk.timestamp); });
}

logs.sort((a, b) => a.block - b.block || a.i - b.i);
writeFileSync(out, JSON.stringify({ chainId: 196, contract: deployment.overclock, deployBlock: deployment.block, toBlock: to, logs, blockTimes }) + '\n');
console.log(`\nwrote ${out}: ${logs.length} events up to block ${to}`);
