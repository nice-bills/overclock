import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

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

test('web: World gets its network and selectors when a world is deployed', async () => {
  const { Interface } = await import('ethers');
  const dir = mkdtempSync(join(tmpdir(), 'overclock-world-'));
  const dep = join(dir, 'dep.json'), page = join(dir, 'page.html');
  const world = { address: '0x5A36e44D4911E7b828Cc39844Dc32a4e962e0C13', container: '0x07e7813eCbA04fEa317403f9a03AEfa87EceE514', epochBeats: 20, epochsPerSeason: 20, cellPrice: '500000000000000', keeperTip: '20000000000000' };
  (await import('node:fs')).writeFileSync(dep, JSON.stringify({ chainId: 196, overclock: '0x2F38e310D398228f4D5Ef737eFaCDCC84BE92E25', world }));
  execFileSync('node', ['scripts/build-web.js', 'web/demo-run.json', page], { cwd: new URL('..', import.meta.url), env: { ...process.env, WORLD_DEPLOYMENT: dep } });
  const cfg = JSON.parse(readFileSync(page, 'utf8').match(/<script id="world-config" type="application\/json">(.*?)<\/script>/)[1]);
  const abi = new Interface(JSON.parse(readFileSync(new URL('../build/World.json', import.meta.url))).abi);
  assert.equal(cfg.chainId, 196);
  assert.equal(cfg.world, world.address);
  assert.equal(cfg.sel.place, abi.getFunction('place').selector);
  assert.equal(cfg.sel.status, abi.getFunction('status').selector);
  assert.ok(html.includes('id="world"') && scripts.some((s) => s.includes('"World": Overclock World')), 'the World view and its script are in the page');
});
