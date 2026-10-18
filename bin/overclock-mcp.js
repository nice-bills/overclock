#!/usr/bin/env node
// Overclock MCP server, for Claude, ChatGPT and any other MCP client.
//
//   RPC_URL=https://rpc.xlayer.tech [OVERCLOCK=0x...] [PRIVATE_KEY=0x...] overclock-mcp          # stdio
//   RPC_URL=... OVERCLOCK=0x... overclock-mcp --http [--port 3333] [--host 127.0.0.1]           # Streamable HTTP at /mcp
//
// OVERCLOCK defaults to the public deployment on X Layer mainnet; on other chains, without it only
// the TapeOut tools are offered. Without PRIVATE_KEY only read-only tools are offered.
// Anyone who can reach the HTTP endpoint can use the configured wallet, so keep it on localhost or
// put it behind your own auth.

import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import { JsonRpcProvider, Wallet } from 'ethers';
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
const [RPC_URL, OVERCLOCK, PRIVATE_KEY, FACTORY] = ['RPC_URL', 'OVERCLOCK', 'PRIVATE_KEY', 'FACTORY'].map(env);
if (!RPC_URL) {
  console.error('overclock-mcp: set RPC_URL; OVERCLOCK (the Overclock contract) enables job tools, PRIVATE_KEY enables transactions');
  process.exit(1);
}
const provider = new JsonRpcProvider(RPC_URL, undefined, { cacheTimeout: -1 });
const signer = PRIVATE_KEY ? new Wallet(PRIVATE_KEY, provider) : null;
// On X Layer mainnet the job tools default to the public Overclock deployment.
const chainId = await provider.getNetwork().then((n) => n.chainId, () => null);
const ctx = { provider, signer, overclock: OVERCLOCK ?? (chainId === BigInt(XLAYER.chainId) ? XLAYER.overclock : undefined), factory: FACTORY };

if (process.argv.includes('--http')) {
  const port = Number(arg('port', 3333)), host = arg('host', '127.0.0.1');
  createHttpServer(async (req, res) => {
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
  }).listen(port, host, () => console.error(`overclock-mcp: http://${host}:${port}/mcp (${signer ? 'wallet configured' : 'read-only'})`));
} else {
  await createServer(ctx).connect(new StdioServerTransport());
  console.error(`overclock-mcp: stdio (${signer ? 'wallet configured' : 'read-only'})`);
}
