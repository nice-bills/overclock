// Build a test bench for (design, reference) and run it locally.
//
//   node scripts/bench.js --design adder:9 --reference adder-alt:9
//   node scripts/bench.js --design flawed:4:165 --reference adder-alt:4
//   node scripts/bench.js --design adder:4 --break 7 --reference adder-alt:4
//   node scripts/bench.js --design my.json --reference ref.json --out bench.json
//
// A circuit is a built-in sample (adder:W, adder-alt:W, flawed:W:AT) or a JSON file
// { netlist: "0x..", nIn, nOut } with no REFs. --break K ties the second input of the design's
// K-th NAND high. The bench is run both ways: the expected verdict computed by src/tap02.js on
// design and reference directly, and the bench circuit itself beat by beat; they must agree.
// --skip-bench-run skips the second (slow for 2^18 beats). --out writes the bench as JSON.

import { readFileSync, writeFileSync } from 'node:fs';
import { load, hexToBytes, bytesToHex, pack } from '../src/tap02.js';
import { adderCircuit, benchCircuit, benchState, benchSize, expectedVerdict, runBench, verdict, breakNand } from '../src/bench.js';

const args = process.argv.slice(2);
const arg = (k, d = null) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);

function parse(spec) {
  const [kind, w, at] = spec.split(':');
  if (kind === 'adder') return adderCircuit(+w);
  if (kind === 'adder-alt') return adderCircuit(+w, { alt: true });
  if (kind === 'flawed') return adderCircuit(+w, { flawAt: +at });
  const j = JSON.parse(readFileSync(spec, 'utf8'));
  return { netlist: hexToBytes(j.netlist), nIn: j.nIn, nOut: j.nOut };
}

const CPU = '0x' + '00'.repeat(19) + 'bc'; // a stand-in processor address for local runs
if (!arg('design') || !arg('reference')) { console.error('usage: node scripts/bench.js --design <spec> --reference <spec> [--break K] [--out file] [--skip-bench-run]'); process.exit(1); }
let design = parse(arg('design'));
const reference = parse(arg('reference'));
if (arg('break') !== null) design = { ...design, netlist: breakNand(design.netlist, design.nIn, +arg('break')) };

const circuits = new Map();
const resolve = (a, id) => circuits.get(Number(id)) ?? null;
const desc = (id, nl) => {
  const c = load(nl.netlist, nl.nIn, nl.nOut, resolve);
  circuits.set(id, c);
  return { cpu: CPU, id, nIn: nl.nIn, nOut: nl.nOut, nState: c.nState };
};
const bench = benchCircuit(desc(1, design), desc(2, reference));
const sz = benchSize(bench, resolve);
console.log(`bench: ${bench.n} inputs, mode ${bench.mode}, ${bench.nOut} outputs`);
console.log(`  ${sz.gates} gates/beat (${sz.ownGates} in the bench itself), ${sz.nState} state bits, ${sz.beats} beats, ${sz.steps.toLocaleString()} steps`);

let t0 = Date.now();
const exp = expectedVerdict(bench, resolve);
console.log(`expected (tap02, ${Date.now() - t0} ms): ${exp.mismatch ? `FAIL, first failing input ${exp.firstInput} (0b${exp.firstInput.toString(2).padStart(bench.n, '0')}) at beat ${exp.firstBeat}, ${exp.mismatches} failing` : `CERTIFIED, 0 mismatches over ${exp.beats} inputs`}`);

if (!flag('skip-bench-run')) {
  t0 = Date.now();
  const run = runBench(bench, resolve);
  const v = verdict(run.outputs, bench.n);
  const agree = JSON.stringify(run.outputs) === JSON.stringify(exp.outputs);
  console.log(`bench circuit (${Date.now() - t0} ms): mismatch=${v.mismatch} first=${v.firstInput} done=${v.done} ${agree ? '(agrees)' : '(DISAGREES)'}`);
  if (!agree) process.exit(2);
}
if (arg('out')) {
  writeFileSync(arg('out'), JSON.stringify({ netlist: bytesToHex(bench.netlist), nIn: 0, nOut: bench.nOut, beats: bench.beats, state: bytesToHex(pack(benchState(bench))), design: { ...design, netlist: bytesToHex(design.netlist) }, reference: { ...reference, netlist: bytesToHex(reference.netlist) }, expected: exp }, null, 1));
  console.log(`wrote ${arg('out')}`);
}
