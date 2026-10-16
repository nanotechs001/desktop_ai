/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { BUILTIN_ARTIFACTS_MCP_NAME, BUILTIN_BROWSER_MCP_NAME } from '@/common/config/constants';

const BLOCK_REASON = 'Use the AionUi browser pane tools (aionui-browser) instead of opening an external browser.';
const DEFAULT_FALLBACK_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];
const DENIED_BASH_TOOLS = ['Bash(open:*)', 'Bash(xdg-open:*)', 'Bash(osascript:*)'];

/**
 * True when a shell command would open an external browser (open, xdg-open, gio open, osascript, ...).
 * Must stay self-contained: buildHookScript() inlines it through toString(), so it may not reference
 * module-scope names or nested named functions.
 * shortcut: quote-aware split only; `$(...)` inside double quotes is not looked into, wrappers that take a
 * value flag other than a number (`sudo -u root`) are not stripped, and heredoc bodies are skipped even when a
 * shell reads them (`bash <<EOF`). Only one level of `sh -c` / `eval` is unwrapped.
 */
export function isBrowserOpenCommand(command: string): boolean {
  const browsers = 'Safari|Google Chrome|Chromium|Firefox|Arc|Brave Browser|Microsoft Edge|Opera|Vivaldi';
  const osascriptBrowser = new RegExp(`open location|tell\\s+application\\s+\\\\?["']?(?:${browsers})`, 'i');
  const heredocOpener = /^<<-?\s*(["']?)(\w+)\1/;
  const assignment = /^[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S*)\s+/;
  const wrapper =
    /^(?:(?:\S*\/)?(?:nohup|command|exec|sudo|env|time|nice|xargs)\s+(?:-\S+\s+(?:\d+\s+)?)*|(?:then|do|else)\s+|[{!]\s+)/;
  const systemDir = /^\/(?:usr\/(?:local\/)?|opt\/homebrew\/)?s?bin\//;
  const quoted = /^(["'])([\s\S]*)\1\s*$/;

  // A worklist instead of nested functions: the body is inlined into the hook script, and a bundler's
  // keepNames helper (`__name(...)`, renamed by the minifier) would not exist there.
  const queue = [{ text: command, depth: 0 }];
  for (const { text, depth } of queue) {
    const segments: string[] = [];
    const heredocTags: string[] = [];
    let current = '';
    let quote = '';
    let arithmeticEnd = -1;
    let i = 0;
    while (i < text.length) {
      const ch = text[i];
      if (quote) {
        if (ch === quote) quote = '';
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === '(' && text[i + 1] === '(') {
        arithmeticEnd = Math.max(arithmeticEnd, text.indexOf('))', i));
      } else if (ch === '<' && text[i + 1] === '<' && text[i - 1] !== '<' && text[i + 2] !== '<' && i > arithmeticEnd) {
        const opener = heredocOpener.exec(text.slice(i));
        if (opener) {
          heredocTags.push(opener[2]);
          current += opener[0];
          i += opener[0].length;
          continue;
        }
      } else if (ch === '\n' && heredocTags.length > 0) {
        // Skip the body of every heredoc opened on this line; an empty body ends at the first line.
        segments.push(current);
        current = '';
        i += 1;
        for (const tag of heredocTags.splice(0)) {
          while (i < text.length) {
            const lineEnd = text.indexOf('\n', i) < 0 ? text.length : text.indexOf('\n', i);
            const line = text.slice(i, lineEnd);
            i = lineEnd + 1;
            if (line.trim() === tag) break;
          }
        }
        continue;
      } else if ('&|;\n`()'.includes(ch)) {
        segments.push(current);
        current = '';
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
    }
    segments.push(current);

    for (const segment of segments) {
      let rest = segment.trim();
      let before: string;
      do {
        before = rest;
        rest = rest.replace(assignment, '').replace(wrapper, '');
      } while (rest !== before);

      const match = /^(\S+)\s*([\s\S]*)$/.exec(rest);
      if (!match) continue;
      const [, rawWord, args] = match;
      // `"open"`, `'open'` and `\open` run the same command.
      const word = rawWord.replace(/["'\\]/g, '');
      // A relative path (./open, scripts/open) is a local script, not the system opener.
      if (word.includes('/') && !systemDir.test(word)) continue;
      const name = word.replace(/^.*\//, '');
      if (name === 'open' || name === 'xdg-open' || name === 'sensible-browser') return true;
      if (name === 'gio' && /^open\b/.test(args)) return true;
      if (name === 'osascript' && osascriptBrowser.test(args)) return true;
      if (/^python[\d.]*$/.test(name)) {
        if (/(?:^|\s)-m\s+webbrowser\b/.test(args)) return true;
        if (/(?:^|\s)-c\s/.test(args) && /webbrowser/.test(args)) return true;
      }
      if (/^cmd(?:\.exe)?$/i.test(name) && /(?:^|\s)\/c\s+start\s+(?:"[^"]*"\s+)?https?/i.test(args)) return true;
      if (depth > 0) continue;
      if (name === 'eval') {
        queue.push({ text: quoted.exec(args.trim())?.[2] ?? args, depth: 1 });
      } else if (/^(?:ba|z|da)?sh$/.test(name)) {
        const inner = /^(?:-\S+\s+)*?-\w*c\s+(["'])([\s\S]*)\1\s*$/.exec(args);
        if (inner) queue.push({ text: inner[2], depth: 1 });
      }
    }
  }
  return false;
}

/**
 * CJS source of the Claude PreToolUse hook that denies Bash commands opening an external browser.
 * Emits both the legacy `decision: "block"` and the newer `permissionDecision: "deny"` forms;
 * Claude Code 2.1.x honours either. Fails open (exit 0, no output) on unreadable input.
 */
export function buildHookScript(): string {
  return `'use strict';
// Generated by AionUi. Do not edit.
const isBrowserOpenCommand = ${isBrowserOpenCommand.toString()};
const reason = ${JSON.stringify(BLOCK_REASON)};
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  raw += chunk;
});
process.stdin.on('end', () => {
  let input;
  try {
    input = JSON.parse(raw);
  } catch {
    return;
  }
  const command = input && input.tool_name === 'Bash' && input.tool_input ? input.tool_input.command : undefined;
  if (typeof command !== 'string' || !isBrowserOpenCommand(command)) return;
  process.stdout.write(
    JSON.stringify({
      decision: 'block',
      reason,
      hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
    })
  );
});
`;
}

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * POSIX sh launcher that runs the user's real `claude` with Claude in Chrome off, browser-launching Bash
 * commands denied, and the PreToolUse hook at `hookPath` installed. It never re-launches itself.
 */
export function buildLauncherScript(hookPath: string, fallbackDirs: string[] = DEFAULT_FALLBACK_DIRS): string {
  const hookCommand = `node "${hookPath.replace(/[\\"$`]/g, '\\$&')}"`;
  // aioncore never turns "Always allow" into a claude allow rule, so pre-approve the built-in browser and artifacts servers here.
  const settings = JSON.stringify({
    permissions: { allow: [`mcp__${BUILTIN_BROWSER_MCP_NAME}`, `mcp__${BUILTIN_ARTIFACTS_MCP_NAME}`] },
    hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand }] }] },
  });
  const fallbackWords = fallbackDirs.map(shellQuote).join(' ');
  const extraPath = fallbackDirs.map((dir) => `:${dir}`).join('');
  return `#!/bin/sh
# Generated by AionUi. Starts the real Claude CLI with browser safeguards. Do not edit.
ORIG_PATH=$PATH
PATH=$PATH:/usr/bin:/bin

resolve() {
  p=$1
  while [ -L "$p" ]; do
    l=$(readlink "$p")
    case $l in /*) p=$l ;; *) p=\${p%/*}/$l ;; esac
  done
  d=\${p%/*}
  if [ "$d" = "$p" ]; then d=.; elif [ -z "$d" ]; then d=/; fi
  d=$(cd "$d" 2>/dev/null && pwd -P) || return 1
  printf '%s/%s\\n' "$d" "\${p##*/}"
}

candidates() {
  IFS=:
  for d in $ORIG_PATH; do
    if [ -n "$d" ]; then printf '%s\\n' "$d/claude"; fi
  done
  unset IFS
  ls -d "$HOME"/.nvm/versions/node/*/bin/claude 2>/dev/null | sort -rV
  printf '%s\\n' "$HOME/.local/bin/claude" "$HOME/.claude/local/claude"
  for d in ${fallbackWords}; do
    printf '%s\\n' "$d/claude"
  done
}

self=$(resolve "$0")
real=$(candidates | while IFS= read -r c; do
  if [ -f "$c" ] && [ -x "$c" ] && [ "$(resolve "$c")" != "$self" ]; then
    printf '%s\\n' "$c"
    break
  fi
done)

if [ -z "$real" ]; then
  echo "AionUi: could not find Claude Code. Install Claude Code (https://claude.com/claude-code), or set your own Claude command in AionUi's agent settings." >&2
  exit 127
fi

# The hook runs \`node\`; keep it reachable when the app was started with a minimal PATH.
PATH="\${ORIG_PATH:+$ORIG_PATH:}\${real%/*}${extraPath}"
# --disallowedTools is variadic, so --settings must follow it.
exec "$real" "$@" --no-chrome --disallowedTools ${DENIED_BASH_TOOLS.map((tool) => `"${tool}"`).join(' ')} --settings ${shellQuote(settings)}
`;
}

export type ClaudeLauncherDeps = {
  homeDir: string;
  listAgents(): Promise<{ id: string; backend: string; source?: string }[]>;
  getOverrides(id: string): Promise<{ command_override?: string }>;
  setOverride(id: string, cmd: string): Promise<void>;
  /** Returns null when the file does not exist. */
  readFile(p: string): Promise<string | null>;
  writeFile(p: string, s: string, mode: number): Promise<void>;
  warn(msg: string): void;
};

export type ClaudeLauncherResult = 'installed' | 'already' | 'user-override' | 'no-claude-agent' | 'failed';

const SCRIPT_MODE = 0o755;

/**
 * Install the launcher + hook under `<home>/.aionui/bin` and register the launcher as Claude's command
 * override, unless the user already set their own. Scripts are rewritten only when their content differs.
 */
export async function ensureClaudeLauncher(deps: ClaudeLauncherDeps): Promise<ClaudeLauncherResult> {
  try {
    const claudeAgents = (await deps.listAgents()).filter((a) => a.backend === 'claude');
    const agent = claudeAgents.find((a) => a.source === 'builtin') ?? claudeAgents[0];
    if (!agent) return 'no-claude-agent';

    const current = (await deps.getOverrides(agent.id)).command_override;
    const binDir = path.join(deps.homeDir, '.aionui', 'bin');
    const hookPath = path.join(binDir, 'aion-block-browser-open.cjs');
    const launcherPath = path.join(binDir, 'claude-aion');
    if (current && current !== launcherPath) {
      deps.warn('You set your own Claude command, so AionUi did not add its browser safeguards.');
      return 'user-override';
    }

    const scripts = [
      [hookPath, buildHookScript()],
      [launcherPath, buildLauncherScript(hookPath)],
    ] as const;
    await Promise.all(
      scripts.map(async ([file, content]) => {
        if ((await deps.readFile(file)) !== content) await deps.writeFile(file, content, SCRIPT_MODE);
      })
    );
    if (current === launcherPath) return 'already';

    await deps.setOverride(agent.id, launcherPath);
    return 'installed';
  } catch (error) {
    console.error('[AionUi] Claude launcher setup failed:', error);
    return 'failed';
  }
}
