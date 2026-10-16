#!/usr/bin/env node
// Spike stub claude (set as the claude agent's command_override): records argv, env key NAMES (never values)
// and whether AIONUI_CONVERSATION_ID equals the conversation id at the end of --plugin-dir, then exits.
// The output file comes from SPIKE_STUB_OUT baked into a wrapper (see probe-backend.sh).
const fs = require('node:fs');
const a = process.argv.slice(2);
const pluginDir = a.includes('--plugin-dir') ? a[a.indexOf('--plugin-dir') + 1] : '';
const conv = pluginDir.split('/').pop() || null;
fs.appendFileSync(
  process.env.SPIKE_STUB_OUT,
  JSON.stringify({
    argv: a,
    envKeys: Object.keys(process.env).toSorted(),
    convIdEnvMatches: !!conv && process.env.AIONUI_CONVERSATION_ID === conv,
  }) + '\n'
);
if (a.includes('--version')) console.log('2.1.0 (Claude Code)');
