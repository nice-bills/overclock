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
// server, one per MCP session); the user connects OKX Wallet or MetaMask there and approves each
// transaction. In stdio
// mode the page opens in the browser the first time it is needed, unless --no-open.
//
// OVERCLOCK_PRIVATE_KEY is an opt-in fallback for unattended agents (a bot defending claims
// overnight): it signs without asking, so use a dedicated wallet holding only what it needs.
// Hosted (a claude.ai connector), set PUBLIC_URL to the server's public address; approval pages
// are served from it. --read-only serves the read-only tools alone.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
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
const walletOn = !signer && !readOnly && chainId !== null;
const newBridge = () => new WalletBridge({ provider, chainId, rpcUrl: RPC_URL, log: (e) => console.error('overclock-mcp: wallet', JSON.stringify(e)) });
const wallet = walletOn && !http ? newBridge() : null;
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
const mode = signer ? 'signing with OVERCLOCK_PRIVATE_KEY' : walletOn ? 'transactions approved in your wallet' : 'read-only';

if (http) {
  // One MCP session per client (a claude.ai chat, say), each with its own approval page and wallet,
  // so one person's transactions never pop up in another's wallet. Caches are shared.
  const port = Number(arg('port', process.env.PORT ?? 3333)), host = arg('host', '127.0.0.1');
  const PUBLIC_URL = env('PUBLIC_URL'); // where the approval pages are reachable, e.g. https://overclock-mcp.onrender.com
  const base = { ...ctx, circuitCache: new Map() };
  const sessions = new Map(); // session id -> { transport, server, ctx, seen }
  const bridges = new Map(); // approval page token -> WalletBridge
  const origin = (req) => PUBLIC_URL ?? `${String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0]}://${req.headers.host}`;
  const json = (res, code, error) => res.writeHead(code, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', error, id: null }));

  const srv = createHttpServer(async (req, res) => {
    if (req.url.startsWith('/wallet/')) {
      const b = bridges.get(req.url.split(/[/?]/)[2]);
      if (!b?.handle(req, res)) res.writeHead(404).end();
      return;
    }
    if (req.url === '/' || req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }).end('overclock-mcp: MCP endpoint at /mcp\n'); return; }
    if (!req.url.startsWith('/mcp')) { res.writeHead(404).end(); return; }
    let body;
    if (req.method === 'POST') {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      try { body = raw ? JSON.parse(raw) : undefined; } catch (e) { json(res, 400, { code: -32700, message: e.message }); return; }
    }
    const sid = req.headers['mcp-session-id'];
    let s = sid ? sessions.get(sid) : null;
    if (sid && !s) { json(res, 404, { code: -32001, message: 'Session not found; initialize a new one' }); return; }
    if (!s) {
      if (req.method !== 'POST') { json(res, 400, { code: -32000, message: 'No session; send initialize first' }); return; }
      const sctx = { ...base };
      if (walletOn) {
        sctx.wallet = newBridge();
        sctx.wallet.setBase(origin(req));
        bridges.set(sctx.wallet.token, sctx.wallet);
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(), enableJsonResponse: true,
        onsessioninitialized: (id) => sessions.set(id, s),
      });
      transport.onclose = () => { sessions.delete(transport.sessionId); if (sctx.wallet) bridges.delete(sctx.wallet.token); };
      const server = createServer(sctx);
      await server.connect(transport);
      s = { transport, server, ctx: sctx };
    }
    s.seen = Date.now();
    try {
      await s.transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) json(res, 400, { code: -32000, message: e.message });
    }
  }).listen(port, host, () => console.error(`overclock-mcp: http://${host}:${srv.address().port}/mcp (${mode})`));

  // Forget sessions idle for six hours, unless a transaction is waiting on their wallet.
  setInterval(() => {
    for (const [id, s] of sessions)
      if (Date.now() - s.seen > 6 * 3600_000 && !s.ctx.wallet?.pending.size) { s.transport.close(); sessions.delete(id); }
  }, 600_000).unref();
} else {
  await createServer(ctx).connect(new StdioServerTransport());
  console.error(`overclock-mcp: stdio (${mode})`);
}
