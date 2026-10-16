/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in MCP server `aionui-notes`: lets an Agent save lessons in its notebook through the loopback artifact server.
 * Runs as a standalone stdio process spawned by the agent; stdout is the protocol channel, so nothing else may write to
 * it. The server url, token and conversation id arrive in AION_ARTIFACTS_URL, AION_ARTIFACTS_TOKEN and
 * AIONUI_CONVERSATION_ID; the app, not this process, decides which Agent the chat belongs to.
 */

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { createArtifactsApi } from '../aionArtifacts/apiClient';
import { NOTES_LABEL, createNotesMcpServer } from './tools';

createNotesMcpServer(createArtifactsApi(process.env, fetch, NOTES_LABEL))
  .connect(new StdioServerTransport())
  .catch((error: unknown) => {
    process.stderr.write(`[builtin-mcp-notes] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
