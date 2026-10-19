/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const KEY = 'webui.desktop.sessionsNotBefore';
const setSessionsNotBefore = vi.fn();
const startWebHost = vi.fn();
const httpRequest = vi.fn();

vi.mock('electron', () => ({
  app: { getVersion: () => '0.0.0', isPackaged: false, getAppPath: () => '/app', getPath: () => '/tmp' },
}));
vi.mock('@aionui/web-host', () => ({ startWebHost: (...args: unknown[]) => startWebHost(...args) }));
vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: (...args: unknown[]) => httpRequest(...args) }));
vi.mock('@process/utils/initStorage', () => ({
  getSystemDir: () => ({ logDir: '/l', cacheDir: '/c', workDir: '/w' }),
}));
vi.mock('@process/utils/utils', () => ({ getDataPath: () => '/data' }));

const importModule = () => import('@process/utils/webuiConfig');

describe('WebUI sessionsNotBefore', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    (globalThis as { __backendPort?: number }).__backendPort = 4242;
    startWebHost.mockResolvedValue({
      port: 25809,
      backendPort: 4242,
      url: 'u',
      localUrl: 'http://127.0.0.1:25809',
      stop: vi.fn(),
      setSessionsNotBefore,
    });
    httpRequest.mockResolvedValue({});
  });

  afterEach(() => {
    delete (globalThis as { __backendPort?: number }).__backendPort;
  });

  it('startup passes the persisted value to the web host', async () => {
    httpRequest.mockImplementation(async (method: string) => (method === 'GET' ? { [KEY]: 1_700_000_000_000 } : {}));
    const { startDesktopWebUI } = await importModule();
    await startDesktopWebUI({ port: 25809 });
    expect(startWebHost).toHaveBeenCalledWith(expect.objectContaining({ sessionsNotBefore: 1_700_000_000_000 }));
  });

  it.each([[undefined], ['soon'], [-5], [0]])('startup treats a persisted %s as unset', async (value) => {
    httpRequest.mockImplementation(async (method: string) => (method === 'GET' ? { [KEY]: value } : {}));
    const { startDesktopWebUI } = await importModule();
    await startDesktopWebUI({ port: 25809 });
    expect(startWebHost).toHaveBeenCalledWith(expect.objectContaining({ sessionsNotBefore: null }));
  });

  it('startup still starts, and logs, when the setting cannot be read', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    httpRequest.mockRejectedValue(new Error('boom'));
    const { startDesktopWebUI } = await importModule();
    await startDesktopWebUI({ port: 25809 });
    expect(startWebHost).toHaveBeenCalledWith(expect.objectContaining({ sessionsNotBefore: null }));
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('revokeOtherWebUISessions pushes the value to the running web host and persists it', async () => {
    const { startDesktopWebUI, revokeOtherWebUISessions } = await importModule();
    await startDesktopWebUI({ port: 25809 });
    await revokeOtherWebUISessions(1_800_000_000_000);
    expect(setSessionsNotBefore).toHaveBeenCalledWith(1_800_000_000_000);
    expect(httpRequest).toHaveBeenCalledWith('PUT', '/api/settings/client', { [KEY]: 1_800_000_000_000 });
  });

  it('revokeOtherWebUISessions persists even when the WebUI is not running', async () => {
    const { revokeOtherWebUISessions } = await importModule();
    await revokeOtherWebUISessions(1_800_000_000_000);
    expect(setSessionsNotBefore).not.toHaveBeenCalled();
    expect(httpRequest).toHaveBeenCalledWith('PUT', '/api/settings/client', { [KEY]: 1_800_000_000_000 });
  });

  it('revokeOtherWebUISessions retries the save once before giving up', async () => {
    const { startDesktopWebUI, revokeOtherWebUISessions } = await importModule();
    await startDesktopWebUI({ port: 25809 });
    httpRequest.mockClear();
    httpRequest.mockRejectedValueOnce(new Error('busy'));
    await expect(revokeOtherWebUISessions(1_800_000_000_000)).resolves.toBeUndefined();
    expect(httpRequest.mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(2);
  });

  it('revokeOtherWebUISessions still pushes to the web host, then rejects, when both saves fail', async () => {
    const { startDesktopWebUI, revokeOtherWebUISessions } = await importModule();
    await startDesktopWebUI({ port: 25809 });
    httpRequest.mockClear();
    httpRequest.mockRejectedValue(new Error('disk full'));
    await expect(revokeOtherWebUISessions(1_800_000_000_000)).rejects.toThrow('disk full');
    expect(setSessionsNotBefore).toHaveBeenCalledWith(1_800_000_000_000);
    expect(httpRequest.mock.calls.filter(([method]) => method === 'PUT')).toHaveLength(2);
  });
});
