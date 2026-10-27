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
