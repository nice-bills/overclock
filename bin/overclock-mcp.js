#!/usr/bin/env node
// Overclock MCP server, for Claude, ChatGPT and any other MCP client.
//
//   RPC_URL=https://rpc.xlayer.tech [OVERCLOCK=0x...] overclock-mcp [--no-open]                 # stdio
//   RPC_URL=... overclock-mcp --http [--port 3333] [--host 127.0.0.1] [--read-only]            # Streamable HTTP at /mcp
//
// OVERCLOCK defaults to the public deployment on X Layer mainnet; on other chains, without it only
// the TapeOut tools are offered.
//
// Transactions are signed in the user's own wallet. connect_wallet returns a link to an approval
// page on localhost (WALLET_PORT, default: any free port; in HTTP mode the page is on the same
// server); the user connects OKX Wallet or MetaMask there and approves each transaction. In stdio
// mode the page opens in the browser the first time it is needed, unless --no-open.
//
// OVERCLOCK_PRIVATE_KEY is an opt-in fallback for unattended agents (a bot defending claims
// overnight): it signs without asking, so use a dedicated wallet holding only what it needs.
// --read-only serves the read-only tools alone, for endpoints other people can reach.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Wallet } from 'ethers';
import { WalletBridge } from '../src/wallet.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';

const root = fileURLToPath(new URL('..', import.meta.url));
if (!existsSync(new URL('../build/Overclock.json', import.meta.url))) {
  // contract ABIs come from build/; compile once, keeping stdout clean for the stdio transport
  const r = spawnSync(process.execPath, ['scripts/compile.js'], { cwd: root, stdio: ['ignore', process.stderr, 'inherit'] });
  if (r.status !== 0) process.exit(r.status ?? 1);
}
const { createServer } = await import('../src/mcp.js');
const { XLAYER } = await import('../src/tapeout.js');

const arg = (k, d) => { const i = process.argv.indexOf(`--${k}`); return i > 0 ? process.argv[i + 1] : d; };
const env = (k) => process.env[k] || undefined;
const [RPC_URL, OVERCLOCK, KEY, FACTORY, WALLET_PORT] = ['RPC_URL', 'OVERCLOCK', 'OVERCLOCK_PRIVATE_KEY', 'FACTORY', 'WALLET_PORT'].map(env);
if (!RPC_URL) {
  console.error('overclock-mcp: set RPC_URL; OVERCLOCK (the Overclock contract) enables job tools');
  process.exit(1);
}
const http = process.argv.includes('--http');
const readOnly = process.argv.includes('--read-only');
const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
const signer = KEY && !readOnly ? new Wallet(KEY, provider) : null;
if (env('PRIVATE_KEY') && !KEY) console.error('overclock-mcp: PRIVATE_KEY is ignored; transactions are approved in your wallet (set OVERCLOCK_PRIVATE_KEY to sign unattended)');
// On X Layer mainnet the job tools default to the public Overclock deployment.
const chainId = await provider.getNetwork().then((n) => n.chainId, () => null);
const wallet = signer || readOnly || chainId === null ? null : new WalletBridge({ provider, chainId, rpcUrl: RPC_URL, log: (e) => console.error('overclock-mcp: wallet', JSON.stringify(e)) });
const ctx = { provider, signer, wallet, readOnly, overclock: OVERCLOCK ?? (chainId === BigInt(XLAYER.chainId) ? XLAYER.overclock : undefined), factory: FACTORY };

// stdio: the approval page gets its own localhost server, started (and opened) the first time it is needed
if (wallet && !http) {
  let opened = false;
  ctx.ensureWallet = async () => {
    const url = await wallet.listen(Number(WALLET_PORT ?? 0));
    if (!opened && !process.argv.includes('--no-open') && !wallet.connected) { opened = true; openBrowser(url); }
  };
}

function openBrowser(url) {
  const [cmd, args] = process.platform === 'darwin' ? ['open', [url]] : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]] : ['xdg-open', [url]];
  import('node:child_process').then(({ spawn }) => {
    const p = spawn(cmd, args, { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
  });
}
const mode = signer ? 'signing with OVERCLOCK_PRIVATE_KEY' : wallet ? 'transactions approved in your wallet' : 'read-only';

if (http) {
  const port = Number(arg('port', 3333)), host = arg('host', '127.0.0.1');
  const srv = createHttpServer(async (req, res) => {
    if (wallet?.handle(req, res)) return;
    if (!req.url.startsWith('/mcp')) { res.writeHead(404).end(); return; }
    if (req.method !== 'POST') { res.writeHead(405, { Allow: 'POST' }).end(); return; }
    let body = '';
    for await (const chunk of req) body += chunk;
    // stateless: a fresh server per request; long-lived state (open disputes, caches) is on ctx
    const server = createServer(ctx);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { transport.close(); server.close(); });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
    } catch (e) {
      if (!res.headersSent) res.writeHead(400, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32700, message: e.message }, id: null }));
    }
  }).listen(port, host, () => {
    wallet?.setBase(`http://${host}:${srv.address().port}`);
    console.error(`overclock-mcp: http://${host}:${srv.address().port}/mcp (${mode})`);
  });
} else {
  await createServer(ctx).connect(new StdioServerTransport());
  console.error(`overclock-mcp: stdio (${mode})`);
}
