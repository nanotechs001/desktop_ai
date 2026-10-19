/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (payload?: unknown) => Promise<unknown>;
const handlers = new Map<string, Handler>();
const provider = (name: string) => ({ provider: (fn: Handler) => handlers.set(name, fn) });

vi.mock('@/common', () => ({
  ipcBridge: {
    webui: {
      tunnel: { getStatus: provider('getStatus'), start: provider('start'), stop: provider('stop') },
    },
  },
}));

const tunnel = {
  start: vi.fn(async () => {}),
  stop: vi.fn(async () => {}),
  status: vi.fn(() => ({ state: 'running', url: 'https://a-b.trycloudflare.com' })),
};
const writeTunnelEnabled = vi.fn(async (_enabled: boolean) => {});

vi.mock('@process/utils/webuiConfig', () => ({ webuiTunnel: tunnel, writeTunnelEnabled }));

const call = async (name: string, payload?: unknown) => {
  const { initWebuiTunnelIpc } = await import('@process/webuiTunnel/tunnelIpc');
  initWebuiTunnelIpc();
  return handlers.get(name)!(payload);
};

describe('webui.tunnel IPC', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    handlers.clear();
  });

  it('getStatus returns the manager status', async () => {
    await expect(call('getStatus')).resolves.toEqual({ state: 'running', url: 'https://a-b.trycloudflare.com' });
  });

  it('start starts the tunnel, persists it on and returns the status', async () => {
    await expect(call('start')).resolves.toEqual({
      success: true,
      status: { state: 'running', url: 'https://a-b.trycloudflare.com' },
    });
    expect(tunnel.start).toHaveBeenCalled();
    expect(writeTunnelEnabled).toHaveBeenCalledWith(true);
  });

  it('start answers code webui-off, and persists nothing, while the WebUI is off', async () => {
    const { WEBUI_OFF_MESSAGE } = await import('@process/webuiTunnel/tunnelManager');
    tunnel.start.mockRejectedValueOnce(new Error(WEBUI_OFF_MESSAGE));
    await expect(call('start')).resolves.toEqual({ success: false, code: 'webui-off' });
    expect(writeTunnelEnabled).not.toHaveBeenCalled();
  });

  it('stop stops the tunnel and persists it off', async () => {
    tunnel.status.mockReturnValueOnce({ state: 'stopped' });
    await expect(call('stop')).resolves.toEqual({ success: true, status: { state: 'stopped' } });
    expect(tunnel.stop).toHaveBeenCalled();
    expect(writeTunnelEnabled).toHaveBeenCalledWith(false);
  });

  it.each([['start'], ['stop']])('%s rejects a payload', async (name) => {
    await expect(call(name, { port: 1 })).resolves.toEqual({ success: false, code: 'invalid-args' });
    expect(tunnel.start).not.toHaveBeenCalled();
    expect(tunnel.stop).not.toHaveBeenCalled();
  });
});
