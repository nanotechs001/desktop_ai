/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron';
import http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';
import { getDevAppName } from '@/common/platform';
import { applyGpuRecoveryFlags } from './gpuRecovery';

// ============ E2E test isolation ============
// When running under E2E with an explicit sandbox dir, redirect userData there
// BEFORE any getPath() call so the whole data tree (config, aioncore DB, logs)
// lives in a disposable directory. This keeps tests off the developer's real
// database — critical because AionCore refuses to boot when a shared DB fails
// migration. Guarded by AIONUI_E2E_TEST so it never affects dev/production.
// 仅 E2E：把 userData 指向一次性沙箱目录，避免测试读写真实数据库。
const e2eUserDataDir = process.env.AIONUI_E2E_TEST === '1' ? process.env.AIONUI_E2E_USER_DATA_DIR : undefined;
if (e2eUserDataDir && e2eUserDataDir.trim() !== '') {
  fs.mkdirSync(e2eUserDataDir, { recursive: true });
  app.setPath('userData', e2eUserDataDir);
}

// ============ Environment Separation ============
// Set app name before any getPath() call so userData is isolated from production.
// Note: getPlatformServices() auto-registration also applies this as a safety net
// in case Rollup loads initStorage's chunk before this module runs.
// 开发模式下设置独立 app 名称，userData 目录将与正式版隔离，允许同时运行
// E2E 沙箱已显式设置 userData 时跳过，避免被 dev app 名覆盖。
if (!app.isPackaged && !e2eUserDataDir) {
  const devAppName = getDevAppName();
  app.setName(devAppName);
  // In Electron 28+, setName alone no longer updates userData path on macOS.
  // Explicitly override userData to the dev directory.
  const appSupportDir = path.dirname(app.getPath('userData'));
  app.setPath('userData', path.join(appSupportDir, devAppName));
}

// The installed app uses its own data folder (%APPDATA%\Pixebot Browser on Windows), separate from a stock
// AionUi install whose backend may run different database migrations. Keep in sync with installerLastFailure.ts.
const PRODUCTION_DATA_DIR_NAME = 'Pixebot Browser';
if (app.isPackaged && !e2eUserDataDir) {
  app.setPath('userData', path.join(app.getPath('appData'), PRODUCTION_DATA_DIR_NAME));
}

// app.disableHardwareAcceleration() must run before app is ready.
applyGpuRecoveryFlags();

// Configure Chromium command-line flags for WebUI and CLI modes
// 为 WebUI 和 CLI 模式配置 Chromium 命令行参数

const isWebUI = process.argv.some((arg) => arg === '--webui');
const isResetPassword = process.argv.includes('--resetpass');

// Only configure flags for WebUI and --resetpass modes
// 仅为 WebUI 和重置密码模式配置参数
if (isWebUI || isResetPassword) {
  // In WebUI/reset-password mode on Linux, force headless Ozone backend.
  // This mode should never depend on X11/Wayland availability.
  // 在 Linux 的 WebUI/重置密码模式下，强制使用 headless Ozone 后端，
  // 避免因 DISPLAY 变量存在但显示服务不可用导致平台初始化失败。
  // Note: Do NOT use --headless (browser automation mode that causes auto-exit).
  // Instead, use --ozone-platform=headless which provides a proper display backend
  // without requiring a display server, keeping the Electron process alive.
  if (process.platform === 'linux') {
    app.commandLine.appendSwitch('ozone-platform', 'headless');
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-software-rasterizer');
  }

  // For root user, disable sandbox to prevent crash
  // 对于 root 用户，禁用沙箱以防止崩溃
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    app.commandLine.appendSwitch('no-sandbox');
  }
}

// ---------------------------------------------------------------------------
// Agent browser control (CDP) — user-facing on/off switch and its persisted config.
//
// This block allocates no port. The agent relay (process/services/agentBrowser/relay) binds an
// OS-assigned port via listen(0) and backfills it here through setActiveCdpPort, so status/UI
// report the port that is actually listening. Chromium's application-wide remote-debugging-port
// switch, its 9230-9250 reservation and the ~/.aionui-cdp-registry.json registry are gone.
//
// Configuration file: userData/cdp.config.json
// - enabled: boolean - whether agent browser control is enabled (default: on)
// - port: number - legacy preferred-port field, retained for config compatibility
//
// Override via AIONUI_CDP_PORT env variable. Set to "0" or "false" to disable.
// ---------------------------------------------------------------------------

const CDP_CONFIG_FILE = 'cdp.config.json';

/** CDP configuration stored in userData directory */
export interface CdpConfig {
  /** Whether CDP is enabled (default: true in dev mode, false in production) */
  enabled?: boolean;
  /**
   * 历史字段：以前用来挑保留端口。通道改用 listen(0) 之后不再读它，
   * 但保留在类型里，这样老配置文件不会因为多一个未知键而出问题。
   *
   * Legacy field that used to pick a reserved port. Unread since the bridge moved to
   * listen(0), but kept in the type so existing config files do not trip over an
   * unrecognised key.
   */
  port?: number;
}

/** CDP status information exposed to renderer */
export interface CdpStatus {
  /** Whether CDP is currently enabled */
  enabled: boolean;
  /** Current CDP port (null if disabled or not started) */
  port: number | null;
  /** Whether CDP was enabled at startup (requires restart to change) */
  startupEnabled: boolean;
  /** Whether CDP is enabled in the persisted config file (may differ from runtime) */
  configEnabled: boolean;
  /** Whether the app is running in development mode */
  isDevMode: boolean;
}

/**
 * 顺手删掉遗留的实例注册表文件。
 *
 * 这个文件（~/.aionui-cdp-registry.json）以前记录「每个实例占了哪个 CDP 端口」。相关逻辑
 * 已随应用级 remote-debugging-port 一起删除，但升级上来的机器上文件还在，里面是一堆早已
 * 无效的 pid/端口。留着只会让人以为还有这套机制，所以清掉。best-effort，失败无所谓。
 *
 * Remove the leftover instance-registry file. ~/.aionui-cdp-registry.json used to record
 * which CDP port each instance had taken; that logic went away with the application-wide
 * remote-debugging-port switch, but upgraded machines still have the file sitting there full
 * of long-dead pids and ports. Leaving it implies the mechanism still exists, so clean it up.
 * Best-effort: failure is harmless.
 */
function removeLegacyCdpRegistryFile(): void {
  try {
    const legacyRegistry = path.join(os.homedir(), '.aionui-cdp-registry.json');
    if (fs.existsSync(legacyRegistry)) {
      fs.unlinkSync(legacyRegistry);
    }
  } catch {
    // Nothing depends on this succeeding.
  }
}

/**
 * Load CDP configuration from userData directory.
 * This must be called before app.ready, so we use synchronous file operations.
 */
function loadCdpConfig(): CdpConfig {
  try {
    // Try to get userData path - this works even before app.ready
    const userDataPath = app.getPath('userData');
    const configPath = path.join(userDataPath, CDP_CONFIG_FILE);

    if (!fs.existsSync(configPath)) {
      return {};
    }

    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object') {
      return parsed as CdpConfig;
    }
  } catch {
    // Ignore errors when loading config
  }
  return {};
}

/**
 * Save CDP configuration to userData directory.
 */
export function saveCdpConfig(config: CdpConfig): void {
  try {
    const userDataPath = app.getPath('userData');
    const configPath = path.join(userDataPath, CDP_CONFIG_FILE);
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf-8');
  } catch (error) {
    console.warn('[CDP] Failed to save CDP config:', error);
  }
}

/**
 * Determine if CDP should be enabled at startup.
 * Priority: env variable > config file > default (enabled).
 *
 * 默认开启（含正式版）：应用内浏览器要让 Agent 操作，就必须有这条通道，否则
 * 「装好即可用」不成立。通道只绑 127.0.0.1，不对外暴露；用户仍可在设置里关掉，
 * 关掉后 Agent 就无法操作浏览器（此时 MCP 启动器会拒绝启动，不会偷偷开一个
 * 用户看不见的 Chrome）。
 *
 * AIONUI_CDP_PORT 现在只当开关用（"0"/"false" 关闭，其它非空值开启）。它的数值不再
 * 决定端口 —— 通道走 listen(0)，端口由系统分配。名字保留是为了不破坏既有脚本和 E2E 夹具。
 *
 * Enabled by default, production included: the in-app browser cannot be driven by the agent
 * without this bridge, so "works out of the box" would otherwise fail. The bridge binds to
 * 127.0.0.1 only and is never externally reachable. Users can still turn it off in settings,
 * after which the agent simply cannot drive the browser (the MCP launcher refuses to start
 * rather than quietly opening a Chrome the user cannot see).
 *
 * AIONUI_CDP_PORT now acts purely as a switch ("0"/"false" disables, any other non-empty
 * value enables). Its numeric value no longer selects a port — the bridge uses listen(0) and
 * the OS assigns one. The name is kept so existing scripts and E2E fixtures keep working.
 */
function shouldEnableCdp(config: CdpConfig): boolean {
  const envVal = process.env.AIONUI_CDP_PORT;
  if (envVal === '0' || envVal === 'false') return false;
  if (envVal) return true;

  if (config.enabled !== undefined) {
    return config.enabled;
  }

  return true;
}

/** The relay's real listening port, backfilled once it starts; null while agent control is off or down. */
export let cdpPort: number | null = null;

/** Called once the agent relay is listening, so status/UI report the reachable port. */
export function setActiveCdpPort(port: number | null): void {
  cdpPort = port;
}

/** Whether CDP was enabled at startup (requires restart to change). */
export let cdpStartupEnabled: boolean = false;

// Load config and initialize CDP at startup
const cdpConfig = loadCdpConfig();
cdpStartupEnabled = shouldEnableCdp(cdpConfig);

if (cdpStartupEnabled) {
  // Deliberately no appendSwitch('remote-debugging-port'): it exposes every WebContents, the main
  // window included, without authentication. The token-guarded relay exposes browser tabs only.
  console.log('[CDP] Agent browser control enabled (agent relay)');
} else {
  console.log('[CDP] Agent browser control disabled');
}

// 无论开关状态如何都清一次：关掉这个能力的用户同样不该留着那个失效文件。
// Runs regardless of the switch: users who turned the capability off should not be left
// with the stale file either.
removeLegacyCdpRegistryFile();

/**
 * Get current CDP status for display in UI.
 */
export function getCdpStatus(): CdpStatus {
  const config = loadCdpConfig();
  return {
    /**
     * enabled 表示「通道真的起来了、连得上」，所以看 cdpPort 而不是配置：
     * 配置开着但桥启动失败时，UI 不该说它是启用的。
     *
     * `enabled` means the bridge is actually up and reachable, so it reads cdpPort rather
     * than the config: with the setting on but bridge startup failed, the UI must not claim
     * the capability is active.
     */
    enabled: cdpPort !== null,
    port: cdpPort,
    startupEnabled: cdpStartupEnabled,
    configEnabled: config.enabled ?? cdpStartupEnabled,
    isDevMode: !app.isPackaged,
  };
}

/**
 * Update CDP configuration and save to disk.
 * Note: Changing the enabled state requires app restart to take effect.
 */
export function updateCdpConfig(newConfig: Partial<CdpConfig>): CdpConfig {
  const currentConfig = loadCdpConfig();
  const updatedConfig = { ...currentConfig, ...newConfig };
  saveCdpConfig(updatedConfig);
  return updatedConfig;
}
