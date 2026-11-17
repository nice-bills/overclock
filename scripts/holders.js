// Holder outreach list (PLAN H3): every circuit that can't run 1,000 beats in a block, grouped by
// the wallet that holds it, with the page link the site serves per circuit.
//
//   node scripts/holders.js [--in docs/census.json] [--out docs/outreach/holders.csv]
//
// One row per holder circuit, ready for mail-merge: holder address, the circuit, and its future
// page link https://overclock-board.onrender.com/#c/<processor>/<id>. Non-FAB processors come
// first (the order of PLAN H3: LoteGate, Covenant, AlephTape, My hero, TAPELIQUID, Nandverse,
// GateX, then the rest), then the FAB-Genisis processors with the biggest holders first.

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const opt = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const IN = opt('in', 'docs/census.json');
const OUT = opt('out', 'docs/outreach/holders.csv');
export const SITE = 'https://overclock-board.onrender.com';

// Processors to talk to first (PLAN H3), then any other non-FAB name alphabetically, then FAB.
const NON_FAB_ORDER = ['LoteGate', 'Covenant', 'AlephTape', 'My hero', 'TAPELIQUID', 'Nandverse', 'GateX'];

export const isFab = (name) => name.startsWith('FAB');

function rank(name) {
  if (isFab(name)) return NON_FAB_ORDER.length + 2;
  const i = NON_FAB_ORDER.indexOf(name);
  return i >= 0 ? i : NON_FAB_ORDER.length + 1;
}

// rows: one per circuit in census.heldBack + census.tooBig, in outreach order.
export function buildRows(census) {
  const circuits = [...census.heldBack, ...census.tooBig];
  // how many out-of-reach circuits each owner holds, for "the biggest holders first" inside FAB
  const perOwner = new Map();
  for (const h of circuits) perOwner.set(h.owner, (perOwner.get(h.owner) ?? 0) + 1);
  const rows = circuits.map((h) => ({
    owner: h.owner,
    processor_name: h.processorName,
    processor: h.processor,
    circuit_id: h.id,
    gates: h.gates,
    n_state: h.nState,
    n_in: h.nIn,
    n_out: h.nOut,
    beats_per_block: h.beatsPerBlock ?? 0,
    page_link: `${SITE}/#c/${h.processor}/${h.id}`,
  }));
  rows.sort((a, b) =>
    rank(a.processor_name) - rank(b.processor_name)
    || perOwner.get(b.owner) - perOwner.get(a.owner)
    || (a.owner < b.owner ? -1 : a.owner > b.owner ? 1 : 0)
    || a.circuit_id - b.circuit_id);
  return rows;
}

const COLUMNS = ['owner', 'processor_name', 'processor', 'circuit_id', 'gates', 'n_state', 'n_in', 'n_out', 'beats_per_block', 'page_link'];

export function csvField(v) {
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s;
}

export function toCSV(rows) {
  const lines = [COLUMNS.join(',')];
  for (const r of rows) lines.push(COLUMNS.map((c) => csvField(r[c])).join(','));
  return lines.join('\n') + '\n';
}

export function main() {
  const census = JSON.parse(readFileSync(resolve(IN), 'utf8'));
  const rows = buildRows(census);
  mkdirSync(dirname(resolve(OUT)), { recursive: true });
  writeFileSync(resolve(OUT), toCSV(rows));
  const owners = new Set(rows.map((r) => r.owner));
  const fabs = rows.filter((r) => isFab(r.processor_name)).length;
  console.log(`holders.csv: ${rows.length} circuits, ${owners.size} holders ` +
    `(${rows.length - fabs} non-FAB first, then ${fabs} FAB-Genisis) -> ${OUT}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) main();
