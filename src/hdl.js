// A tiny netlist builder: write circuits as JS, get TAP-02 bytes ready to tape out.
//
//   const b = new Builder(9);            // 9 inputs: b.in[0..8]
//   const x = b.xor(b.in[0], b.in[1]);
//   const q = b.latch();                 // read now, wire its input later
//   b.setLatch(q, x);
//   const nl = b.build([x, q]);          // outputs must be the last signals: build() adds buffers
//
// REF calls take the sub-circuit's processor address and id: b.ref(cpu, id, nOut, ins).

import { NAND, LATCH, REF, hexToBytes } from './tap02.js';

export class Builder {
  constructor(nIn) {
    this.nIn = nIn;
    this.in = Array.from({ length: nIn }, (_, i) => 2 + i);
    this.records = [];
    this.next = 2 + nIn;
    this.zero = 0;
    this.one = 1;
  }

  _add(rec, nOut) {
    this.records.push(rec);
    const first = this.next;
    this.next += nOut;
    return first;
  }

  nand(a, b) { return this._add({ op: NAND, ins: [a, b] }, 1); }
  not(a) { return this.nand(a, this.one); }
  and(a, b) { return this.not(this.nand(a, b)); }
  or(a, b) { return this.nand(this.not(a), this.not(b)); }
  nor(a, b) { return this.not(this.or(a, b)); }
  xor(a, b) {
    const n = this.nand(a, b);
    return this.nand(this.nand(a, n), this.nand(b, n));
  }

  halfAdd(a, b) {
    const n = this.nand(a, b);
    const s = this.nand(this.nand(a, n), this.nand(b, n));
    return [s, this.not(n)];
  }

  // 9 NANDs
  fullAdd(a, b, c) {
    const n1 = this.nand(a, b);
    const x1 = this.nand(this.nand(a, n1), this.nand(b, n1));
    const n2 = this.nand(x1, c);
    const s = this.nand(this.nand(x1, n2), this.nand(c, n2));
    return [s, this.nand(n1, n2)];
  }

  latch(d = null) {
    const rec = { op: LATCH, ins: [d] };
    const s = this._add(rec, 1);
    rec.sig = s;
    (this._latches ??= new Map()).set(s, rec);
    return s;
  }

  setLatch(q, d) { this._latches.get(q).ins[0] = d; }

  ref(cpu, id, nOut, ins) {
    const first = this._add({ op: REF, cpu, id: BigInt(id), ins, nOut }, nOut);
    return Array.from({ length: nOut }, (_, i) => first + i);
  }

  // TAP-02 outputs are the last nOut signals; add NOT-NOT buffers unless they already are.
  build(outs) {
    const tail = Array.from({ length: outs.length }, (_, i) => this.next - outs.length + i);
    // all first NOTs, then all second NOTs, so the second ones are the last signals
    if (!outs.every((s, i) => s === tail[i])) outs = outs.map((s) => this.not(s)).map((s) => this.not(s));
    for (const r of this.records) if (r.op === LATCH && r.ins[0] === null) throw new Error(`latch ${r.sig} has no input`);
    return { netlist: encode(this.records), nIn: this.nIn, nOut: outs.length };
  }
}

function encode(records) {
  const bytes = [];
  const u24 = (v) => bytes.push((v >> 16) & 255, (v >> 8) & 255, v & 255);
  for (const r of records) {
    bytes.push(r.op);
    if (r.op === NAND) { u24(r.ins[0]); u24(r.ins[1]); }
    else if (r.op === LATCH) u24(r.ins[0]);
    else {
      bytes.push(...hexToBytes(r.cpu.toLowerCase().padStart(42, '0')));
      for (let i = 7; i >= 0; i--) bytes.push(Number((r.id >> BigInt(8 * i)) & 255n));
      bytes.push(r.ins.length, r.nOut);
      r.ins.forEach(u24);
    }
  }
  return Uint8Array.from(bytes);
}
