/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Shared fakes for the live view tests: a WebSocket the test drives, the tabs route, frame decoding and layout.
 * Each test file still declares its own `vi.mock` calls (they are hoisted per file).
 */

import { act, waitFor } from '@testing-library/react';
import { expect, vi } from 'vitest';
import { encodeFrame, type FrameMeta } from '@process/services/agentBrowser/relay/browserView/protocol';
import {
  resetCurrentConversationForTest,
  setCurrentConversation,
} from '@/renderer/pages/conversation/explorer/currentConversationStore';

export type Message = { type: string; [field: string]: unknown };

export class FakeWebSocket {
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

  ofType(type: string): Message[] {
    return this.messages().filter((message) => message.type === type);
  }
}

export const META: FrameMeta = {
  offsetTop: 0,
  pageScaleFactor: 2,
  deviceWidth: 800,
  deviceHeight: 400,
  scrollOffsetX: 0,
  scrollOffsetY: 0,
};

export const frame = (): ArrayBuffer => {
  const buf = encodeFrame(META, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
};

export type Tab = { id: string; title: string; url: string; paused: boolean; active?: boolean };
export const TAB_ONE: Tab = { id: 'wc-1', title: 'One', url: 'https://one.example/' };
export const TAB_TWO: Tab = { id: 'wc-2', title: 'Two', url: 'https://two.example/' };
export const TAB_THREE: Tab = { id: 'wc-3', title: '', url: 'https://three.example/path?q=1' };

/** What the tabs route answers; tests reassign it. */
export const route = { tabs: [TAB_ONE] as Tab[] };
export const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => ({
  ok: true,
  status: 200,
  json: async () => ({ tabs: route.tabs }),
}));

/** The preview context the live view sees; the test files' PreviewContext mock reads it. */
export const preview = { value: null as { closePreview: () => void } | null };

let decodeResolvers: Array<() => void> = [];
let blobCount = 0;
export const createObjectURL = vi.fn(() => `blob:frame-${++blobCount}`);
export const revokeObjectURL = vi.fn();
const originalCreate = URL.createObjectURL;
const originalRevoke = URL.revokeObjectURL;
let electronApiStub: unknown;

export const setUpLiveView = (): void => {
  FakeWebSocket.instances = [];
  route.tabs = [TAB_ONE];
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
};

export const tearDownLiveView = (): void => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  URL.createObjectURL = originalCreate;
  URL.revokeObjectURL = originalRevoke;
  delete (HTMLImageElement.prototype as unknown as Record<string, unknown>).decode;
  (window as Window & { electronAPI?: unknown }).electronAPI = electronApiStub;
  preview.value = null;
  resetCurrentConversationForTest();
};

/** Waits for the live view's socket number `index` and opens it. */
export const openSocket = async (index = 0): Promise<FakeWebSocket> => {
  await waitFor(() => expect(FakeWebSocket.instances.length).toBeGreaterThan(index));
  const ws = FakeWebSocket.instances[index];
  ws.open();
  return ws;
};

/** Lets the oldest pending frame decode finish. */
export const finishDecode = async (): Promise<void> => {
  await act(async () => {
    decodeResolvers.shift()?.();
  });
};

/** Delivers a frame and lets its decode finish. */
export const showFrame = async (ws: FakeWebSocket): Promise<void> => {
  ws.receive(frame());
  await finishDecode();
};

export const liveImage = (): HTMLImageElement => {
  const img = document.querySelector('img');
  if (!img) throw new Error('no live image');
  return img;
};

/** The 400x200 frame drawn in a `width`x`height` CSS px view at the top-left corner of the screen. */
export const layOutView = (surface: HTMLElement, width = 200, height = 100): void => {
  const img = liveImage();
  Object.defineProperty(img, 'naturalWidth', { configurable: true, value: 400 });
  Object.defineProperty(img, 'naturalHeight', { configurable: true, value: 200 });
  surface.getBoundingClientRect = () =>
    ({ left: 0, top: 0, width, height, right: width, bottom: height, x: 0, y: 0 }) as DOMRect;
};
