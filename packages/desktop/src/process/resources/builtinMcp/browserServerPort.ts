/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 解析应用内浏览器 MCP 该连接的 CDP 地址。
 *
 * 单独成文件是为了可测试：browserServer.ts 是个有顶层副作用的启动脚本（会 spawn
 * 子进程），没法直接在单测里 import。
 *
 * Resolves which CDP endpoint the in-app browser MCP should connect to. Kept in
 * its own module for testability: browserServer.ts is an entry script with
 * top-level side effects (it spawns a child), so it cannot be imported by tests.
 */

const DEFAULT_CDP_HOST = '127.0.0.1';

export type ResolveBrowserUrlDeps = {
  env: NodeJS.ProcessEnv;
};

const toBrowserUrl = (port: number): string | null => {
  if (!Number.isInteger(port) || port <= 0 || port > 65535) return null;
  return `http://${DEFAULT_CDP_HOST}:${port}`;
};

/**
 * Only trust the port inherited down this process tree (AIONUI_CDP_ACTIVE_PORT); never guess one,
 * which could connect the agent to another instance's browser.
 *
 * Legacy: the single-target bridge that exported this env was replaced by the agent relay
 * (AION_BROWSER_RELAY_URL / AION_BROWSER_RELAY_TOKEN), so this now resolves null and the MCP reports
 * agent control as unavailable until Task 6 moves this server onto the relay.
 */
export const resolveBrowserUrl = (deps: ResolveBrowserUrlDeps): string | null => {
  const { env } = deps;

  const rawPort = env.AIONUI_CDP_ACTIVE_PORT?.trim();
  if (rawPort) {
    const fromEnv = toBrowserUrl(Number(rawPort));
    if (fromEnv) return fromEnv;
  }

  return null;
};

/**
 * Legacy token of the removed single-target bridge (AIONUI_CDP_BRIDGE_TOKEN); no longer exported by
 * the app, so this resolves null until Task 6 replaces this server. Its absence means the MCP must
 * exit rather than fall back to spawning a separate Chrome the user cannot see.
 */
export const resolveBridgeToken = (deps: ResolveBrowserUrlDeps): string | null => {
  const raw = deps.env.AIONUI_CDP_BRIDGE_TOKEN?.trim();
  return raw ? raw : null;
};

/**
 * 决定用什么命令行拉起 chrome-devtools-mcp。
 *
 * 抽到这里只为可测：browserServer.ts 顶层就 spawn，单测没法 import 它，于是 Windows
 * 那条分支以前完全没有测试覆盖 —— 这正是 issue #3883 能溜过去的原因。
 *
 * Windows 上 npx 是 npx.cmd，批处理文件没有终端无法自己执行，直接 spawn 会抛 EINVAL
 * （CVE-2024-27980 之后 Node 收紧了 .cmd 处理）。这里走 cmd.exe /c 而不是 shell: true，
 * 理由见 browserServer.ts 里的详细说明（DEP0190 + browserUrl 会被 shell 解析）。
 *
 * Decides the command line used to launch chrome-devtools-mcp. Extracted purely for
 * testability: browserServer.ts spawns at module scope so tests cannot import it, which left
 * the Windows branch with no coverage at all — the reason issue #3883 slipped through.
 *
 * On Windows npx is npx.cmd, a batch file that cannot execute without a terminal, so spawning
 * it directly throws EINVAL (Node tightened .cmd handling after CVE-2024-27980). We route
 * through cmd.exe /c rather than shell: true; see browserServer.ts for the full rationale
 * (DEP0190, plus browserUrl would be parsed by the shell).
 */
export const buildMcpSpawnCommand = (deps: {
  platform: string;
  version: string;
  browserUrl: string;
}): { command: string; args: string[] } => {
  const mcpArgs = ['-y', `chrome-devtools-mcp@${deps.version}`, '--browser-url', deps.browserUrl];
  return deps.platform === 'win32'
    ? { command: 'cmd.exe', args: ['/c', 'npx', ...mcpArgs] }
    : { command: 'npx', args: mcpArgs };
};
