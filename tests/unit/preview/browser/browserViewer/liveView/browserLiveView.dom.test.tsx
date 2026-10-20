/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The WebUI's live view of the agent's desktop tab: `WebviewHost` outside Electron, in the on-screen browser
 * preview tab (`liveView`), streams the conversation's tab over a WebSocket and sends taps and typing back.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', async () => {
  const { preview } = await import('./liveViewHarness');
  return { useOptionalPreviewContext: () => preview.value };
});

import WebviewHost from '@/renderer/components/media/WebviewHost';
import { resetCurrentConversationForTest } from '@/renderer/pages/conversation/explorer/currentConversationStore';
import {
  FakeWebSocket,
  fetchMock,
  finishDecode,
  frame,
  layOutView,
  liveImage,
  openSocket,
  preview,
  revokeObjectURL,
  route,
  setUpLiveView,
  showFrame,
  tearDownLiveView,
} from './liveViewHarness';

beforeEach(setUpLiveView);

afterEach(() => {
  cleanup();
  tearDownLiveView();
});

const renderLive = () => render(<WebviewHost url='https://one.example/' liveView />);

/** Renders the live view and waits for its socket to the first tab. */
const connected = async (): Promise<FakeWebSocket> => {
  renderLive();
  return openSocket();
};

/** Taps once and waits out the double-tap window. */
const tap = (surface: HTMLElement, x: number, y: number): void => {
  fireEvent.pointerDown(surface, { pointerId: 1, clientX: x, clientY: y });
  fireEvent.pointerUp(surface, { pointerId: 1, clientX: x + 2, clientY: y + 1 });
  act(() => vi.advanceTimersByTime(300));
};

describe('BrowserLiveView tabs', () => {
  it('keeps the desktop-only notice when the conversation has no tabs', async () => {
    route.tabs = [];
    renderLive();

    expect(await screen.findByText('preview.browser.desktopOnly')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/browser-view/tabs?conversation=conv-1',
      expect.objectContaining({ credentials: 'include' })
    );
    expect(FakeWebSocket.instances).toHaveLength(0);
  });

  it('keeps the notice without a conversation id, and asks for no tabs', () => {
    resetCurrentConversationForTest();
    renderLive();

    expect(screen.getByText('preview.browser.desktopOnly')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the notice outside the on-screen browser tab', () => {
    render(<WebviewHost url='https://one.example/' />);

    expect(screen.getByText('preview.browser.desktopOnly')).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('streams the only tab', async () => {
    const ws = await connected();

    expect(ws.url).toMatch(/^ws:\/\/.+\/api\/browser-view\/stream\?tab=wc-1$/);
    expect(ws.binaryType).toBe('arraybuffer');
    expect(screen.queryByText('preview.browser.desktopOnly')).toBeNull();
    expect(screen.getByText('One')).toBeInTheDocument();
  });

  it('has a way back to the chat', async () => {
    await connected();

    fireEvent.click(screen.getByRole('button', { name: 'common.back' }));

    expect(preview.value?.closePreview).toHaveBeenCalledTimes(1);
  });
});

describe('BrowserLiveView frames', () => {
  it('sends hello on open', async () => {
    const ws = await connected();

    expect(ws.messages()[0]).toEqual({ type: 'hello', width: expect.any(Number), dpr: expect.any(Number) });
    expect(ws.messages()[0].width).toBeGreaterThan(0);
  });

  it('shows a frame and acks it only after it decoded', async () => {
    const ws = await connected();
    expect(screen.getByText('preview.browser.liveConnecting')).toBeInTheDocument();

    ws.receive(frame());
    expect(liveImage().getAttribute('src')).toBe('blob:frame-1');
    expect(ws.messages().some((m) => m.type === 'ack')).toBe(false);

    await finishDecode();

    expect(ws.messages().filter((m) => m.type === 'ack')).toHaveLength(1);
    expect(screen.queryByText('preview.browser.liveConnecting')).toBeNull();
  });

  it('revokes the previous frame', async () => {
    const ws = await connected();
    await showFrame(ws);
    await showFrame(ws);

    expect(liveImage().getAttribute('src')).toBe('blob:frame-2');
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:frame-1');
  });
});

describe('BrowserLiveView input', () => {
  it('a tap at the centre of the image sends tap 0.5, 0.5 once the double-tap window passes', async () => {
    const ws = await connected();
    await showFrame(ws);
    const surface = screen.getByRole('img');
    layOutView(surface);
    vi.useFakeTimers();

    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 102, clientY: 51 });
    expect(ws.ofType('tap')).toEqual([]);
    act(() => vi.advanceTimersByTime(300));

    expect(ws.ofType('tap')).toEqual([{ type: 'tap', nx: 0.5, ny: 0.5 }]);
  });

  it('a tap in the letterbox outside the drawn image is ignored', async () => {
    const ws = await connected();
    await showFrame(ws);
    const surface = screen.getByRole('img');
    // A 200x200 box draws the 2:1 image 100 px tall, centred: rows 50..150.
    layOutView(surface, 200, 200);
    vi.useFakeTimers();

    tap(surface, 100, 20);
    tap(surface, 100, 100);

    expect(ws.ofType('tap')).toEqual([{ type: 'tap', nx: 0.5, ny: 0.5 }]);
  });

  it('a vertical swipe sends scroll in page CSS px, not a tap', async () => {
    const ws = await connected();
    await showFrame(ws);
    const surface = screen.getByRole('img');
    layOutView(surface);

    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 100, clientY: 80 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 100, clientY: 55 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 100, clientY: 55 });

    // 25 px up on a 100 px tall image of a 400/2 = 200 CSS px tall page scrolls 50 px down.
    expect(ws.ofType('scroll')).toEqual([{ type: 'scroll', nx: 0.5, ny: 0.8, dy: 50 }]);
    expect(ws.ofType('tap')).toEqual([]);
  });

  it('captures the pointer, so a drag released outside still ends', async () => {
    const ws = await connected();
    await showFrame(ws);
    const surface = screen.getByRole('img');
    const setPointerCapture = vi.fn();
    surface.setPointerCapture = setPointerCapture;

    fireEvent.pointerDown(surface, { pointerId: 7, clientX: 100, clientY: 50 });

    expect(setPointerCapture).toHaveBeenCalledWith(7);
  });

  it('lifting the finger cancels the pending frame and sends the scroll at once', async () => {
    const ws = await connected();
    await showFrame(ws);
    const surface = screen.getByRole('img');
    layOutView(surface);
    vi.stubGlobal('requestAnimationFrame', () => 42);
    const cancelAnimationFrame = vi.fn();
    vi.stubGlobal('cancelAnimationFrame', cancelAnimationFrame);

    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 100, clientY: 80 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 100, clientY: 55 });
    expect(ws.ofType('scroll')).toEqual([]);
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 100, clientY: 55 });

    expect(cancelAnimationFrame).toHaveBeenCalledWith(42);
    expect(ws.ofType('scroll')).toEqual([{ type: 'scroll', nx: 0.5, ny: 0.8, dy: 50 }]);
  });
});

describe('BrowserLiveView status', () => {
  it('no-frames shows the keep-the-window-open message', async () => {
    const ws = await connected();

    ws.receive(JSON.stringify({ type: 'no-frames' }));

    expect(screen.getByText('preview.browser.liveNoFrames')).toBeInTheDocument();
  });

  it('reconnects after 1, 3 and 10 s, then offers a retry', async () => {
    const ws = await connected();
    vi.useFakeTimers();

    ws.serverClose(1006);
    act(() => vi.advanceTimersByTime(999));
    expect(FakeWebSocket.instances).toHaveLength(1);
    act(() => vi.advanceTimersByTime(1));
    expect(FakeWebSocket.instances).toHaveLength(2);

    FakeWebSocket.instances[1].serverClose(1011);
    act(() => vi.advanceTimersByTime(3000));
    expect(FakeWebSocket.instances).toHaveLength(3);

    FakeWebSocket.instances[2].serverClose(1006);
    act(() => vi.advanceTimersByTime(10_000));
    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(screen.queryByText('preview.browser.liveStopped')).toBeNull();

    FakeWebSocket.instances[3].serverClose(1006);
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(4);
    expect(screen.getByRole('button', { name: 'preview.browser.liveStopped' })).toBeInTheDocument();
  });

  it('stops at once when the tab is not allowed, and tapping retries', async () => {
    const ws = await connected();
    vi.useFakeTimers();

    ws.serverClose(1008);
    act(() => vi.advanceTimersByTime(60_000));
    expect(FakeWebSocket.instances).toHaveLength(1);
    vi.useRealTimers();
    const fetchesBefore = fetchMock.mock.calls.length;

    fireEvent.click(screen.getByRole('button', { name: 'preview.browser.liveStopped' }));

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    expect(fetchMock.mock.calls.length).toBeGreaterThan(fetchesBefore);
  });
});

describe('BrowserLiveView cleanup', () => {
  it('unmounting closes the socket and revokes the frame', async () => {
    const ws = await connected();
    await showFrame(ws);

    cleanup();

    expect(ws.closed).toBe(true);
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:frame-1');
  });
});
