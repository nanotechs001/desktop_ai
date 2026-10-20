/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'webui.desktop.tunnelEnabled';
const startWebHost = vi.fn();
const httpRequest = vi.fn();
const hostStop = vi.fn(async () => {});
let tunnelState = 'stopped';
const tunnel = {
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  isActive: vi.fn(() => tunnelState === 'running'),
  status: vi.fn(() => ({ state: tunnelState })),
  onWebuiRestarted: vi.fn(),
};
let managerDeps: { getWebuiPort: () => number | null } | undefined;
let browserViewService: { listTabs: ReturnType<typeof vi.fn>; openStream: ReturnType<typeof vi.fn> } | null = null;

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', isPackaged: false, getAppPath: () => '/app', getPath: () => '/tmp' },
}));
vi.mock('@aionui/web-host', () => ({ startWebHost: (...args: unknown[]) => startWebHost(...args) }));
vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: (...args: unknown[]) => httpRequest(...args) }));
vi.mock('@/common', () => ({ ipcBridge: { webui: { tunnel: { statusChanged: { emit: vi.fn() } } } } }));
vi.mock('@process/utils/initStorage', () => ({
  getSystemDir: () => ({ logDir: '/l', cacheDir: '/c', workDir: '/w' }),
}));
vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/data' }));
vi.mock('@process/webuiTunnel/tunnelManager', () => ({
  createTunnelManager: (deps: typeof managerDeps) => {
    managerDeps = deps;
    return tunnel;
  },
}));

vi.mock('@process/services/agentBrowser/services', () => ({ getBrowserViewService: () => browserViewService }));

const importModule = () => import('@process/utils/webuiConfig');
const puts = () => httpRequest.mock.calls.filter(([method]) => method === 'PUT').map(([, , body]) => body);

describe('WebUI secure link wiring', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    tunnelState = 'stopped';
    (globalThis as { __backendPort?: number }).__backendPort = 4242;
    startWebHost.mockImplementation(async (opts: { port: number }) => ({
      port: opts.port,
      localUrl: `http://127.0.0.1:${opts.port}`,
      stop: hostStop,
      setSessionsNotBefore: vi.fn(),
    }));
    httpRequest.mockResolvedValue({});
  });

  afterEach(() => {
    delete (globalThis as { __backendPort?: number }).__backendPort;
  });

  it('passes isTunnelActive to the web host, following the manager', async () => {
    const { startDesktopWebUI } = await importModule();
    await startDesktopWebUI({ port: 25809 });
    const { isTunnelActive } = startWebHost.mock.calls[0][0] as { isTunnelActive: () => boolean };
    expect(isTunnelActive()).toBe(false);
    tunnelState = 'running';
    expect(isTunnelActive()).toBe(true);
  });

  it('passes the browser view to the web host, following agent browser control at each call', async () => {
    browserViewService = null;
    const { startDesktopWebUI } = await importModule();
    await startDesktopWebUI({ port: 25809 });
    type Routes = {
      listTabs: (conversationId: string) => unknown[];
      openStream: (tabId: string, peer: unknown) => Promise<unknown>;
    };
    const { localRoutes } = startWebHost.mock.calls[0][0] as { localRoutes: { browserView: Routes } };
    const peer = { sendBinary: vi.fn(), sendText: vi.fn(), close: vi.fn() };
    expect(localRoutes.browserView.listTabs('c1')).toEqual([]);
    await expect(localRoutes.browserView.openStream('wc-1', peer)).resolves.toEqual({ error: 'not-allowed' });

    const handle = { onMessage: vi.fn(), close: vi.fn() };
    browserViewService = { listTabs: vi.fn(() => [{ id: 'wc-1' }]), openStream: vi.fn(async () => handle) };
    expect(localRoutes.browserView.listTabs('c1')).toEqual([{ id: 'wc-1' }]);
    expect(browserViewService.listTabs).toHaveBeenCalledWith('c1');
    await expect(localRoutes.browserView.openStream('wc-1', peer)).resolves.toBe(handle);
    expect(browserViewService.openStream).toHaveBeenCalledWith('wc-1', peer);
    browserViewService = null;
  });

  it('gives the manager the running WebUI port, or null when it is off', async () => {
    const { startDesktopWebUI, stopDesktopWebUI } = await importModule();
    expect(managerDeps?.getWebuiPort()).toBeNull();
    await startDesktopWebUI({ port: 25811 });
    expect(managerDeps?.getWebuiPort()).toBe(25811);
    await stopDesktopWebUI();
    expect(managerDeps?.getWebuiPort()).toBeNull();
  });

  it('tells the manager when the WebUI restarts, without stopping the link', async () => {
    const { startDesktopWebUI } = await importModule();
    await startDesktopWebUI({ port: 25809 });
    await startDesktopWebUI({ port: 25810 });
    expect(tunnel.onWebuiRestarted).toHaveBeenCalledTimes(2);
    expect(tunnel.stop).not.toHaveBeenCalled();
  });

  it('turning the WebUI off stops the link and saves it off', async () => {
    const { startDesktopWebUI, stopDesktopWebUI } = await importModule();
    await startDesktopWebUI({ port: 25809 });
    tunnelState = 'running';
    await stopDesktopWebUI();
    expect(tunnel.stop).toHaveBeenCalled();
    expect(puts()).toContainEqual({ [KEY]: false });
  });

  it('a WebUI restart that fails stops the link and saves it off', async () => {
    const { startDesktopWebUI } = await importModule();
    await startDesktopWebUI({ port: 25809 });
    tunnelState = 'running';
    startWebHost.mockRejectedValueOnce(new Error('port in use'));
    await expect(startDesktopWebUI({ port: 25810 })).rejects.toThrow('port in use');
    expect(tunnel.stop).toHaveBeenCalled();
    expect(puts()).toContainEqual({ [KEY]: false });
  });

  it('turning the WebUI off with the link already off saves nothing for it', async () => {
    const { startDesktopWebUI, stopDesktopWebUI } = await importModule();
    await startDesktopWebUI({ port: 25809 });
    await stopDesktopWebUI();
    expect(puts()).not.toContainEqual({ [KEY]: false });
  });

  it('starts the link at boot when the WebUI and the link are both enabled', async () => {
    httpRequest.mockImplementation(async (method: string) =>
      method === 'GET' ? { 'webui.desktop.enabled': true, [KEY]: true } : {}
    );
    const { restoreDesktopWebUIFromPreferences } = await importModule();
    await restoreDesktopWebUIFromPreferences();
    expect(tunnel.start).toHaveBeenCalledWith({ retryOnFailure: true });
  });

  it.each([[{ 'webui.desktop.enabled': true }], [{ 'webui.desktop.enabled': false, [KEY]: true }]])(
    'does not start the link at boot for %o',
    async (settings) => {
      httpRequest.mockImplementation(async (method: string) => (method === 'GET' ? settings : {}));
      const { restoreDesktopWebUIFromPreferences } = await importModule();
      await restoreDesktopWebUIFromPreferences();
      expect(tunnel.start).not.toHaveBeenCalled();
    }
  );

  it('writeTunnelEnabled saves in call order, so the last requested value lands', async () => {
    let stored: unknown;
    let releaseTrue = () => {};
    httpRequest.mockImplementation(async (method: string, _url: string, body: Record<string, unknown>) => {
      if (method !== 'PUT') return {};
      if (body[KEY] === true) await new Promise<void>((resolve) => (releaseTrue = resolve));
      stored = body[KEY];
      return {};
    });
    const { writeTunnelEnabled } = await importModule();
    const saveTrue = writeTunnelEnabled(true);
    const saveFalse = writeTunnelEnabled(false);
    await vi.waitFor(() => expect(puts()).toHaveLength(1));
    releaseTrue();
    await Promise.all([saveTrue, saveFalse]);
    expect(stored).toBe(false);
  });

  it('writeTunnelEnabled retries once, then logs instead of throwing', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    httpRequest.mockRejectedValue(new Error('down'));
    const { writeTunnelEnabled } = await importModule();
    await expect(writeTunnelEnabled(true)).resolves.toBeUndefined();
    expect(puts()).toEqual([{ [KEY]: true }, { [KEY]: true }]);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});
