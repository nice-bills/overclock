#!/bin/sh
# Starts the Overclock MCP server from a plugin install: installs runtime dependencies on first
# run (to stderr, so the stdio channel stays clean), then hands over to node.
cd "$(dirname "$0")/.." || exit 1
if [ ! -d node_modules/@modelcontextprotocol/sdk ]; then
  npm install --omit=dev --no-audit --no-fund >&2 || exit 1
fi
exec node bin/overclock-mcp.js "$@"
