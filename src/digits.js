// AlephTape's digit-recognition net, live on X Layer: a binarized neural net taped out as TapeOut
// circuit #11 on their processor ℵ₀ (github.com/lonetravelerxyz/alephtape). 64 inputs, an 8x8
// drawing, one byte per row with bit i the i-th pixel from the left; 70 outputs, ten 7-bit scores
// (little-endian), one per digit. The highest score is the answer.

import { unpack, hexToBytes } from './tap02.js';

export const DIGIT_NET = {
  processor: '0xb00E17789f905234F1890C22E6C01015c10d2f54',
  id: 11n,
  gates: 161_080,
  // AlephTape's README: a direct eval() of the net on a mainnet fork, 1.89 blocks
  directEvalGas: 396_410_201,
  // ours: eval(11, the 7 in DIGITS) through contracts/GasProbe.sol with eth_call on a ganache fork of
  // mainnet with a 2B gas limit (shanghai rules); the output matched our evaluator bit for bit
  measuredEvalGas: 388_354_847,
  // their ZK-proven result for their own test image (contracts/test/fixtures/bnn_proofs.json)
  fixture: { x: '0x3c6666666666663c', y: '0xd418f0969bf160471a' },
};

const rows = {
  0: ['..XXXX..', '.XX..XX.', '.XX..XX.', '.XX..XX.', '.XX..XX.', '.XX..XX.', '.XX..XX.', '..XXXX..'],
  1: ['...XX...', '..XXX...', '...XX...', '...XX...', '...XX...', '...XX...', '...XX...', '..XXXX..'],
  2: ['..XXXX..', '.XX..XX.', '.....XX.', '....XX..', '...XX...', '..XX....', '.XX.....', '.XXXXXX.'],
  3: ['..XXXX..', '.XX..XX.', '.....XX.', '...XXX..', '.....XX.', '.....XX.', '.XX..XX.', '..XXXX..'],
  4: ['....XX..', '...XXX..', '..X.XX..', '.X..XX..', '.XXXXXX.', '....XX..', '....XX..', '....XX..'],
  5: ['.XXXXXX.', '.XX.....', '.XXXXX..', '.....XX.', '.....XX.', '.....XX.', '.XX..XX.', '..XXXX..'],
  6: ['...XXX..', '..XX....', '.XX.....', '.XXXXX..', '.XX..XX.', '.XX..XX.', '.XX..XX.', '..XXXX..'],
  7: ['.XXXXXX.', '.....XX.', '....XX..', '....XX..', '...XX...', '...XX...', '..XX....', '..XX....'],
  8: ['..XXXX..', '.XX..XX.', '.XX..XX.', '..XXXX..', '.XX..XX.', '.XX..XX.', '.XX..XX.', '..XXXX..'],
  9: ['..XXXX..', '.XX..XX.', '.XX..XX.', '..XXXXX.', '.....XX.', '....XX..', '...XX...', '.XXX....'],
};

export const image = (lines) => '0x' + lines.map((row) => [...row].reduce((v, ch, i) => v | (ch === 'X' ? 1 << i : 0), 0).toString(16).padStart(2, '0')).join('');

// Hand-drawn digits; the live net reads each one correctly.
export const DIGITS = Object.fromEntries(Object.entries(rows).map(([d, r]) => [d, image(r)]));

export const scores = (outs) => Array.from({ length: 10 }, (_, k) => outs.slice(7 * k, 7 * k + 7).reduce((v, b, i) => v | (b << i), 0));

export const argmax = (s) => s.reduce((best, v, k) => (v > s[best] ? k : best), 0);

export const drawing = (hex) => {
  const bits = unpack(hexToBytes(hex), 64);
  return Array.from({ length: 8 }, (_, y) => '  ' + bits.slice(8 * y, 8 * y + 8).map((v) => (v ? '█' : '·')).join('')).join('\n');
};
