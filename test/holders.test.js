import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { buildRows, toCSV, isFab, SITE } from '../scripts/holders.js';

const census = JSON.parse(readFileSync(new URL('../docs/census.json', import.meta.url), 'utf8'));

test('one row per holder circuit: every held-back and too-big circuit, no more', () => {
  const rows = buildRows(census);
  assert.equal(rows.length, census.heldBack.length + census.tooBig.length);
  const want = new Map(census.heldBack.concat(census.tooBig).map((h) => [`${h.processor}/${h.id}`, h]));
  assert.equal(want.size, rows.length);
  for (const r of rows) {
    const h = want.get(`${r.processor}/${r.circuit_id}`);
    assert.ok(h, `unexpected circuit ${r.processor}/${r.circuit_id}`);
    assert.equal(r.owner, h.owner);
    assert.equal(r.processor_name, h.processorName);
    assert.equal(r.gates, h.gates);
    assert.equal(r.n_state, h.nState);
    assert.equal(r.n_in, h.nIn);
    assert.equal(r.n_out, h.nOut);
  }
});

test('all 213 holders of the census are covered', () => {
  const rows = buildRows(census);
  assert.equal(new Set(rows.map((r) => r.owner)).size, census.summary.ownersToReach);
});

test('non-FAB processors come first, then FAB-Genisis', () => {
  const rows = buildRows(census);
  let sawFab = false;
  for (const r of rows) {
    if (isFab(r.processor_name)) sawFab = true;
    else assert.ok(!sawFab, `non-FAB row after a FAB row: ${r.processor_name} #${r.circuit_id}`);
  }
  const nonFab = new Set(rows.filter((r) => !isFab(r.processor_name)).map((r) => r.processor_name));
  assert.ok(nonFab.has('LoteGate') && nonFab.has('AlephTape') && nonFab.has('GateX'));
  assert.deepEqual(rows.filter((r) => isFab(r.processor_name)).map((r) => r.processor_name).filter((v, i, a) => a[i - 1] !== v), ['FAB-Genisis']);
});

test('every row carries the page link the site will serve', () => {
  for (const r of buildRows(census)) {
    assert.equal(r.page_link, `${SITE}/#c/${r.processor}/${r.circuit_id}`);
    assert.match(r.page_link, /^https:\/\/overclock-board\.onrender\.com\/#c\/0x[0-9a-fA-F]{40}\/\d+$/);
  }
});

test('FAB rows put the biggest holders first', () => {
  const fab = buildRows(census).filter((r) => isFab(r.processor_name));
  const counts = new Map();
  for (const r of fab) counts.set(r.owner, (counts.get(r.owner) ?? 0) + 1);
  for (let i = 1; i < fab.length; i++) {
    const prev = counts.get(fab[i - 1].owner), cur = counts.get(fab[i].owner);
    assert.ok(prev >= cur || (prev === cur && fab[i - 1].owner <= fab[i].owner),
      `holder order broken at row ${i}: ${fab[i].owner}`);
  }
});

test('building the rows is deterministic', () => {
  assert.deepEqual(buildRows(census), buildRows(census));
});

test('toCSV: header, one line per row, quoting where needed', () => {
  const rows = buildRows(census);
  const csv = toCSV(rows);
  const lines = csv.trimEnd().split('\n');
  assert.equal(lines.length, rows.length + 1);
  assert.equal(lines[0], 'owner,processor_name,processor,circuit_id,gates,n_state,n_in,n_out,beats_per_block,page_link');
  // addresses and links carry no commas, so the sample rows stay unquoted
  assert.ok(!lines[1].includes('"'));
  // a field with a comma or quote gets quoted and doubled
  const row = { owner: '0xA,B', processor_name: 'Test, "v2"', page_link: 'x"y' };
  assert.equal(toCSV([row]).split('\n')[1],
    '"0xA,B","Test, ""v2""",undefined,undefined,undefined,undefined,undefined,undefined,undefined,"x""y"');
});
