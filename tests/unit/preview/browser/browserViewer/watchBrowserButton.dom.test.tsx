/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The WebUI's way into the live browser view: a header button, shown while the conversation has a desktop tab to
 * watch, that opens the browser preview.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

type FakePreview = {
  tabs: Array<{ id: string; content_type: string }>;
  openBrowserTab: ReturnType<typeof vi.fn>;
  switchTab: ReturnType<typeof vi.fn>;
  revealBrowserFor: ReturnType<typeof vi.fn>;
};
const preview = vi.hoisted(() => ({ value: null as FakePreview | null }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => preview.value,
}));

import WatchBrowserButton from '@/renderer/components/media/browserLive/WatchBrowserButton';

const LABEL = 'preview.browser.watchBrowser';
const TAB = { id: 'wc-1', title: 'One', url: 'https://one.example/', paused: false };

let tabs: Array<typeof TAB> = [TAB];
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({ ok: true, json: async () => ({ tabs }) }));
let electronApiStub: unknown;

/** Lets the pending fetch resolve and React render it. */
const settle = () =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });

beforeEach(() => {
  vi.useFakeTimers();
  tabs = [TAB];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  const w = window as Window & { electronAPI?: unknown };
  electronApiStub = w.electronAPI;
  delete w.electronAPI;
  preview.value = { tabs: [], openBrowserTab: vi.fn(), switchTab: vi.fn(), revealBrowserFor: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  (window as Window & { electronAPI?: unknown }).electronAPI = electronApiStub;
  preview.value = null;
});

describe('WatchBrowserButton', () => {
  it('is hidden while the conversation has no tab to watch', async () => {
    tabs = [];
    render(<WatchBrowserButton conversationId='conv-1' />);
    await settle();

    expect(fetchMock).toHaveBeenCalledWith(
      '/api/browser-view/tabs?conversation=conv-1',
      expect.objectContaining({ credentials: 'include' })
    );
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull();
  });

  it('shows once a tab is listed', async () => {
    render(<WatchBrowserButton conversationId='conv-1' />);
    await settle();

    expect(screen.getByRole('button', { name: LABEL })).toBeInTheDocument();
  });

  it('is hidden in Electron, which asks for no tabs', async () => {
    (window as Window & { electronAPI?: unknown }).electronAPI = electronApiStub ?? {};
    render(<WatchBrowserButton conversationId='conv-1' />);
    await settle();

    expect(screen.queryByRole('button', { name: LABEL })).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('opens a browser tab in the preview when there is none', async () => {
    render(<WatchBrowserButton conversationId='conv-1' />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: LABEL }));

    expect(preview.value?.openBrowserTab).toHaveBeenCalledTimes(1);
    expect(preview.value?.revealBrowserFor).not.toHaveBeenCalled();
  });

  it('shows the existing browser tab instead of opening another', async () => {
    if (preview.value) {
      preview.value.tabs = [
        { id: 'file-1', content_type: 'markdown' },
        { id: 'browser-1', content_type: 'browser' },
      ];
    }
    render(<WatchBrowserButton conversationId='conv-1' />);
    await settle();

    fireEvent.click(screen.getByRole('button', { name: LABEL }));

    expect(preview.value?.switchTab).toHaveBeenCalledWith('browser-1');
    expect(preview.value?.revealBrowserFor).toHaveBeenCalledWith('conv-1');
    expect(preview.value?.openBrowserTab).not.toHaveBeenCalled();
  });

  it('polls every 5 s, and stops on unmount', async () => {
    tabs = [];
    const { unmount } = render(<WatchBrowserButton conversationId='conv-1' />);
    await settle();
    expect(screen.queryByRole('button', { name: LABEL })).toBeNull();

    tabs = [TAB];
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: LABEL })).toBeInTheDocument();

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(20_000);
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('does not poll while the page is hidden', async () => {
    const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    render(<WatchBrowserButton conversationId='conv-1' />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15_000);
    });
    expect(fetchMock).not.toHaveBeenCalled();

    visibility.mockReturnValue('visible');
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });
    await settle();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: LABEL })).toBeInTheDocument();
  });
});
