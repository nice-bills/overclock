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

import { existsSync, readFileSync } from 'node:fs';
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
// deployments/<chainId>.json gives this network's Overclock contract, factory and ready-made machines.
const depFile = chainId === null ? null : new URL(`../deployments/${chainId}.json`, import.meta.url);
const dep = depFile && existsSync(depFile) ? JSON.parse(readFileSync(depFile, 'utf8')) : {};
const ctx = {
  provider, signer, wallet, readOnly, approvalWaitMs: env('OVERCLOCK_APPROVAL_WAIT_MS') && Number(env('OVERCLOCK_APPROVAL_WAIT_MS')),
  overclock: OVERCLOCK ?? dep.overclock ?? (chainId === BigInt(XLAYER.chainId) ? XLAYER.overclock : undefined),
  factory: FACTORY ?? (chainId === BigInt(XLAYER.chainId) ? undefined : dep.factory), machines: dep.machines,
};

// OVERCLOCK_OPERATOR_KEY: also run an operator here, claiming every open job, defending its claims
// and finalizing them, so jobs posted through this server come back with a result. Meant for a
// testnet or a dedicated wallet that holds only the bond and gas.
if (env('OVERCLOCK_OPERATOR_KEY') && ctx.overclock) {
  const { Contract } = await import('ethers');
  const { Operator } = await import('../src/agents.js');
  const { artifact } = await import('../src/chain.js');
  const opWallet = new Wallet(env('OVERCLOCK_OPERATOR_KEY'), provider);
  const op = new Operator({
    oc: new Contract(ctx.overclock, artifact('Overclock').abi, provider), signer: opWallet, name: 'operator',
    log: (e) => console.error(`overclock-mcp: operator ${e.what}${e.tx ? ` ${e.tx}` : ''}`),
    settle: async (rc) => { while ((await provider.getBlockNumber()) < rc.blockNumber) await new Promise((r) => setTimeout(r, 1000)); },
  });
  console.error(`overclock-mcp: operator ${opWallet.address} claims jobs on ${ctx.overclock}`);
  (async () => {
    for (;;) {
      try { await op.tick(); } catch (e) { console.error('overclock-mcp: operator', e.shortMessage ?? e.message); }
      await new Promise((r) => setTimeout(r, Number(env('OPERATOR_POLL_MS') ?? 5000)));
    }
  })();
}

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
    // MOVED_TO: this server was replaced; send every request (and connector) to the new address
    if (env('MOVED_TO')) { res.writeHead(308, { location: env('MOVED_TO').replace(/\/$/, '') + req.url }).end(); return; }
    if (req.url.startsWith('/wallet/')) {
      const b = bridges.get(req.url.split(/[/?]/)[2]);
      if (!b?.handle(req, res)) res.writeHead(404).end();
      return;
    }
    if (req.url === '/health') { res.writeHead(200, { 'content-type': 'text/plain' }).end('overclock-mcp: MCP endpoint at /mcp\n'); return; }
    if (req.url === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(landing(origin(req))); return; }
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
      if (req.method === 'GET' && /text\/html/.test(req.headers.accept ?? '')) { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(landing(origin(req))); return; }
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

// What a person sees opening the server in a browser: how to add it to Claude.
function landing(base) {
  const url = `${base}/mcp`.replace(/[<>&"]/g, '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Overclock for Claude</title><link rel="icon" href="data:,">
<style>:root{--bg:#f6f5f1;--fg:#16150f;--mute:#6b6a63;--line:#dedcd3;--card:#fff}@media (prefers-color-scheme:dark){:root{--bg:#111110;--fg:#eceae3;--mute:#9a988f;--line:#2a2926;--card:#1a1918}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.55 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}main{max-width:560px;margin:0 auto;padding:40px 16px}
h1{font-size:22px;margin:0 0 6px}p,li{color:var(--mute)}code{font:14px ui-monospace,Menlo,monospace;word-break:break-all;background:var(--card);border:1px solid var(--line);border-radius:8px;padding:10px 12px;display:block;color:var(--fg)}
button{font:inherit;margin-top:10px;padding:8px 14px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg)}</style></head><body><main>
<h1>Overclock for Claude</h1><p>This address is an MCP connector: it is meant for Claude, not for a browser. It lets Claude read and post Overclock jobs on X Layer. Every transaction is approved in your own wallet.</p>
<code id="u">${url}</code><button onclick="navigator.clipboard.writeText(document.getElementById('u').textContent);this.textContent='Copied'">Copy URL</button>
<ol><li>In Claude, open Settings, then Connectors, then Add custom connector.</li><li>Name it Overclock and paste the URL above. No sign-in is needed.</li><li>In a chat, turn Overclock on and ask it to do something. When it needs to send a transaction, it gives you a link to approve it in OKX Wallet or MetaMask.</li></ol>
<p><a href="https://github.com/nice-bills/overclock" style="color:inherit">Source on GitHub</a></p></main></body></html>`;
}
