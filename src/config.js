// Which Overclock contract a server points at. One place decides it, in this order:
//   1. the OVERCLOCK / FACTORY environment variables (an explicit override);
//   2. deployments/<chainId>.json, which scripts/deploy-stack.js (testnet playground) and
//      scripts/deploy.js (mainnet) write;
//   3. on X Layer mainnet only, the address built into src/tapeout.js.
//
// To point a hosted server at a new contract, deploy it (the script rewrites deployments/<chainId>.json)
// and redeploy the server. For X Layer testnet (chain 1952) that file is the single place that holds
// the v2 address; nothing else in the code names it.

import { existsSync, readFileSync } from 'node:fs';
import { XLAYER } from './tapeout.js';

export const DEPLOYMENTS_DIR = new URL('../deployments/', import.meta.url);

export function readDeployment(chainId, dir = DEPLOYMENTS_DIR) {
  if (chainId === null || chainId === undefined) return {};
  const file = new URL(`${chainId}.json`, dir.href.endsWith('/') ? dir : new URL(`${dir.href}/`));
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
}

// v2 deployments record bondBps (the share of a job's fee added to its bond); v1 ones do not.
export const deploymentVersion = (dep) => (dep.overclock ? (dep.bondBps === undefined ? 'v1' : 'v2') : null);

export function resolveDeployment(chainId, { env = process.env, dir = DEPLOYMENTS_DIR } = {}) {
  const dep = readDeployment(chainId, dir);
  const mainnet = chainId !== null && chainId !== undefined && BigInt(chainId) === BigInt(XLAYER.chainId);
  const e = (k) => env[k] || undefined;
  const overclock = e('OVERCLOCK') ?? dep.overclock ?? (mainnet ? XLAYER.overclock : undefined);
  return {
    dep,
    overclock,
    factory: e('FACTORY') ?? (mainnet ? undefined : dep.factory),
    machines: dep.machines,
    version: e('OVERCLOCK') ? null : deploymentVersion(dep),
  };
}
