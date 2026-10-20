/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { app } from 'electron';
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { networkInterfaces } from 'os';
import { ipcBridge } from '@/common';
import { getSystemDir } from './initStorage';
import { httpRequest } from '@/common/adapter/httpBridge';
import { startWebHost, type BrowserViewRoutes, type WebHostHandle } from '@aionui/web-host';
import { getBrowserViewService } from '@process/services/agentBrowser/services';
import { getDataPath } from './utils';
import { cloudflaredPlatformKey, ensureCloudflared, extractTgz } from '@process/webuiTunnel/cloudflaredBinary';
import { createTunnelManager } from '@process/webuiTunnel/tunnelManager';

const WEBUI_CONFIG_FILE = 'webui.config.json';
const DESKTOP_WEBUI_ENABLED_KEY = 'webui.desktop.enabled';
const DESKTOP_WEBUI_ALLOW_REMOTE_KEY = 'webui.desktop.allowRemote';
const DESKTOP_WEBUI_PORT_KEY = 'webui.desktop.port';
const DESKTOP_WEBUI_SESSIONS_NOT_BEFORE_KEY = 'webui.desktop.sessionsNotBefore';
const DESKTOP_WEBUI_TUNNEL_ENABLED_KEY = 'webui.desktop.tunnelEnabled';

/**
 * Read WebUI preferences from the backend's /api/settings/client store.
 *
 * Historical note: this used to read from `ProcessConfig` (a local JSON file).
 * The renderer's `configService` was migrated to the backend HTTP store, but
 * this main-process path was not, so `webui.desktop.enabled` that the user
 * toggled via Settings was only ever persisted to SQLite — the next launch's
 * auto-restore always read `undefined` from the local file and did nothing,
 * yet the Settings page still showed the Switch as "on" (reading the SQLite
 * value), so users clicked the saved URL and got ERR_CONNECTION_REFUSED.
 */
async function readWebUIDesktopPreferences(): Promise<{
  enabled: boolean;
  allowRemote: boolean;
  port: number | undefined;
  tunnelEnabled: boolean;
}> {
  try {
    const settings = await httpRequest<Record<string, unknown>>('GET', '/api/settings/client');
    const enabled = settings?.[DESKTOP_WEBUI_ENABLED_KEY] === true;
    const allowRemote = settings?.[DESKTOP_WEBUI_ALLOW_REMOTE_KEY] === true;
    const rawPort = settings?.[DESKTOP_WEBUI_PORT_KEY];
    const port = typeof rawPort === 'number' && rawPort > 0 ? rawPort : undefined;
    const tunnelEnabled = settings?.[DESKTOP_WEBUI_TUNNEL_ENABLED_KEY] === true;
    return { enabled, allowRemote, port, tunnelEnabled };
  } catch (error) {
    console.error('[WebUI] Failed to read preferences from backend:', error);
    return { enabled: false, allowRemote: false, port: undefined, tunnelEnabled: false };
  }
}

async function writeWebUIDesktopEnabled(enabled: boolean): Promise<void> {
  try {
    await httpRequest<void>('PUT', '/api/settings/client', { [DESKTOP_WEBUI_ENABLED_KEY]: enabled });
  } catch (error) {
    console.error('[WebUI] Failed to reconcile webui.desktop.enabled on backend:', error);
  }
}

const retryOnce = async <T>(run: () => Promise<T>): Promise<T> => {
  try {
    return await run();
  } catch {
    return run();
  }
};

let tunnelEnabledSaves: Promise<void> = Promise.resolve();

/**
 * Saves whether the secure link should run (and auto-start at boot). Saves run one after another, so the last
 * requested value is the one that lands. One retry; a second failure is logged.
 */
export function writeTunnelEnabled(enabled: boolean): Promise<void> {
  tunnelEnabledSaves = tunnelEnabledSaves.then(async () => {
    try {
      await retryOnce(() =>
        httpRequest<void>('PUT', '/api/settings/client', { [DESKTOP_WEBUI_TUNNEL_ENABLED_KEY]: enabled })
      );
    } catch (error) {
      console.error('[WebUI] Failed to save tunnelEnabled on backend:', error);
    }
  });
  return tunnelEnabledSaves;
}

/**
 * Epoch ms before which WebUI sessions are refused; null when never set or unreadable (logged).
 * A failed read never lowers the value: startDesktopWebUI also applies `knownSessionsNotBefore`.
 */
async function readSessionsNotBefore(): Promise<number | null> {
  try {
    const settings = await retryOnce(() => httpRequest<Record<string, unknown>>('GET', '/api/settings/client'));
    const value = settings?.[DESKTOP_WEBUI_SESSIONS_NOT_BEFORE_KEY];
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  } catch (error) {
    console.error('[WebUI] Failed to read sessionsNotBefore from backend:', error);
    return null;
  }
}

export type WebUIUserConfig = {
  port?: number | string;
  allowRemote?: boolean;
  // Legacy fields, retired in favor of SQLite users table. Present only when
  // reading an older webui.config.json; stripped on every rewrite.
  passwordHash?: string;
  passwordUpdatedAt?: string;
  adminUsername?: string;
};

export const parsePortValue = (value: unknown): number | null => {
  if (value === undefined || value === null || value === '') {
    return null;
  }

  const portNumber = typeof value === 'number' ? value : parseInt(String(value), 10);
  if (!Number.isFinite(portNumber) || portNumber < 1 || portNumber > 65535) {
    return null;
  }
  return portNumber;
};

export const parseBooleanEnv = (value?: string): boolean | null => {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
  return null;
};

export const loadUserWebUIConfig = (): { config: WebUIUserConfig; path: string | null; exists: boolean } => {
  try {
    const userDataPath = app.getPath('userData');
    const configPath = path.join(userDataPath, WEBUI_CONFIG_FILE);
    if (!fs.existsSync(configPath)) {
      return { config: {}, path: configPath, exists: false };
    }

    const raw = fs.readFileSync(configPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return { config: {}, path: configPath, exists: false };
    }
    return { config: parsed as WebUIUserConfig, path: configPath, exists: true };
  } catch {
    return { config: {}, path: null, exists: false };
  }
};

/**
 * Atomic write of webui.config.json into the Electron userData dir.
 * Drops legacy password fields (passwordHash / passwordUpdatedAt); the SQLite
 * users table is now the single source of truth for credentials.
 * Write-to-tmp-then-rename prevents corruption if the process is killed mid-write.
 */
export const saveUserWebUIConfig = async (config: WebUIUserConfig): Promise<void> => {
  const userDataPath = app.getPath('userData');
  const configPath = path.join(userDataPath, WEBUI_CONFIG_FILE);
  const tmpPath = `${configPath}.tmp`;

  const sanitized: WebUIUserConfig = {};
  if (config.port !== undefined) sanitized.port = config.port;
  if (config.allowRemote !== undefined) sanitized.allowRemote = config.allowRemote;
  if (config.adminUsername !== undefined) sanitized.adminUsername = config.adminUsername;

  await fs.promises.mkdir(userDataPath, { recursive: true });
  const payload = JSON.stringify(sanitized, null, 2) + '\n';
  await fs.promises.writeFile(tmpPath, payload, { encoding: 'utf-8', mode: 0o600 });
  await fs.promises.rename(tmpPath, configPath);
};

// Keep aligned with renderer's WEBUI_DEFAULT_PORT (common/config/constants.ts):
//   production -> 25808, dev -> 25809, multi-instance dev -> 25810
const DEFAULT_WEBUI_PORT = (() => {
  if (process.env.NODE_ENV === 'production') return 25808;
  if (process.env.AIONUI_MULTI_INSTANCE === '1') return 25810;
  return 25809;
})();

export const resolveWebUIPort = (
  config: WebUIUserConfig,
  getSwitchValue: (flag: string) => string | undefined
): number => {
  const cliPort = parsePortValue(getSwitchValue('port') ?? getSwitchValue('webui-port'));
  if (cliPort) return cliPort;

  const envPort = parsePortValue(process.env.AIONUI_PORT ?? process.env.PORT);
  if (envPort) return envPort;

  const configPort = parsePortValue(config.port);
  if (configPort) return configPort;

  return DEFAULT_WEBUI_PORT;
};

export const resolveRemoteAccess = (config: WebUIUserConfig, isRemoteMode: boolean): boolean => {
  const envRemote = parseBooleanEnv(process.env.AIONUI_ALLOW_REMOTE || process.env.AIONUI_REMOTE);
  const hostHint = process.env.AIONUI_HOST?.trim();
  const hostRequestsRemote = hostHint ? ['0.0.0.0', '::', '::0'].includes(hostHint) : false;
  const configRemote = config.allowRemote === true;

  return isRemoteMode || hostRequestsRemote || envRemote === true || configRemote;
};

// ---------------------------------------------------------------------------
// Desktop-managed WebUI lifecycle
// ---------------------------------------------------------------------------

export type DesktopWebUIHandle = {
  port: number;
  allowRemote: boolean;
  localUrl: string;
  networkUrl?: string;
  lanIP?: string;
  initialPassword?: string;
};

let currentHandle: (WebHostHandle & { allowRemote: boolean }) | null = null;
// The latest not-before this process has applied or revoked with; survives restarts and failed reads.
let knownSessionsNotBefore: number | null = null;
const laterNotBefore = (a: number | null, b: number | null): number | null => Math.max(a ?? 0, b ?? 0) || null;
// First-use plaintext password for the active handle. Set by webui.start IPC
// handler before startDesktopWebUI() when the backend reports needs_setup=true,
// so Settings can display the generated password exactly once. Cleared on stop.
let currentInitialPassword: string | undefined;

/** The secure link (Cloudflare quick tunnel) to the running WebUI; cloudflared lives in `<data dir>/bin`. */
export const webuiTunnel = createTunnelManager({
  ensureBinary: (onDownload) =>
    ensureCloudflared({
      binDir: path.join(getDataPath(), 'bin'),
      platformKey: cloudflaredPlatformKey(),
      fetch,
      fs: fs.promises,
      extractTgz,
      onDownload,
    }),
  spawn: (cmd, args) => spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }),
  getWebuiPort: () => currentHandle?.port ?? null,
  emit: (status) => ipcBridge.webui.tunnel.statusChanged.emit(status),
});

/**
 * Stash the plaintext password to surface on the next `getDesktopWebUIStatus()`
 * or IPC start response. Call with `undefined` to clear.
 */
export function setDesktopWebUIInitialPassword(password: string | undefined): void {
  currentInitialPassword = password;
}

const getLanIP = (): string | null => {
  const nets = networkInterfaces();
  for (const name of Object.keys(nets)) {
    const netInfo = nets[name];
    if (!netInfo) continue;
    for (const net of netInfo) {
      const isIPv4 = net.family === 'IPv4' || (net.family as unknown) === 4;
      if (isIPv4 && !net.internal) return net.address;
    }
  }
  return null;
};

const toDesktopHandle = (handle: WebHostHandle, allowRemote: boolean): DesktopWebUIHandle => ({
  port: handle.port,
  allowRemote,
  localUrl: handle.localUrl,
  networkUrl: handle.networkUrl,
  lanIP: handle.lanIP,
  initialPassword: currentInitialPassword,
});

/**
 * Sign out every other WebUI device: sessions issued before `now` are refused by the running
 * web host at once, and the value is saved so the next WebUI start applies it too. The push
 * happens first, so a save failure (which rejects) never leaves old sessions alive.
 */
export async function revokeOtherWebUISessions(now: number = Date.now()): Promise<void> {
  knownSessionsNotBefore = laterNotBefore(knownSessionsNotBefore, now);
  currentHandle?.setSessionsNotBefore(knownSessionsNotBefore);
  // One retry; a second failure rejects so the UI can warn.
  await retryOnce(() =>
    httpRequest<void>('PUT', '/api/settings/client', { [DESKTOP_WEBUI_SESSIONS_NOT_BEFORE_KEY]: now })
  );
}

/** The live browser view, looked up at each call: it is null while agent browser control is off. */
const browserView: BrowserViewRoutes = {
  listTabs: (conversationId) => getBrowserViewService()?.listTabs(conversationId) ?? [],
  openStream: async (tabId, peer) =>
    (await getBrowserViewService()?.openStream(tabId, peer)) ?? { error: 'not-allowed' },
};

/**
 * Spawn a WebUI instance (static server + backend) and remember the handle so
 * callers can later stop it or query its status.
 *
 * Shared by the boot-time auto-restore path and the interactive
 * Settings → "Enable WebUI" IPC handler.
 */
export async function startDesktopWebUI(opts: { port?: number; allowRemote?: boolean }): Promise<DesktopWebUIHandle> {
  // If already running, tear down first so we honour the new port / allowRemote. The secure link
  // stays on and follows the new port (onWebuiRestarted below).
  if (currentHandle) {
    await stopWebHost();
  }

  const allowRemote = opts.allowRemote === true;
  const preferredPort = parsePortValue(opts.port) ?? DEFAULT_WEBUI_PORT;
  const sysDir = getSystemDir();

  // Reuse the backend already spawned by backendManager.start() in src/index.ts.
  // Spawning a second backend here would race the first on the same SQLite file.
  const backendPort = (globalThis as typeof globalThis & { __backendPort?: number }).__backendPort;
  if (!backendPort) {
    throw new Error('[WebUI] Cannot start: aioncore is not running (globalThis.__backendPort unset)');
  }

  const sessionsNotBefore = laterNotBefore(await readSessionsNotBefore(), knownSessionsNotBefore);
  knownSessionsNotBefore = sessionsNotBefore;

  const handle = await startWebHost({
    app: {
      version: app.getVersion(),
      isPackaged: app.isPackaged,
      resourcesPath: app.getAppPath(),
      // webui.config.json must live next to the backend SQLite DB so --resetpass
      // CLI and the runtime settings path read/write the same user record.
      // getDataPath() returns ~/.aionui[-dev] symlink on macOS to sidestep
      // path-with-spaces issues under Application Support.
      userDataPath: getDataPath(),
    },
    // After bundling, this file is out/main/index.js — renderer assets live at ../renderer.
    staticDir: path.join(__dirname, '../renderer'),
    port: preferredPort,
    allowRemote,
    sessionsNotBefore,
    isTunnelActive: () => webuiTunnel.isActive(),
    localRoutes: { browserView },
    // Must align with the desktop IPC path's backend dataDir (src/index.ts), otherwise
    // users see divergent SQLite state between desktop app and bundled WebUI.
    dataDir: getDataPath(),
    logDir: sysDir.logDir,
    dirs: {
      cacheDir: sysDir.cacheDir,
      workDir: sysDir.workDir,
      logDir: sysDir.logDir,
    },
    backend: {
      kind: 'useExistingBackend',
      port: backendPort,
    },
  }).catch(async (error: unknown) => {
    // A restart that fails leaves no WebUI, so the secure link goes too.
    await stopWebUITunnel();
    throw error;
  });

  currentHandle = Object.assign(handle, { allowRemote });
  // A sign-out while the host was starting reached no handle; apply it now.
  if (knownSessionsNotBefore !== sessionsNotBefore) handle.setSessionsNotBefore(knownSessionsNotBefore);
  webuiTunnel.onWebuiRestarted();
  return toDesktopHandle(handle, allowRemote);
}

/**
 * Turn the WebUI off, if running. The secure link needs it, so it is stopped and saved off too.
 */
export async function stopDesktopWebUI(): Promise<void> {
  await stopWebUITunnel();
  await stopWebHost();
}

async function stopWebUITunnel(): Promise<void> {
  if (webuiTunnel.status().state === 'stopped') return;
  await webuiTunnel.stop();
  await writeTunnelEnabled(false);
}

async function stopWebHost(): Promise<void> {
  const handle = currentHandle;
  if (!handle) return;
  currentHandle = null;
  currentInitialPassword = undefined;
  try {
    await handle.stop();
  } catch (err) {
    console.error('[WebUI] stop error:', err);
  }
}

/**
 * Snapshot of the currently running WebUI. Returns a stopped-state descriptor
 * when nothing is running, so callers don't need to branch on null.
 */
export function getDesktopWebUIStatus(): {
  running: boolean;
  port: number;
  allowRemote: boolean;
  localUrl: string;
  networkUrl?: string;
  lanIP?: string;
  initialPassword?: string;
} {
  if (!currentHandle) {
    const lanIP = getLanIP();
    return {
      running: false,
      port: DEFAULT_WEBUI_PORT,
      allowRemote: false,
      localUrl: `http://localhost:${DEFAULT_WEBUI_PORT}`,
      lanIP: lanIP ?? undefined,
    };
  }
  return {
    running: true,
    port: currentHandle.port,
    allowRemote: currentHandle.allowRemote,
    localUrl: currentHandle.localUrl,
    networkUrl: currentHandle.networkUrl,
    lanIP: currentHandle.lanIP,
    initialPassword: currentInitialPassword,
  };
}

export const restoreDesktopWebUIFromPreferences = async (): Promise<void> => {
  const { enabled, allowRemote, port, tunnelEnabled } = await readWebUIDesktopPreferences();
  if (!enabled) return;

  const preferredPort = port ?? DEFAULT_WEBUI_PORT;

  try {
    const handle = await startDesktopWebUI({ port: preferredPort, allowRemote });
    console.log(
      `[WebUI] Auto-restored from desktop preferences (port=${handle.port}, allowRemote=${handle.allowRemote})`
    );
    if (tunnelEnabled) {
      webuiTunnel
        .start({ retryOnFailure: true })
        .catch((error) => console.error('[WebUI] Failed to auto-start the secure link:', error));
    }
  } catch (error) {
    // Reconcile the persisted preference with reality. Leaving enabled=true
    // means every subsequent launch will silently re-fail the same way, and
    // the Settings page's Switch would render "on" against an empty 25808.
    console.error('[WebUI] Failed to auto-restore from desktop preferences:', error);
    await writeWebUIDesktopEnabled(false);
  }
};
