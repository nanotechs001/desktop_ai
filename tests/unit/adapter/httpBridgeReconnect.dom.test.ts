/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The httpBridge realtime socket fails before sign-in and backs off up to 30s.
 * Signing in must dial it straight away instead of waiting the backoff out.
 */

type SocketListener = (event: unknown) => void;

class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  private readonly listeners = new Map<string, SocketListener[]>();

  constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  addEventListener(type: string, listener: SocketListener): void {
    this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
  }

  send(): void {}

  close(): void {
    this.readyState = FakeWebSocket.CLOSED;
    for (const listener of this.listeners.get('close') ?? []) listener({ code: 1006, reason: '' });
  }
}

const loadHttpBridge = async () => {
  FakeWebSocket.instances = [];
  vi.resetModules();
  vi.stubGlobal('WebSocket', FakeWebSocket);
  return import('@/common/adapter/httpBridge');
};

describe('reconnectWs', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, 'debug').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('dials immediately when a backoff retry is pending, and the stale timer does not dial again', async () => {
    const { wsEmitter, reconnectWs } = await loadHttpBridge();
    wsEmitter('conversation.listChanged').on(() => {});
    expect(FakeWebSocket.instances).toHaveLength(1);

    FakeWebSocket.instances[0].close();
    expect(FakeWebSocket.instances).toHaveLength(1);

    reconnectWs();
    expect(FakeWebSocket.instances).toHaveLength(2);

    await vi.advanceTimersByTimeAsync(30000);
    expect(FakeWebSocket.instances).toHaveLength(2);
  });

  it('is part of the login reconnect the browser adapter exposes', async () => {
    const { wsEmitter } = await loadHttpBridge();
    delete (window as { electronAPI?: unknown }).electronAPI;
    await import('@/common/adapter/browser');
    wsEmitter('conversation.listChanged').on(() => {});
    const realtime = FakeWebSocket.instances.at(-1);
    realtime?.close();
    const before = FakeWebSocket.instances.length;

    (window as { __websocketReconnect?: () => void }).__websocketReconnect?.();

    // browser.ts's own socket is still connecting, so the only new dial is the realtime one.
    expect(FakeWebSocket.instances).toHaveLength(before + 1);
    expect(FakeWebSocket.instances.at(-1)).not.toBe(realtime);
  });

  it('opens nothing when no one has used the realtime socket yet', async () => {
    const { reconnectWs } = await loadHttpBridge();
    reconnectWs();
    expect(FakeWebSocket.instances).toHaveLength(0);
  });
});
