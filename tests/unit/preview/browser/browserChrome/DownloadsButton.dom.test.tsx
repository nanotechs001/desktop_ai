/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadItem } from '@/common/types/browser';

const mocks = vi.hoisted(() => ({
  getDownloads: vi.fn(),
  openDownload: vi.fn(() => Promise.resolve({ success: true })),
  showDownloadInFolder: vi.fn(() => Promise.resolve({ success: true })),
  cancelDownload: vi.fn(() => Promise.resolve({ success: true })),
  handler: null as ((items: DownloadItem[]) => void) | null,
  unsubscribe: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    browser: {
      getDownloads: { invoke: mocks.getDownloads },
      openDownload: { invoke: mocks.openDownload },
      showDownloadInFolder: { invoke: mocks.showDownloadInFolder },
      cancelDownload: { invoke: mocks.cancelDownload },
      downloadsChanged: {
        on: (handler: (items: DownloadItem[]) => void) => {
          mocks.handler = handler;
          return mocks.unsubscribe;
        },
      },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import DownloadsButton from '@/renderer/pages/conversation/Preview/browser/BrowserChrome/DownloadsButton';

const item = (id: string, patch: Partial<DownloadItem> = {}): DownloadItem => ({
  id,
  url: `https://a.test/${id}`,
  filename: `${id}.zip`,
  savePath: `/dl/${id}.zip`,
  state: 'completed',
  receivedBytes: 100,
  totalBytes: 100,
  ...patch,
});

const KEY = 'preview.browserChrome.downloads';

const openMenu = async (items: DownloadItem[]) => {
  mocks.getDownloads.mockResolvedValue({ success: true, data: items });
  const view = render(<DownloadsButton />);
  await act(async () => {});
  fireEvent.click(view.container.querySelector('button') as HTMLElement);
  return view;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.handler = null;
});

afterEach(cleanup);

describe('DownloadsButton', () => {
  it('shows the empty state when there are no downloads', async () => {
    await openMenu([]);
    expect(await screen.findByText(`${KEY}.empty`)).toBeTruthy();
  });

  it('shows a progress percentage for progressing items and Open / Show in folder for completed ones', async () => {
    await openMenu([item('busy', { state: 'progressing', receivedBytes: 50, totalBytes: 100 }), item('done')]);
    expect(await screen.findByText('50%')).toBeTruthy();
    fireEvent.click(screen.getByText(`${KEY}.open`));
    expect(mocks.openDownload).toHaveBeenCalledWith({ id: 'done' });
    fireEvent.click(screen.getByText(`${KEY}.showInFolder`));
    expect(mocks.showDownloadInFolder).toHaveBeenCalledWith({ id: 'done' });
  });

  it('Cancel calls cancelDownload with the item id', async () => {
    await openMenu([item('busy', { state: 'progressing', receivedBytes: 10 })]);
    fireEvent.click(await screen.findByText(`${KEY}.cancel`));
    expect(mocks.cancelDownload).toHaveBeenCalledWith({ id: 'busy' });
  });

  it('marks interrupted downloads as failed', async () => {
    await openMenu([item('bad', { state: 'interrupted' })]);
    expect(await screen.findByText(`${KEY}.failed`)).toBeTruthy();
  });

  it('applies downloadsChanged events and unsubscribes on unmount', async () => {
    const view = await openMenu([]);
    act(() => mocks.handler?.([item('new')]));
    expect(await screen.findByText('new.zip')).toBeTruthy();
    view.unmount();
    expect(mocks.unsubscribe).toHaveBeenCalled();
  });
});
