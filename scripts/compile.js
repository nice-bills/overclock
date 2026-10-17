// Compile contracts/*.sol with solc-js and write build/<Name>.json (abi + bytecode).
import solc from 'solc';
import { readFileSync, readdirSync, writeFileSync, mkdirSync } from 'node:fs';

const sources = {};
for (const f of readdirSync('contracts')) if (f.endsWith('.sol')) sources[f] = { content: readFileSync(`contracts/${f}`, 'utf8') };
const input = { language: 'Solidity', sources, settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: 'shanghai', outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } } } };
const out = JSON.parse(solc.compile(JSON.stringify(input)));
let failed = false;
for (const e of out.errors ?? []) {
  console.error(e.formattedMessage);
  if (e.severity === 'error') failed = true;
}
if (failed) process.exit(1);
mkdirSync('build', { recursive: true });
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    writeFileSync(`build/${name}.json`, JSON.stringify({ abi: c.abi, bytecode: '0x' + c.evm.bytecode.object }, null, 1));
    console.log(`compiled ${file}:${name}`);
  }
}
