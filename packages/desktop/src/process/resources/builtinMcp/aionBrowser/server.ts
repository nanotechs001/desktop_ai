/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in MCP server `aionui-browser`: drives the AionUi browser pane through the agent relay.
 * Runs as a standalone stdio process spawned by the agent; stdout is the protocol channel, so nothing
 * else may write to it. The relay url and token arrive in AION_BROWSER_RELAY_URL / AION_BROWSER_RELAY_TOKEN.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { RelayClient } from './relayClient';
import { createBrowserMcpServer } from './tools';

async function main(): Promise<void> {
  const relay = new RelayClient(process.env, () => server.server.getClientVersion()?.name);
  const server = createBrowserMcpServer(relay);
  // The relay socket would keep the process alive after the agent closes our stdin.
  process.stdin.once('end', () => {
    relay.close();
    process.exit(0);
  });
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  process.stderr.write(`[builtin-mcp-browser] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
