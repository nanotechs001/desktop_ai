/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Provider = (params: unknown) => Promise<{ success: boolean; msg?: string }>;

const mocks = vi.hoisted(() => {
  const providers = new Map<string, (params: unknown) => Promise<{ success: boolean; msg?: string }>>();
  return {
    providers,
    provider: (name: string) => ({
      provider: (fn: (params: unknown) => Promise<{ success: boolean; msg?: string }>) => {
        providers.set(name, fn);
      },
    }),
    openDownload: vi.fn(() => Promise.resolve({ success: true })),
    showDownloadInFolder: vi.fn(() => ({ success: true })),
    cancelDownload: vi.fn(() => ({ success: true })),
    replyPermission: vi.fn(() => true),
  };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    browser: {
      getDownloads: mocks.provider('getDownloads'),
      openDownload: mocks.provider('openDownload'),
      showDownloadInFolder: mocks.provider('showDownloadInFolder'),
      cancelDownload: mocks.provider('cancelDownload'),
      getPermissionRequests: mocks.provider('getPermissionRequests'),
      replyPermission: mocks.provider('replyPermission'),
    },
  },
}));
vi.mock('@process/services/browserSession/downloads', () => ({
  getDownloads: () => [],
  openDownload: mocks.openDownload,
  showDownloadInFolder: mocks.showDownloadInFolder,
  cancelDownload: mocks.cancelDownload,
}));
vi.mock('@process/services/browserSession/permissions', () => ({
  getPermissionRequests: () => [],
  replyPermission: mocks.replyPermission,
}));

import { initBrowserBridge } from '@process/bridge/browserBridge';

const call = (name: string, params: unknown) => (mocks.providers.get(name) as Provider)(params);

beforeEach(() => {
  vi.clearAllMocks();
  mocks.providers.clear();
  initBrowserBridge();
});

describe('initBrowserBridge input validation', () => {
  it.each(['openDownload', 'showDownloadInFolder', 'cancelDownload', 'replyPermission'])(
    '%s rejects a missing or non-string id without calling through',
    async (name) => {
      for (const params of [undefined, null, {}, { id: 5 }, { id: '' }, { id: ['x'] }]) {
        await expect(call(name, params)).resolves.toMatchObject({ success: false });
      }
      expect(mocks.openDownload).not.toHaveBeenCalled();
      expect(mocks.showDownloadInFolder).not.toHaveBeenCalled();
      expect(mocks.cancelDownload).not.toHaveBeenCalled();
      expect(mocks.replyPermission).not.toHaveBeenCalled();
    }
  );

  it('passes a valid download id through', async () => {
    await expect(call('openDownload', { id: 'a' })).resolves.toEqual({ success: true });
    await call('showDownloadInFolder', { id: 'a' });
    await call('cancelDownload', { id: 'a' });

    expect(mocks.openDownload).toHaveBeenCalledWith('a');
    expect(mocks.showDownloadInFolder).toHaveBeenCalledWith('a');
    expect(mocks.cancelDownload).toHaveBeenCalledWith('a');
  });

  it('replyPermission treats only a literal true as true for allow and remember', async () => {
    await call('replyPermission', { id: 'p', allow: 'yes', remember: 1 });
    await call('replyPermission', { id: 'p', allow: true, remember: true });

    expect(mocks.replyPermission.mock.calls).toEqual([
      ['p', false, false],
      ['p', true, true],
    ]);
  });
});
