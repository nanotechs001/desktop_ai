#!/usr/bin/env node
// Spike probe stdio MCP: appends its env key NAMES (never values) to argv[2], then answers
// initialize / tools/list (no tools) so the client treats it as a healthy server.
const fs = require('node:fs');
const out = process.argv[2];
const watched = ['AIONUI_CONVERSATION_ID', 'AION_ARTIFACTS_URL', 'AION_ARTIFACTS_TOKEN'];
fs.appendFileSync(
  out,
  JSON.stringify({
    pid: process.pid,
    keys: Object.keys(process.env).toSorted(),
    watched: Object.fromEntries(watched.map((k) => [k, k in process.env])),
  }) + '\n'
);
let buf = '';
process.stdin.on('data', (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, nl).trim();
    buf = buf.slice(nl + 1);
    if (!line) continue;
    const msg = JSON.parse(line);
    if (msg.id === undefined) continue;
    const result =
      msg.method === 'initialize'
        ? {
            protocolVersion: msg.params?.protocolVersion ?? '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'spike-probe', version: '0.0.0' },
          }
        : msg.method === 'tools/list'
          ? { tools: [] }
          : {};
    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }) + '\n');
  }
});
