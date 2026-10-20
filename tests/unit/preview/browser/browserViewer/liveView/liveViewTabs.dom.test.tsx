/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Which desktop tab the live view streams: the agent's newest one, until the user picks one in the tab picker.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count === undefined ? key : `${key}:${options.count}`),
  }),
}));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', async () => {
  const { preview } = await import('./liveViewHarness');
  return { useOptionalPreviewContext: () => preview.value };
});

import WebviewHost from '@/renderer/components/media/WebviewHost';
import {
  FakeWebSocket,
  liveImage,
  openSocket,
  route,
  setUpLiveView,
  showFrame,
  TAB_ONE,
  TAB_THREE,
  TAB_TWO,
  tearDownLiveView,
} from './liveViewHarness';

beforeEach(() => {
  setUpLiveView();
  // Faked before render so the 5 s poll is on the fake clock; it still runs in real time for waitFor.
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  tearDownLiveView();
});

const renderLive = () => render(<WebviewHost url='https://one.example/' liveView />);

const nextPoll = async (): Promise<void> => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000);
  });
};

const streamedTab = (index: number): string | null =>
  new URL(FakeWebSocket.instances[index].url).searchParams.get('tab');

describe('BrowserLiveView follows the newest tab', () => {
  it('opens on the newest listed tab', async () => {
    route.tabs = [TAB_ONE, TAB_TWO];
    renderLive();
    await openSocket();

    expect(streamedTab(0)).toBe('wc-2');
  });

  it('switches the stream to a second tab when it appears, dropping the old frame', async () => {
    renderLive();
    const first = await openSocket();
    await showFrame(first);
    expect(streamedTab(0)).toBe('wc-1');

    route.tabs = [TAB_ONE, TAB_TWO];
    await nextPoll();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(first.closed).toBe(true);
    expect(streamedTab(1)).toBe('wc-2');
    expect(liveImage().hasAttribute('src')).toBe(false);
  });

  it('after a manual pick, a new tab does not switch the stream', async () => {
    route.tabs = [TAB_ONE, TAB_TWO];
    renderLive();
    await openSocket();

    fireEvent.click(screen.getByRole('radio', { name: 'One' }));
    await openSocket(1);
    expect(streamedTab(1)).toBe('wc-1');

    route.tabs = [TAB_ONE, TAB_TWO, TAB_THREE];
    await nextPoll();

    expect(FakeWebSocket.instances).toHaveLength(2);
    expect(FakeWebSocket.instances[1].closed).toBe(false);
  });

  it('when the picked tab closes, it goes back to following the newest', async () => {
    route.tabs = [TAB_ONE, TAB_TWO];
    renderLive();
    await openSocket();
    fireEvent.click(screen.getByRole('radio', { name: 'One' }));
    await openSocket(1);

    route.tabs = [TAB_TWO, TAB_THREE];
    await nextPoll();
    expect(streamedTab(2)).toBe('wc-3');

    // Following again: the next new tab is taken too.
    const four = { ...TAB_ONE, id: 'wc-4', title: 'Four' };
    route.tabs = [TAB_TWO, TAB_THREE, four];
    await nextPoll();
    expect(streamedTab(3)).toBe('wc-4');
  });
});

describe('BrowserLiveView tab picker', () => {
  it('is hidden with one tab', async () => {
    renderLive();
    await openSocket();

    expect(screen.queryByRole('radiogroup')).toBeNull();
    expect(screen.queryByText('preview.browser.liveTabCount:1')).toBeNull();
  });

  it('with two or more tabs shows the count and one button per tab, the url host standing in for a missing title', async () => {
    route.tabs = [TAB_ONE, TAB_TWO, TAB_THREE];
    renderLive();
    await openSocket();

    expect(screen.getByRole('group', { name: 'preview.browser.liveTabSelect' })).toBeInTheDocument();
    expect(screen.getByText('preview.browser.liveTabCount:3')).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'One' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Two' })).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'three.example' })).toBeChecked();
  });
});
