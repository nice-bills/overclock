import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, existsSync } from 'node:fs';
import { createServer } from 'node:http';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';
import ganache from 'ganache';
import { BrowserProvider, ContractFactory, parseEther, AbiCoder } from 'ethers';
import { load, hexToBytes, bytesToHex, pack } from '../src/tap02.js';
import { Operator, Challenger } from '../src/agents.js';

const vectors = JSON.parse(readFileSync(new URL('../vendor-tap02/vectors.json', import.meta.url)));
const out = join(mkdtempSync(join(tmpdir(), 'overclock-web-')), 'page.html');
execFileSync('node', ['scripts/build-web.js', 'web/demo-run.json', out], { cwd: new URL('..', import.meta.url) });
const html = readFileSync(out, 'utf8');
const scripts = [...html.matchAll(/<script>\n([\s\S]*?)<\/script>/g)].map((m) => m[1]);

test('web: every inline script parses', () => {
  for (const s of scripts) assert.doesNotThrow(() => new vm.Script(s));
});

test('web: the evaluator inlined for "Your circuit" passes every TAP-02 vector', () => {
  const src = scripts.find((s) => s.startsWith('const TAP02'));
  assert.ok(src, 'TAP02 is inlined');
  const TAP02 = vm.runInNewContext(`${src}\nTAP02`);
  const hex = (bits) => TAP02.bytesToHex(TAP02.pack(bits)).slice(2);
  for (const v of vectors.valid) {
    const subs = new Map(v.refs.map((r) => [`${r.cpu.toLowerCase()}:${r.id}`, TAP02.load(TAP02.hexToBytes(r.netlist), r.nIn, r.nOut, null)]));
    const c = TAP02.load(TAP02.hexToBytes(v.netlist), v.nIn, v.nOut, (cpu, id) => subs.get(`${cpu.toLowerCase()}:${id}`) ?? null);
    for (const row of v.truthTable ?? []) assert.equal(hex(TAP02.beat(c, [], TAP02.unpack(TAP02.hexToBytes(row.inputs), c.nIn))[1]), row.outputs, v.name);
    for (const b of v.beats ?? []) {
      const [ns, outs] = TAP02.beat(c, TAP02.unpack(TAP02.hexToBytes(b.state), c.nState), TAP02.unpack(TAP02.hexToBytes(b.inputs), c.nIn));
      assert.equal(hex(outs), b.outputs, v.name);
      assert.equal(hex(ns), b.newState, v.name);
    }
  }
});

test('web: the census is inlined with the circuits the page lists', () => {
  const m = html.match(/<script id="census-data" type="application\/json">([\s\S]*?)<\/script>/);
  const census = JSON.parse(m[1]);
  assert.ok(census.summary.circuits > 0);
  assert.ok(census.featured.length > 0);
  for (const c of census.featured) assert.match(c.processor, /^0x[0-9a-fA-F]{40}$/);
});

test('web: "Run a job" is inlined with the testnet playground and the CPU program', () => {
  const m = html.match(/<script id="run-config" type="application\/json">([\s\S]*?)<\/script>/);
  const cfg = JSON.parse(m[1]);
  const net = cfg.networks[cfg.default];
  assert.equal(net.chainId, 1952);
  assert.match(net.overclock, /^0x[0-9a-fA-F]{40}$/);
  assert.ok(net.machines.life > 0 && net.machines.cpu > 0);
  assert.match(cfg.cpuState, /^0x[0-9a-f]+$/);
});

const read = (f) => JSON.parse(readFileSync(new URL(`../${f}`, import.meta.url), 'utf8'));
const inlined = (id) => JSON.parse(html.match(new RegExp(`<script id="${id}" type="application/json">([\\s\\S]*?)</script>`))[1]);

test('web: the census carries every stuck circuit as a compact row', () => {
  const census = read('docs/census.json'), c = inlined('census-data');
  const keys = new Set([...census.tooBig, ...census.heldBack].map((x) => `${x.processor.toLowerCase()}:${x.id}`));
  assert.equal(c.machines.rows.length, keys.size);
  const seen = new Set();
  for (const [p, id, o, nIn, nOut, nState, gates] of c.machines.rows) {
    const k = `${c.machines.procs[p].a.toLowerCase()}:${id}`;
    assert.ok(keys.has(k), k);
    seen.add(k);
    const src = [...census.tooBig, ...census.heldBack].find((x) => `${x.processor.toLowerCase()}:${x.id}` === k);
    assert.deepEqual([c.machines.owners[o], nIn, nOut, nState, gates], [src.owner, src.nIn, src.nOut, src.nState, src.gates]);
  }
  assert.equal(seen.size, keys.size);
  for (const f of census.featured) assert.ok(keys.has(`${f.processor.toLowerCase()}:${f.id}`), 'every featured circuit is on the Floor');
});

test('web: runs.json follows docs/runs-schema.md and is inlined', () => {
  const doc = read('web/runs.json');
  assert.deepEqual(inlined('runs-data'), doc);
  assert.equal(doc.schema, 1);
  const ids = new Set();
  for (const r of doc.runs) {
    assert.ok(!ids.has(r.id), 'unique run ids');
    ids.add(r.id);
    assert.equal(r.id, `${r.chainId}:${r.jobId}`);
    assert.match(r.circuit.processor, /^0x[0-9a-fA-F]{40}$/);
    assert.ok(['posted', 'claimed', 'challenged', 'final'].includes(r.status));
    assert.equal(r.gas.honestPath, r.gas.post + r.gas.claim + r.gas.finalize);
    for (const t of r.txs) assert.match(t.tx, /^0x[0-9a-f]{64}$/);
    // every mainnet run is one of the three real jobs: its transactions are in the raw run files
    const raw = JSON.stringify(['web/live-run.json', 'web/digits-live-run.json', 'web/cpu-live-run.json'].map(read));
    for (const t of r.txs) assert.ok(raw.includes(t.tx), `${t.tx} is in a recorded run`);
  }
  assert.deepEqual(doc.certificates, [], 'no certificate is claimed before one has run');
});

test('web: World is cut from the site', () => {
  assert.ok(!html.includes('id="world"') && !html.includes('id="tab-world"') && !html.includes('world-config'));
  assert.ok(!scripts.some((s) => s.includes('"World": Overclock World')));
  assert.match(readFileSync(new URL('../web/world.js', import.meta.url), 'utf8'), /^\/\/ NOT LAUNCHED/);
});

test('web: share tags, favicon and share image', () => {
  for (const m of ['og:title', 'og:description', 'og:image', 'og:url']) assert.ok(html.includes(`property="${m}"`), m);
  for (const m of ['twitter:card', 'twitter:image']) assert.ok(html.includes(`name="${m}"`), m);
  assert.match(html, /<meta property="og:image" content="https:\/\/[^"]+\/og\.png">/);
  assert.match(html, /<link rel="icon" href="data:image\/svg\+xml,/);
  const png = readFileSync(new URL('../web/og.png', import.meta.url));
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.deepEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [1200, 630]);
  assert.ok(existsSync(new URL('../web/og.svg', import.meta.url)) && existsSync(new URL('../web/favicon.svg', import.meta.url)));
});

test('web: the owner lookup reuses the wallet code in run.js', () => {
  const run = readFileSync(new URL('../web/run.js', import.meta.url), 'utf8');
  assert.match(run, /window\.OCWallet = /);
  assert.match(run, /'oc:account'/);
  assert.match(readFileSync(new URL('../web/floor.js', import.meta.url), 'utf8'), /window\.OCWallet/);
});

// ---------------------------------------------------------------- end to end, in a headless browser
// Needs Playwright and a Chromium: PLAYWRIGHT_MODULE (path to playwright's index.mjs) and CHROMIUM (the binary), or a
// "playwright" package that can launch its own. Skipped when neither is there.
async function launch() {
  const mod = process.env.PLAYWRIGHT_MODULE || (existsSync(`${process.env.HOME}/.dev-browser/node_modules/playwright/index.mjs`) ? `${process.env.HOME}/.dev-browser/node_modules/playwright/index.mjs` : 'playwright');
  const { chromium } = await import(mod);
  const exe = [process.env.CHROMIUM, '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome'].find((f) => f && existsSync(f));
  return chromium.launch(exe ? { executablePath: exe } : {});
}
let browser = null;
try { browser = await launch(); } catch (e) { /* no browser here */ }
const e2e = { skip: browser ? false : 'no Playwright and Chromium here' };
const ADDR = '0x65E9483960015EBDDC9EE37b184211E2802d9bcd';
const RUN_CIRCUIT = '#c/0xb00E17789f905234F1890C22E6C01015c10d2f54/11';

async function open(hash, { width = 1280, height = 900, wallet = false, url = null, rpc = null } = {}) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.errors = [];
  page.on('pageerror', (e) => page.errors.push(e.message));
  await page.route((u) => !/^(file|data|about):/.test(u.protocol) && u.hostname !== '127.0.0.1', (r) => r.abort());
  if (rpc) await page.route('https://rpc.xlayer.tech/', rpc); // registered last, so it wins over the abort above
  if (wallet) await page.addInitScript((a) => { window.okxwallet = { request: async ({ method }) => (method === 'eth_requestAccounts' ? [a] : null) }; }, ADDR);
  await page.goto((url || new URL(`file://${out}`).href) + hash);
  await page.waitForSelector('main:not([hidden])');
  return page;
}

test('e2e: landing says the new thing and shows live counters', e2e, async () => {
  const page = await open('');
  assert.match(await page.textContent('#home h1'), /Every machine on X Layer, running\.\s*Every design, proven\./);
  assert.deepEqual(await page.locator('.proof b').allTextContents(), ['3', '0', '16.8M', '42,003×']);
  assert.equal(await page.textContent('#cTotal'), '1,022');
  assert.deepEqual(await page.locator('.tabs a').allTextContents(), ['The Floor', 'Owner lookup', 'Job board', 'Replay', 'Your circuit', 'Run a job']);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('e2e: the Floor draws every circuit by status and links to its page', e2e, async () => {
  const page = await open('#floor');
  assert.equal(await page.locator('#floorGrid .cell').count(), 1022);
  assert.equal(await page.locator('.cell.s-final').count(), 3);
  assert.equal(await page.locator('.cell.s-queued').count(), 1019);
  assert.equal(await page.locator('.cell.s-certified').count(), 0);
  await page.click('#floorFilters [data-f=miner]');
  assert.equal(await page.locator('#floorGrid .cell').count(), 996);
  await page.click('#floorFilters [data-f=machine]');
  assert.equal(await page.locator('#floorGrid .cell').count(), 26);
  await page.locator('.cell.s-final').first().click();
  assert.match(page.url(), /#c\/0x[0-9a-fA-F]{40}\/\d+$/);
  assert.ok(await page.isVisible('#circuit'));
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('e2e: a circuit page shows state, cost and transactions; a queued one says so', e2e, async () => {
  const page = await open(RUN_CIRCUIT);
  assert.match(await page.textContent('#circuitBody h1'), /AlephTape\s*#11/);
  assert.equal(await page.locator('#circuitBody .titlerow .tag').textContent(), 'Final');
  assert.equal(await page.locator('#circuitBody .txs a').count(), 6);
  assert.match(await page.getAttribute('#circuitBody .txs a', 'href'), /^https:\/\/www\.oklink\.com\/x-layer\/tx\/0x[0-9a-f]{64}$/);
  assert.match(await page.textContent('#circuitBody .costs'), /388,354,847 gas[\s\S]*2,244,073 gas[\s\S]*173× less/);
  assert.match(await page.textContent('#circuitBody'), /None yet/);
  assert.match(await page.getAttribute('#circuitBody a[href^="https://t.me/share"]', 'href'), /overclock|c%2F0xb00E/i);
  assert.match(await page.title(), /AlephTape #11/);
  await page.goto(new URL(`file://${out}`).href + '#c/0x00586A4C37039aCbFC6aC135cAdd49367ABf390A/1');
  assert.equal(await page.locator('#circuitBody .titlerow .tag').textContent(), 'Queued');
  assert.match(await page.textContent('#circuitBody'), /Nothing has run this circuit/);
  assert.match(await page.textContent('#circuitBody .costs'), /estimate/);
  await page.goto(new URL(`file://${out}`).href + '#c/0x0000000000000000000000000000000000000001/7');
  assert.match(await page.textContent('#circuitBody h1'), /not on the Floor/);
  assert.deepEqual(page.errors, []);
  await page.close();
});

test('e2e: owner lookup by address, by link and with a wallet', e2e, async () => {
  const page = await open('#owner', { wallet: true });
  await page.fill('#ownerInput', 'nope');
  await page.click('#ownerForm button[type=submit]');
  assert.match(await page.textContent('#ownerNote'), /not an address/);
  await page.fill('#ownerInput', ADDR.toLowerCase());
  await page.click('#ownerForm button[type=submit]');
  assert.deepEqual(await page.locator('#ownerOut .spec .v').allTextContents(), ['7', '1', '0', '6']);
  assert.equal(await page.locator('#ownerRows tr').count(), 7);
  assert.match(page.url(), /#owner\?addr=0x65e9/i);
  await page.fill('#ownerInput', '0x0000000000000000000000000000000000000002');
  await page.click('#ownerForm button[type=submit]');
  assert.match(await page.textContent('#ownerOut'), /No circuits on the Floor/);
  await page.fill('#ownerInput', '');
  await page.click('#ownerWallet button:has-text("OKX Wallet")');
  assert.equal(await page.inputValue('#ownerInput'), ADDR);
  assert.equal(await page.locator('#ownerRows tr').count(), 7);
  const deep = await open(`#owner?addr=${ADDR}`);
  assert.equal(await deep.locator('#ownerRows tr').count(), 7);
  assert.deepEqual([...page.errors, ...deep.errors], []);
  await page.close(); await deep.close();
});

test('e2e: at 390px every tab fits and nothing scrolls sideways', e2e, async () => {
  for (const hash of ['', '#floor', '#owner', '#board', '#replay', '#try', '#run', RUN_CIRCUIT]) {
    const page = await open(hash, { width: 390, height: 844 });
    const m = await page.evaluate(() => ({ tabs: [...document.querySelectorAll('.tabs a')].map((a) => Math.round(a.getBoundingClientRect().right)), left: [...document.querySelectorAll('.tabs a')].map((a) => Math.round(a.getBoundingClientRect().left)), doc: document.documentElement.scrollWidth, box: document.querySelector('.tabs').scrollWidth - document.querySelector('.tabs').clientWidth }));
    assert.equal(m.tabs.length, 6, hash);
    assert.ok(m.tabs.every((r) => r <= 390) && m.left.every((l) => l >= 0), `${hash || 'home'}: a tab is clipped ${m.tabs}`);
    assert.ok(m.box <= 0, `${hash}: the tab bar scrolls`);
    assert.ok(m.doc <= 390, `${hash}: page is ${m.doc}px wide`);
    await page.close();
  }
});

test('e2e: a fresh runs.json served next to the page updates the counters and the Floor', e2e, async () => {
  const doc = read('web/runs.json');
  const c = doc.runs[2].circuit;
  doc.certificates = [{ id: 'c1', circuit: { processor: '0x00586A4C37039aCbFC6aC135cAdd49367ABf390A', id: 1 }, reference: null, runId: '196:2', inputs: 262144, mismatches: 0, status: 'certified', covers: [{ processor: '0x00586A4C37039aCbFC6aC135cAdd49367ABf390A', id: 4 }] }];
  doc.runs.push({ id: '196:3', chainId: 196, overclock: doc.runs[0].overclock, jobId: 3, circuit: { processor: c.processor, id: 99, name: 'Test', gates: 10, nIn: 1, nOut: 1, nState: 0 }, what: 'test', beats: 1, steps: 1000, status: 'claimed', txs: [] });
  const server = createServer((req, res) => {
    if (req.url === '/runs.json') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(doc)); } else { res.setHeader('content-type', 'text/html'); res.end(html); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const page = await open('#floor', { url: `http://127.0.0.1:${server.address().port}/` });
    await page.waitForFunction(() => document.querySelectorAll('.cell.s-certified').length > 0);
    assert.equal(await page.locator('.cell.s-certified').count(), 2, 'the certificate covers a second circuit');
    assert.equal(await page.locator('.cell.s-running').count(), 1);
    assert.equal(await page.locator('#floorGrid .cell').count(), 1023, 'a run on a circuit outside the census adds a cell');
    assert.equal(await page.textContent('#cCerts'), '1');
    await page.goto(`http://127.0.0.1:${server.address().port}/#c/0x00586A4C37039aCbFC6aC135cAdd49367ABf390A/1`);
    await page.waitForFunction(() => document.querySelector('#circuitBody .titlerow .tag')?.textContent === 'Certified');
    assert.match(await page.textContent('#circuitBody'), /all 262,144 inputs/);
    assert.deepEqual(page.errors, []);
    await page.close();
  } finally { server.close(); }
});

// ---------------------------------------------------------------- the job board, against a local v2 and a stand-in for the old contract

// Answer the board's JSON-RPC calls (single or batched) with `answer(method, params)`; a throw is a JSON-RPC error.
const rpcRoute = (answer) => async (route) => {
  const body = JSON.parse(route.request().postData());
  const reply = async (q) => {
    try { return { jsonrpc: '2.0', id: q.id, result: await answer(q.method, q.params) }; } catch (e) { return { jsonrpc: '2.0', id: q.id, error: { code: -32000, message: e.message } }; }
  };
  const out = Array.isArray(body) ? await Promise.all(body.map(reply)) : await reply(body);
  await route.fulfill({ status: 200, contentType: 'application/json', headers: { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*' }, body: JSON.stringify(out) });
};
const liveDone = (page) => page.waitForFunction(() => /^Live · block [\d,]+$/.test(document.getElementById('liveStatus').textContent), null, { timeout: 60000 });

test('e2e: the job board decodes a local v2 dispute: 16-way moves, forced error, slashed pool, per-job bond', e2e, async () => {
  const art = (n) => JSON.parse(readFileSync(new URL(`../build/${n}.json`, import.meta.url)));
  const gp = ganache.provider({ logging: { quiet: true }, chain: { hardfork: 'shanghai' }, wallet: { totalAccounts: 8, defaultBalance: 10000 } });
  const provider = new BrowserProvider(gp, undefined, { cacheTimeout: -1 });
  const [poster, cheatS, watcherS, runnerS] = await Promise.all([0, 1, 2, 5].map((i) => provider.getSigner(i)));
  const deploy = async (name, signer, ...args) => { const a = art(name); const ct = await new ContractFactory(a.abi, a.bytecode, signer).deploy(...args); await ct.waitForDeployment(); return ct; };
  const ZERO = '0x0000000000000000000000000000000000000000';
  const cpu = await deploy('MockProcessor', poster);
  const oc = await deploy('Overclock', poster, parseEther('1'), 3600, ZERO, await poster.getAddress(), 0, 5000, 0, await runnerS.getAddress());
  const v = vectors.valid.find((x) => x.name === 'popcount8_3151'), c = load(hexToBytes(v.netlist), v.nIn, v.nOut);
  const id = Number(await cpu.nextId());
  await (await cpu.store(v.netlist, v.nIn, v.nOut, c.nState, c.nGates)).wait();
  const post = async (inputs) => {
    const n = Number(await oc.jobCount());
    await (await oc.postJob(await cpu.getAddress(), id, bytesToHex(pack(inputs)), '0x', 1, false, { value: parseEther('1') })).wait();
    return n;
  };
  const log = [];
  const watch = new Challenger({ oc, signer: watcherS, name: 'watcher', log: (e) => log.push(e) });
  // job 0: a lie, caught through a 16-way dissection. It also fills the slashed pool.
  let lied = false;
  const cheat = new Operator({ oc, signer: cheatS, name: 'cheat', lie: () => (lied ? null : ((lied = true), 34)) });
  const j0 = await post([1, 0, 1, 1, 0, 1, 1, 1]);
  cheat.only = watch.only = new Set([j0]);
  await cheat.tick();
  for (let i = 0; i < 40 && !log.some((e) => e.fn === 'resolveLeaf'); i++) { await watch.tick(); await cheat.tick(); }
  assert.ok(log.some((e) => e.fn === 'resolveLeaf'), 'the lie was proven');
  assert.ok((await oc.slashed()) > 0n);
  // job 1: the runner commits to a forced error, claims a wrong result and is caught for a jackpot
  const runner = new Operator({ oc, signer: runnerS, name: 'runner', forced: () => 36 });
  const j1 = await post([1, 1, 1, 0, 0, 1, 0, 1]);
  runner.only = watch.only = new Set([j1]);
  await runner.tick();
  for (let i = 0; i < 12 && !log.some((e) => e.jackpot); i++) { await watch.tick(); await runner.tick(); }
  assert.ok(log.some((e) => e.jackpot), 'the forced error was caught');
  const slashed = await oc.slashed();

  const answer = (m, p) => gp.request({ method: m, params: p });
  const page = await open('#board', { url: `${new URL(`file://${out}`).href}?contract=${await oc.getAddress()}`, rpc: rpcRoute(answer) });
  try {
    await liveDone(page);
    const games = await page.locator('#games tr').allTextContents();
    assert.equal(games.length, 2, 'two games');
    assert.match(games[0], /forced error caught\s*jackpot [\d.]+ OKB/);
    assert.match(games[1], /cheat caught/);
    assert.match(games[1], /half the loser's bond slashed/);
    const moves = Number((await page.locator('#games details summary').last().textContent()).match(/(\d+) moves/)[1]); // the cheat's game is listed last
    assert.ok(moves >= 2 && moves % 2 === 0 && moves <= 12, `reveal16/pick16 moves decoded, got ${moves}`);
    const tickets = await page.locator('#jobs .ticket').allTextContents();
    assert.match(tickets[0], /Bond1\.5 OKB/, 'per-job bond: 1 + 50% of the 1 OKB fee');
    assert.match(tickets[0], /runner committed[\s\S]*forced claim[\s\S]*forced error caught · jackpot/);
    assert.match(tickets[1], /wrong claim[\s\S]*cheat caught/);
    assert.match(await page.textContent('#liveSpecs'), /1cheats caught · 1 forced error caught/);
    const note = await page.textContent('#feedNote');
    assert.ok(note.includes('Bond 1 OKB + 50% of the fee') && note.includes('1h 0m challenge window') && note.includes(`${(Number(slashed) / 1e18).toFixed(6).replace(/0+$/, '').replace(/\.$/, '')} OKB slashed`) && note.includes('forced errors by 0x'), note);
    const feed = await page.locator('#feed tr').allTextContents();
    assert.ok(feed.some((r) => /forced error caught/.test(r)) && feed.some((r) => /dissection/.test(r) || /revealed/.test(r)), feed.join('\n'));
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test('e2e: the job board still decodes the old contract: binary Revealed events, no v2 getters', e2e, async () => {
  const snap = read('web/board-snapshot.json');
  const abi = AbiCoder.defaultAbiCoder();
  const H = (n) => '0x' + n.toString(16).padStart(64, '0');
  const head = snap.toBlock + 40;
  const T = { revealed: '0xcceeb83fe4f7352f8b511ab8816c6f3f37a73798c028f0019b52b1b12a60b4d6', picked: '0x58bdb6a4f5f57c8cf3969bd320a3b34eca94998006fbc5feb273673b58d2ba04' };
  // game 7: reveal at level 5, pick, reveal at level 4, pick (the old, binary shape)
  const mk = (n, topic, level, extra) => ({ blockNumber: '0x' + (snap.toBlock + 10 + n).toString(16), transactionHash: H(0xa00 + n), logIndex: '0x0', topics: [topic, H(7)], data: abi.encode(extra ? ['uint8', 'uint256', 'bytes32', 'bytes32'] : ['uint8', 'uint256'], extra ? [level, 1, H(1), H(2)] : [level, 1]) });
  const logs = [mk(1, T.revealed, 5, true), mk(2, T.picked, 4), mk(3, T.revealed, 4, true), mk(4, T.picked, 3)];
  const answer = (m, p) => {
    if (m === 'eth_getBlockByNumber') return { number: '0x' + (/^0x/.test(p[0]) ? Number(p[0]) : head).toString(16), timestamp: '0x' + (1_790_000_000).toString(16) };
    if (m === 'eth_getLogs') { const [f, t] = [Number(p[0].fromBlock), Number(p[0].toBlock)]; return logs.filter((l) => Number(l.blockNumber) >= f && Number(l.blockNumber) <= t); }
    if (m === 'eth_call') {
      const sel = p[0].data.slice(0, 10);
      const v = { '0x4c5d8a0f': 0, '0x4d1975b4': 0, '0x64c9ec6f': 10n ** 15n, '0x461645bf': 600, '0x24a9d853': 200 }[sel];
      if (v === undefined) throw new Error('execution reverted'); // slashed, bondBps, forcedRunner: not on the old contract
      return H(v);
    }
    throw new Error(`unexpected ${m}`);
  };
  const page = await open('#board', { rpc: rpcRoute(answer) });
  try {
    await liveDone(page);
    assert.equal(await page.textContent('#feedNote'), 'Bond 0.001 OKB · 10m 00s challenge window · 2% protocol fee');
    const feed = await page.locator('#feed tr').first().textContent();
    assert.match(feed, /dissection[\s\S]*game 7 · 4 moves, down to level 3/);
    assert.deepEqual(page.errors, []);
  } finally { await page.close(); }
});

test.after(async () => { if (browser) await browser.close(); });
