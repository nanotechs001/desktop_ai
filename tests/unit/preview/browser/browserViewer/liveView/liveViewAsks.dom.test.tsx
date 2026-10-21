/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * On a phone the open live view covers the chat, so the chat's browser asks show in the live view itself: the
 * page being asked about and its Allow and Deny are on one screen.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', async () => {
  const { preview } = await import('./liveViewHarness');
  return { useOptionalPreviewContext: () => preview.value };
});

import WebviewHost from '@/renderer/components/media/WebviewHost';
import { resetCurrentConversationForTest } from '@/renderer/pages/conversation/explorer/currentConversationStore';
import { openSocket, route, setUpLiveView, tearDownLiveView } from './liveViewHarness';

const KEY = 'preview.browserChrome.confirm';
const ID = '0b8f3c1e-6a3d-4c2b-9f4e-1d2c3b4a5f60';
const ASK = { id: ID, origin: 'https://shop.test', frameOrigin: 'https://shop.test', label: 'Place order' };

let asks: unknown[] = [];
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === 'POST') {
    asks = [];
    return new Response(null, { status: 204 });
  }
  const body = url.startsWith('/api/browser-view/confirms') ? { confirms: asks } : { tabs: route.tabs };
  return new Response(JSON.stringify(body), { status: 200 });
});
const confirmGets = () =>
  fetchMock.mock.calls.filter(([url, init]) => url.startsWith('/api/browser-view/confirms') && !init?.method);

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  setUpLiveView();
  asks = [ASK];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  tearDownLiveView();
});

const renderLive = () => render(<WebviewHost url='https://one.example/' liveView />);

describe('BrowserLiveView with an ask pending', () => {
  it("shows the chat's ask over the stream, and an Allow there answers it and drops the card", async () => {
    renderLive();
    await openSocket();
    await tick(0);

    expect(confirmGets()[0][0]).toBe('/api/browser-view/confirms?conversation=conv-1');
    expect(screen.getByText('Place order')).toBeTruthy();
    expect(screen.getByRole('img')).toBeTruthy(); // the stream stays on screen under it

    await tick(600); // past the Allow delay
    fireEvent.click(screen.getByText(`${KEY}.allow`));
    await tick(0);

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe(`/api/browser-view/confirms/${ID}`);
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ allow: true, always: false });
    expect(screen.queryByText('Place order')).toBeNull();
  });

  it('shows the ask even when the chat has no tab the phone can watch', async () => {
    route.tabs = [];
    renderLive();
    await tick(0);

    expect(await screen.findByText('preview.browser.desktopOnly')).toBeTruthy();
    expect(screen.getByText('Place order')).toBeTruthy();
  });

  it('asks for nothing without a conversation', async () => {
    resetCurrentConversationForTest();
    renderLive();
    await tick(0);

    expect(confirmGets()).toEqual([]);
    expect(screen.queryByText('Place order')).toBeNull();
  });
});
