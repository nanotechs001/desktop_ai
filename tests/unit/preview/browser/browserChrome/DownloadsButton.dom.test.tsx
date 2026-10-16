/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DownloadItem } from '@/common/types/browser';

const mocks = vi.hoisted(() => ({
  getDownloads: vi.fn(),
  openDownload: vi.fn(() => Promise.resolve({ success: true })),
  showDownloadInFolder: vi.fn(() => Promise.resolve({ success: true })),
  cancelDownload: vi.fn(() => Promise.resolve({ success: true })),
  handler: null as ((items: DownloadItem[]) => void) | null,
  unsubscribe: vi.fn(),
  messageError: vi.fn(),
}));

// Arco's imperative Message needs a legacy ReactDOM.render, which React 19 lacks in jsdom.
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...actual, Message: { ...actual.Message, error: mocks.messageError } };
});

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

  it('shows the received size instead of a 0% bar when the total is unknown', async () => {
    await openMenu([item('stream', { state: 'progressing', receivedBytes: 1258291, totalBytes: 0 })]);
    expect(await screen.findByText('1.2 MB')).toBeTruthy();
    expect(screen.queryByText('0%')).toBeNull();
  });

  it('shows an error message when an action fails', async () => {
    mocks.openDownload.mockResolvedValueOnce({ success: false });
    await openMenu([item('done')]);
    fireEvent.click(await screen.findByText(`${KEY}.open`));
    await waitFor(() => expect(mocks.messageError).toHaveBeenCalledWith(`${KEY}.actionFailed`));
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
