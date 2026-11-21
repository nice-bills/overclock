// Which Overclock contract a server points at: env override, then deployments/<chainId>.json, then
// (X Layer mainnet only) the built-in address. deployments/ is the one place a network's v2 address lives.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { resolveDeployment, readDeployment, deploymentVersion, DEPLOYMENTS_DIR } from '../src/config.js';
import { XLAYER } from '../src/tapeout.js';

const A = '0x' + '11'.repeat(20), B = '0x' + '22'.repeat(20), F = '0x' + '33'.repeat(20);
const withDir = (files, fn) => {
  const d = mkdtempSync(join(tmpdir(), 'overclock-config-'));
  try {
    for (const [name, body] of Object.entries(files)) writeFileSync(join(d, name), JSON.stringify(body));
    return fn(pathToFileURL(d + '/'));
  } finally { rmSync(d, { recursive: true, force: true }); }
};

test('a testnet v2 deployment file is all a server needs', () => withDir({
  '1952.json': { chainId: 1952, overclock: A, factory: F, bondBps: 10000, machines: { life: { processor: B, circuitId: 5 } } },
}, (dir) => {
  const r = resolveDeployment(1952n, { env: {}, dir });
  assert.equal(r.overclock, A);
  assert.equal(r.factory, F);
  assert.equal(r.version, 'v2');
  assert.deepEqual(r.machines, { life: { processor: B, circuitId: 5 } });
}));

test('OVERCLOCK and FACTORY in the environment override the file', () => withDir({ '1952.json': { overclock: A, factory: F, bondBps: 1 } }, (dir) => {
  const r = resolveDeployment(1952n, { env: { OVERCLOCK: B, FACTORY: B }, dir });
  assert.equal(r.overclock, B);
  assert.equal(r.factory, B);
  assert.equal(r.version, null, 'an override says nothing about the file\'s version');
}));

test('a v1 file is recognised so the server can say it is not serving v2', () => withDir({ '1952.json': { overclock: A, factory: F } }, (dir) => {
  assert.equal(resolveDeployment(1952, { env: {}, dir }).version, 'v1');
  assert.equal(deploymentVersion({}), null);
}));

test('X Layer mainnet falls back to the built-in address; other chains with no file get nothing', () => withDir({}, (dir) => {
  const m = resolveDeployment(196n, { env: {}, dir });
  assert.equal(m.overclock, XLAYER.overclock);
  assert.equal(m.factory, undefined);
  assert.deepEqual(readDeployment(1337, dir), {});
  assert.equal(resolveDeployment(1337n, { env: {}, dir }).overclock, undefined);
  assert.equal(resolveDeployment(null, { env: {}, dir }).overclock, undefined);
}));

test('on mainnet the deployment file wins over the built-in address, and the factory comes from the contract', () => withDir({ '196.json': { overclock: A, factory: F, bondBps: 5000 } }, (dir) => {
  const r = resolveDeployment(196n, { env: {}, dir });
  assert.equal(r.overclock, A);
  assert.equal(r.factory, undefined);
}));

test('the committed deployments/*.json are well formed, and mainnet agrees with the built-in address', () => {
  const files = readdirSync(DEPLOYMENTS_DIR).filter((f) => f.endsWith('.json'));
  assert.ok(files.includes('196.json') && files.includes('1952.json'));
  for (const f of files) {
    const d = JSON.parse(readFileSync(new URL(f, DEPLOYMENTS_DIR), 'utf8'));
    assert.equal(`${d.chainId}.json`, f);
    assert.match(d.overclock, /^0x[0-9a-fA-F]{40}$/, f);
    if (d.bondBps !== undefined) assert.equal(deploymentVersion(d), 'v2');
  }
  assert.equal(resolveDeployment(196n, { env: {} }).overclock.toLowerCase(), XLAYER.overclock.toLowerCase());
});
