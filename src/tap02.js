// TAP-02 netlist decoder, well-formedness check and one-beat evaluator.
// Mirrors the reference implementation in TapeOutProtocol/TAPs (assets/tap-02/reference.py).

export const NAND = 0x00, LATCH = 0x01, REF = 0x02;
const MAX_SIGNALS = 1 << 24;
const MAX_PINS = 1 << 16;

export class IllFormed extends Error {}

export function hexToBytes(hex) {
  const h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2) throw new Error('odd hex length');
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function bytesToHex(b) {
  return '0x' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function decode(data, nIn) {
  let p = 0;
  let next = 2 + nIn;
  const els = [];
  const take = (k) => {
    if (p + k > data.length) throw new IllFormed(`truncated record at byte ${p}`);
    const b = data.subarray(p, p + k);
    p += k;
    return b;
  };
  const u24 = () => { const b = take(3); return (b[0] << 16) | (b[1] << 8) | b[2]; };
  while (p < data.length) {
    const op = take(1)[0];
    let e;
    if (op === NAND) e = { op, ins: [u24(), u24()], nOut: 1 };
    else if (op === LATCH) e = { op, ins: [u24()], nOut: 1 };
    else if (op === REF) {
      const cpu = bytesToHex(take(20));
      const idBytes = take(8);
      let id = 0n;
      for (const x of idBytes) id = (id << 8n) | BigInt(x);
      const ni = take(1)[0], no = take(1)[0];
      const ins = [];
      for (let i = 0; i < ni; i++) ins.push(u24());
      e = { op, ins, cpu, id, nOut: no };
    } else throw new IllFormed(`unknown opcode 0x${op.toString(16).padStart(2, '0')} at byte ${p - 1}`);
    e.firstOut = next;
    next += e.nOut;
    els.push(e);
  }
  return els;
}

// resolve(cpu, id) -> Circuit | null
export function load(data, nIn, nOut, resolve = null) {
  const els = decode(data, nIn);
  const nSig = 2 + nIn + els.reduce((s, e) => s + e.nOut, 0);
  if (nSig > MAX_SIGNALS) throw new IllFormed('more than 2^24 signals');
  if (!(nIn >= 0 && nIn <= MAX_PINS && nOut >= 1 && nOut <= MAX_PINS)) throw new IllFormed('nIn/nOut out of range');
  if (nSig - 2 - nIn < nOut) throw new IllFormed('too few signals for outputs');
  const c = { nIn, nOut, elements: els, nSignals: nSig, nState: 0, nGates: 0, stateBase: [], subs: new Map() };
  for (const e of els) {
    for (const s of e.ins) {
      const limit = e.op === LATCH ? nSig : e.firstOut;
      if (s >= limit) throw new IllFormed(`signal ${s} referenced by element at ${e.firstOut} is not available`);
    }
    c.stateBase.push(c.nState);
    if (e.op === LATCH) c.nState += 1;
    else if (e.op === REF) {
      if (!resolve) throw new IllFormed('REF without a resolver');
      const sub = resolve(e.cpu, e.id);
      if (!sub) throw new IllFormed('REF target is not a circuit of a registered processor');
      if (sub.nIn !== e.ins.length || sub.nOut !== e.nOut) throw new IllFormed('REF arity does not match the target circuit');
      e.sub = sub;
      c.nState += sub.nState;
      c.nGates += sub.nGates;
    }
  }
  c.nGates += els.filter((e) => e.op !== REF).length;
  if (c.nState > MAX_SIGNALS) throw new IllFormed('size overflow');
  return c;
}

// One beat (TAP-02 §4). state, inputs: arrays of 0/1.
export function beat(c, state, inputs) {
  const a = [0, 1, ...inputs];
  const newState = state.slice();
  c.elements.forEach((e, k) => {
    const base = c.stateBase[k];
    if (e.op === NAND) a.push(1 - (a[e.ins[0]] & a[e.ins[1]]));
    else if (e.op === LATCH) a.push(state[base]);
    else {
      const [ns, outs] = beat(e.sub, state.slice(base, base + e.sub.nState), e.ins.map((s) => a[s]));
      for (let i = 0; i < ns.length; i++) newState[base + i] = ns[i];
      a.push(...outs);
    }
  });
  c.elements.forEach((e, k) => {
    if (e.op === LATCH) newState[c.stateBase[k]] = a[e.ins[0]];
  });
  return [newState, a.slice(a.length - c.nOut)];
}

export function pack(bits) {
  const out = new Uint8Array((bits.length + 7) >> 3);
  bits.forEach((v, i) => { if (v) out[i >> 3] |= 1 << (i & 7); });
  return out;
}

export function unpack(data, n) {
  const bits = [];
  for (let i = 0; i < n; i++) bits.push((i >> 3) < data.length ? (data[i >> 3] >> (i & 7)) & 1 : 0);
  return bits;
}
