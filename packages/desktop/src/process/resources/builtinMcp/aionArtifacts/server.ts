/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in MCP server `aionui-artifacts`: lets an Agent create, update and read artifacts through the loopback
 * artifact server. Runs as a standalone stdio process spawned by the agent; stdout is the protocol channel, so nothing
 * else may write to it. The server url, token and conversation id arrive in AION_ARTIFACTS_URL, AION_ARTIFACTS_TOKEN
 * and AIONUI_CONVERSATION_ID.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createArtifactsApi } from './apiClient';
import { createArtifactsMcpServer } from './tools';

createArtifactsMcpServer(createArtifactsApi(process.env))
  .connect(new StdioServerTransport())
  .catch((error: unknown) => {
    process.stderr.write(`[builtin-mcp-artifacts] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
