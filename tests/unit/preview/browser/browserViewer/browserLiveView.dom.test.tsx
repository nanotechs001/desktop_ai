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
import { encodeFrame, type FrameMeta } from '@process/services/agentBrowser/relay/browserView/protocol';

vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

const preview = vi.hoisted(() => ({ value: null as { closePreview: () => void } | null }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => preview.value,
}));

import WebviewHost from '@/renderer/components/media/WebviewHost';
import {
  resetCurrentConversationForTest,
  setCurrentConversation,
} from '@/renderer/pages/conversation/explorer/currentConversationStore';

type Message = { type: string; [field: string]: unknown };

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  binaryType = 'blob';
  sent: string[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.readyState = FakeWebSocket.CLOSED;
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    act(() => this.onopen?.());
  }

  receive(data: unknown): void {
    act(() => this.onmessage?.({ data }));
  }

  serverClose(code: number): void {
    this.readyState = FakeWebSocket.CLOSED;
    act(() => this.onclose?.({ code }));
  }

  messages(): Message[] {
    return this.sent.map((raw) => JSON.parse(raw) as Message);
  }
}

const META: FrameMeta = {
  offsetTop: 0,
  pageScaleFactor: 2,
  deviceWidth: 800,
  deviceHeight: 400,
  scrollOffsetX: 0,
  scrollOffsetY: 0,
};

const frame = (): ArrayBuffer => {
  const buf = encodeFrame(META, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

type Tab = { id: string; title: string; url: string; paused: boolean };
const TAB_ONE: Tab = { id: 'wc-1', title: 'One', url: 'https://one.example/', paused: false };
const TAB_TWO: Tab = { id: 'wc-2', title: 'Two', url: 'https://two.example/', paused: false };

let tabs: Tab[] = [TAB_ONE];
const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
  ok: true,
  status: 200,
  json: async () => ({ tabs }),
}));

let decodeResolvers: Array<() => void> = [];
let blobCount = 0;
const createObjectURL = vi.fn(() => `blob:frame-${++blobCount}`);
const revokeObjectURL = vi.fn();
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let electronApiStub: unknown;

beforeEach(() => {
  FakeWebSocket.instances = [];
  tabs = [TAB_ONE];
  decodeResolvers = [];
  blobCount = 0;
  fetchMock.mockClear();
  createObjectURL.mockClear();
  revokeObjectURL.mockClear();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  vi.stubGlobal('fetch', fetchMock);
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    callback(0);
    return 1;
  });
  URL.createObjectURL = createObjectURL;
  URL.revokeObjectURL = revokeObjectURL;
  Object.defineProperty(HTMLImageElement.prototype, 'decode', {
    configurable: true,
    value: () => new Promise<void>((resolve) => decodeResolvers.push(resolve)),
  });
  const w = window as Window & { electronAPI?: unknown };
  electronApiStub = w.electronAPI;
  delete w.electronAPI;
  preview.value = { closePreview: vi.fn() };
  setCurrentConversation('conv-1');
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  delete (HTMLImageElement.prototype as unknown as Record<string, unknown>).decode;
  (window as Window & { electronAPI?: unknown }).electronAPI = electronApiStub;
  preview.value = null;
  resetCurrentConversationForTest();
});

const renderLive = () => render(<WebviewHost url='https://one.example/' liveView />);

/** Renders the live view and waits for its socket to the first tab. */
const connected = async (): Promise<FakeWebSocket> => {
  renderLive();
  await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1));
  const ws = FakeWebSocket.instances[0];
  ws.open();
  return ws;
};

/** Delivers a frame and lets its decode finish. */
const showFrame = async (ws: FakeWebSocket): Promise<void> => {
  ws.receive(frame());
  await act(async () => {
    decodeResolvers.shift()?.();
  });
};

const liveImage = (): HTMLImageElement => {
  const img = document.querySelector('img');
  if (!img) throw new Error('no live image');
  return img;
};

/** The image drawn at 200x100 CSS px from the top-left corner, filling its box. */
const layOutImage = (img: HTMLImageElement): void => {
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 400 });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 200 });
  img.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width: 200, height: 100, right: 200, bottom: 100, x: 0, y: 0 }) as DOMRect;
};

describe('BrowserLiveView tabs', () => {
  it('keeps the desktop-only notice when the conversation has no tabs', async () => {
    tabs = [];
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

  it('switches the stream with a Select when there are two tabs', async () => {
    tabs = [TAB_ONE, TAB_TWO];
    await connected();

    fireEvent.click(document.querySelector('.arco-select-view') as Element);
    const option = await waitFor(() => {
      const found = [...document.querySelectorAll('.arco-select-option')].find((el) => el.textContent === 'Two');
      if (!found) throw new Error('option Two not found');
      return found;
    });
    fireEvent.click(option);

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    expect(FakeWebSocket.instances[0].closed).toBe(true);
    expect(FakeWebSocket.instances[1].url).toMatch(/\?tab=wc-2$/);
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

    await act(async () => {
      decodeResolvers.shift()?.();
    });

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
  it('a tap at the centre of the image sends tap 0.5, 0.5', async () => {
    const ws = await connected();
    await showFrame(ws);
    const img = liveImage();
    layOutImage(img);
    const surface = screen.getByRole('img');

    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 100, clientY: 50 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 102, clientY: 51 });

    expect(ws.messages().filter((m) => m.type === 'tap')).toEqual([{ type: 'tap', nx: 0.5, ny: 0.5 }]);
  });

  it('a tap in the letterbox outside the drawn image is ignored', async () => {
    const ws = await connected();
    await showFrame(ws);
    const img = liveImage();
    layOutImage(img);
    // A 200x200 box draws the 2:1 image 100 px tall, centred: rows 50..150.
    img.getBoundingClientRect = () =>
      ({ left: 0, top: 0, width: 200, height: 200, right: 200, bottom: 200, x: 0, y: 0 }) as DOMRect;
    const surface = screen.getByRole('img');

    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 100, clientY: 20 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 100, clientY: 20 });
    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 100, clientY: 100 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 100, clientY: 100 });

    expect(ws.messages().filter((m) => m.type === 'tap')).toEqual([{ type: 'tap', nx: 0.5, ny: 0.5 }]);
  });

  it('a vertical swipe sends scroll in page CSS px, not a tap', async () => {
    const ws = await connected();
    await showFrame(ws);
    layOutImage(liveImage());
    const surface = screen.getByRole('img');

    fireEvent.pointerDown(surface, { pointerId: 1, clientX: 100, clientY: 80 });
    fireEvent.pointerMove(surface, { pointerId: 1, clientX: 100, clientY: 55 });
    fireEvent.pointerUp(surface, { pointerId: 1, clientX: 100, clientY: 55 });

    // 25 px up on a 100 px tall image of a 400/2 = 200 CSS px tall page scrolls 50 px down.
    const scrolls = ws.messages().filter((m) => m.type === 'scroll');
    expect(scrolls).toEqual([{ type: 'scroll', nx: 0.5, ny: 0.8, dy: 50 }]);
    expect(ws.messages().some((m) => m.type === 'tap')).toBe(false);
  });

  it('typing sends text and clears the input; Enter and Backspace send key', async () => {
    const ws = await connected();
    const input = screen.getByRole('textbox') as HTMLInputElement;

    fireEvent.click(screen.getByRole('button', { name: /preview\.browser\.liveKeyboard/ }));
    expect(document.activeElement).toBe(input);

    fireEvent.change(input, { target: { value: 'hi' } });
    expect(input.value).toBe('');
    fireEvent.keyDown(input, { key: 'Enter', keyCode: 13 });
    fireEvent.keyDown(input, { key: 'Backspace', keyCode: 8 });

    expect(ws.messages().slice(1)).toEqual([
      { type: 'text', value: 'hi' },
      { type: 'key', key: 'Enter' },
      { type: 'key', key: 'Backspace' },
    ]);
  });
});

describe('BrowserLiveView status', () => {
  it('a paused tab shows the bar, and Resume sends resume', async () => {
    const ws = await connected();
    ws.receive(JSON.stringify({ type: 'tab', title: 'One', url: 'https://one.example/', paused: true }));

    fireEvent.click(screen.getByRole('button', { name: 'preview.browser.livePaused' }));

    expect(ws.messages().at(-1)).toEqual({ type: 'resume' });
  });

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

    fireEvent.click(screen.getByRole('button', { name: 'preview.browser.liveStopped' }));

    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2));
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
