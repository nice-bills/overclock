// A 4-bit CPU as one TapeOut circuit. One beat = one instruction.
//
// The program and the data live in the circuit's state, so the circuit is a general machine and a
// job's starting state is "this program, with this data". Nobody tapes out anything to run a new
// program: they post a job.
//
// State (LATCHes, in this order): PC[4], A[4], C, OUT[4], RAM[16][4], ROM[16][8]. 205 bits.
// No inputs. Outputs: OUT[4], set by the OUT instruction.
//
// An instruction is one byte: the high nibble is the opcode, the low nibble n is an immediate,
// a RAM address or a jump target.
//
//   0 NOP            4 ADD a   A,C = A + M[a]        8 AND a   A = A & M[a]     12 JZ t   if A == 0
//   1 LDI n  A = n   5 ADC a   A,C = A + M[a] + C    9 XOR a   A = A ^ M[a]     13 JNZ t  if A != 0
//   2 LD a   A = M[a] 6 SUB a  A,C = A - M[a]       10 JMP t                    14 OUT    OUT = A
//   3 ST a   M[a] = A 7 ADDI n A,C = A + n          11 JC t   if C              15 HLT    stay here
//
// SUB sets C when there is no borrow (A >= M[a]), as A + ~M[a] + 1 does.

import { Builder } from './hdl.js';

export const OPS = ['NOP', 'LDI', 'LD', 'ST', 'ADD', 'ADC', 'SUB', 'ADDI', 'AND', 'XOR', 'JMP', 'JC', 'JZ', 'JNZ', 'OUT', 'HLT'];
export const STATE = { pc: 0, a: 4, c: 8, out: 9, ram: 13, rom: 77, bits: 205 };

const bits = (v, n) => Array.from({ length: n }, (_, i) => (v >> i) & 1);
const num = (bs) => bs.reduce((v, b, i) => v | (b << i), 0);

export function cpuCircuit() {
  const b = new Builder(0);
  const L = (n) => Array.from({ length: n }, () => b.latch());
  const pc = L(4), a = L(4), c = L(1)[0], out = L(4);
  const ram = Array.from({ length: 16 }, () => L(4));
  const rom = Array.from({ length: 16 }, () => L(8));
  rom.flat().forEach((q) => b.setLatch(q, q)); // the program never changes

  const mux = (s, x, y) => b.nand(b.nand(x, b.not(s)), b.nand(y, s)); // s ? y : x
  // mux16(sel[4], words[16][w]): a tree of 2:1 muxes, one NOT per select bit
  const mux16 = (sel, words) => {
    const ns = sel.map((s) => b.not(s));
    const m2 = (k, x, y) => b.nand(b.nand(x, ns[k]), b.nand(y, sel[k]));
    let lvl = words;
    for (let k = 0; k < 4; k++) {
      const next = [];
      for (let i = 0; i < lvl.length; i += 2) next.push(lvl[i].map((x, j) => m2(k, x, lvl[i + 1][j])));
      lvl = next;
    }
    return lvl[0];
  };
  // one-hot decode of a nibble, optionally gated by `en`
  const decode = (v, en = null) => {
    const nv = v.map((x) => b.not(x));
    const pair = (x, y, nx, ny) => [b.and(nx, ny), b.and(x, ny), b.and(nx, y), b.and(x, y)];
    let lo = pair(v[0], v[1], nv[0], nv[1]);
    let hi = pair(v[2], v[3], nv[2], nv[3]);
    if (en !== null) hi = hi.map((h) => b.and(h, en));
    return Array.from({ length: 16 }, (_, k) => b.and(lo[k & 3], hi[k >> 2]));
  };
  const or = (...xs) => xs.reduce((x, y) => b.or(x, y));

  const inst = mux16(pc, rom);
  const n = inst.slice(0, 4), op = inst.slice(4, 8);
  const d = decode(op);
  const m = mux16(n, ram.map((w) => w));

  // ALU
  const useImm = b.or(d[1], d[7]);
  const B = n.map((x, i) => mux(useImm, m[i], x));
  const sub = d[6];
  const Y = B.map((x) => b.xor(x, sub));
  let carry = b.or(b.and(d[5], c), sub);
  const sum = [];
  for (let i = 0; i < 4; i++) {
    const [s, co] = b.fullAdd(a[i], Y[i], carry);
    sum.push(s);
    carry = co;
  }
  const load = b.or(d[1], d[2]);
  const arith = or(d[4], d[5], d[6], d[7]);
  const keepA = b.not(or(load, arith, d[8], d[9]));
  const newA = a.map((x, i) => or(b.and(load, B[i]), b.and(arith, sum[i]), b.and(d[8], b.and(x, m[i])), b.and(d[9], b.xor(x, m[i])), b.and(keepA, x)));
  const newC = mux(arith, c, carry);
  const newOut = out.map((x, i) => mux(d[14], x, a[i]));

  // RAM write port: ST a
  const we = decode(n, d[3]);
  const newRam = ram.map((w, k) => w.map((x, i) => mux(we[k], x, a[i])));

  // PC
  const z = b.not(or(...a));
  const jump = or(d[10], b.and(d[11], c), b.and(d[12], z), b.and(d[13], b.not(z)));
  const inc = [];
  let ci = b.one;
  for (let i = 0; i < 4; i++) {
    const [s, co] = b.halfAdd(pc[i], ci);
    inc.push(s);
    ci = co;
  }
  const nextPc = pc.map((x, i) => mux(jump, mux(d[15], inc[i], x), n[i]));

  pc.forEach((q, i) => b.setLatch(q, nextPc[i]));
  a.forEach((q, i) => b.setLatch(q, newA[i]));
  b.setLatch(c, newC);
  out.forEach((q, i) => b.setLatch(q, newOut[i]));
  ram.forEach((w, k) => w.forEach((q, i) => b.setLatch(q, newRam[k][i])));
  // signal numbers of a few named wires; in a flat circuit, signal s of beat k is trace leaf k * block + s
  return { ...b.build(newOut), signals: { sum, carry, newA, nextPc } };
}

// ------------------------------------------------------------------ assembler and reference

// "LD 0", "ADD 2", "OUT", "JMP 0" ... -> 16 bytes, padded with HLT 0
export function assemble(lines) {
  const prog = lines.map((l) => l.trim()).filter(Boolean).map((l) => {
    const [mn, arg = '0'] = l.split(/\s+/);
    const op = OPS.indexOf(mn.toUpperCase());
    if (op < 0) throw new Error(`unknown instruction ${mn}`);
    const n = Number(arg);
    if (!(n >= 0 && n < 16)) throw new Error(`operand out of range in "${l}"`);
    return (op << 4) | n;
  });
  if (prog.length > 16) throw new Error('at most 16 instructions');
  while (prog.length < 16) prog.push(0xf0);
  return prog;
}

export const disassemble = (byte) => {
  const mn = OPS[byte >> 4];
  return ['NOP', 'OUT', 'HLT'].includes(mn) ? mn : `${mn} ${byte & 15}`;
};

// Machine state as the circuit's state bits, and back.
export function toState({ pc = 0, a = 0, c = 0, out = 0, ram = [], rom }) {
  const s = [...bits(pc, 4), ...bits(a, 4), c & 1, ...bits(out, 4)];
  for (let k = 0; k < 16; k++) s.push(...bits(ram[k] ?? 0, 4));
  for (let k = 0; k < 16; k++) s.push(...bits(rom[k] ?? 0xf0, 8));
  return s;
}

export function fromState(s) {
  const at = (o, n) => num(s.slice(o, o + n));
  return {
    pc: at(STATE.pc, 4), a: at(STATE.a, 4), c: s[STATE.c], out: at(STATE.out, 4),
    ram: Array.from({ length: 16 }, (_, k) => at(STATE.ram + 4 * k, 4)),
    rom: Array.from({ length: 16 }, (_, k) => at(STATE.rom + 8 * k, 8)),
  };
}

// Plain-JS reference: one instruction.
export function cpuStep(m) {
  const { pc, a, c, out } = m;
  const ram = m.ram.slice();
  const inst = m.rom[pc], op = inst >> 4, n = inst & 15;
  let na = a, nc = c, no = out, npc = (pc + 1) & 15;
  const add = (x, y, cin) => { const s = x + y + cin; na = s & 15; nc = s >> 4; };
  switch (op) {
    case 1: na = n; break;
    case 2: na = ram[n]; break;
    case 3: ram[n] = a; break;
    case 4: add(a, ram[n], 0); break;
    case 5: add(a, ram[n], c); break;
    case 6: add(a, ~ram[n] & 15, 1); break;
    case 7: add(a, n, 0); break;
    case 8: na = a & ram[n]; break;
    case 9: na = a ^ ram[n]; break;
    case 10: npc = n; break;
    case 11: if (c) npc = n; break;
    case 12: if (a === 0) npc = n; break;
    case 13: if (a !== 0) npc = n; break;
    case 14: no = a; break;
    case 15: npc = pc; break;
  }
  return { pc: npc, a: na, c: nc, out: no, ram, rom: m.rom };
}

export function cpuRun(m, beats, onBeat) {
  m = fromState(toState(m)); // fill in the defaults: PC, A, C and OUT 0, empty RAM
  for (let i = 0; i < beats; i++) {
    m = cpuStep(m);
    if (onBeat) onBeat(i, m);
  }
  return m;
}

// The demo program: 8-bit Fibonacci on a 4-bit machine. a = M1:M0, b = M3:M2, t = M5:M4.
// Each pass of 16 instructions does (a, b) = (b, a + b) with a carry from the low nibble into the
// high one, and outputs the high nibble of the new term.
export const FIBONACCI = [
  'LD 0', 'ADD 2', 'ST 4', // t.lo = a.lo + b.lo, C = carry
  'LD 1', 'ADC 3', 'ST 5', // t.hi = a.hi + b.hi + C
  'LD 2', 'ST 0', 'LD 3', 'ST 1', // a = b
  'LD 4', 'ST 2', 'LD 5', 'ST 3', // b = t
  'OUT', 'JMP 0',
];

export function fibonacciMachine() {
  return { rom: assemble(FIBONACCI), ram: [0, 0, 1, 0] }; // a = 0, b = 1
}

// b after k passes is F(k + 1) mod 256.
export const fibMod256 = (k) => {
  let [x, y] = [0, 1];
  for (let i = 0; i < k; i++) [x, y] = [y, (x + y) & 255];
  return x;
};
