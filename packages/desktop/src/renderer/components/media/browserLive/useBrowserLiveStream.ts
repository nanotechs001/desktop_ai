/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import { decodeFrame, type FrameMeta } from './frameCodec';

export type LiveKey = 'Enter' | 'Backspace';

/** What the phone sends main (main's protocol.ts parses and validates it). */
export type LiveClientMessage =
  | { type: 'hello'; width: number; dpr: number }
  | { type: 'ack' }
  | { type: 'tap'; nx: number; ny: number }
  | { type: 'scroll'; nx: number; ny: number; dy: number }
  | { type: 'text'; value: string }
  | { type: 'key'; key: LiveKey }
  | { type: 'resume' };

export type LiveStatus = 'connecting' | 'live' | 'no-frames' | 'stopped';
export type LiveTabInfo = { title: string; url: string; paused: boolean };

const RECONNECT_DELAYS_MS = [1000, 3000, 10_000];
/** 1001 the tab closed, 1008 not allowed or revoked: reconnecting cannot help. */
const STOP_CODES = new Set([1001, 1008]);

const streamUrl = (tabId: string): string =>
  `${location.origin.replace(/^http/, 'ws')}/api/browser-view/stream?tab=${encodeURIComponent(tabId)}`;

const parseTabInfo = (raw: string): LiveTabInfo | 'no-frames' | null => {
  try {
    const message: unknown = JSON.parse(raw);
    if (typeof message !== 'object' || message === null) return null;
    const { type, title, url, paused } = message as Record<string, unknown>;
    if (type === 'no-frames') return 'no-frames';
    if (type !== 'tab') return null;
    return {
      title: typeof title === 'string' ? title : '',
      url: typeof url === 'string' ? url : '',
      paused: paused === true,
    };
  } catch {
    return null;
  }
};

type LiveStream = {
  status: LiveStatus;
  tab: LiveTabInfo | null;
  /** Metadata of the frame on screen, for turning a swipe into page px. */
  metaRef: RefObject<FrameMeta | null>;
  send: (message: LiveClientMessage) => void;
};

/**
 * One phone stream of a desktop tab: `hello` on open, each frame into `imgRef` (acked once decoded, so main sends
 * the next), and reconnects with backoff unless main refused the tab. `tabId` null keeps it idle.
 */
export const useBrowserLiveStream = (
  tabId: string | null,
  imgRef: RefObject<HTMLImageElement | null>,
  surfaceRef: RefObject<HTMLElement | null>
): LiveStream => {
  const [status, setStatus] = useState<LiveStatus>('connecting');
  const [tab, setTab] = useState<LiveTabInfo | null>(null);
  const socketRef = useRef<WebSocket | null>(null);
  const metaRef = useRef<FrameMeta | null>(null);

  const send = useCallback((message: LiveClientMessage) => {
    const socket = socketRef.current;
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message));
  }, []);

  useEffect(() => {
    if (!tabId) return;
    let disposed = false;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let blobUrl: string | null = null;
    setStatus('connecting');
    setTab(null);
    metaRef.current = null;

    const showFrame = async (socket: WebSocket, data: ArrayBuffer): Promise<void> => {
      try {
        const { meta, jpeg } = decodeFrame(data);
        const img = imgRef.current;
        if (!img) return;
        const previous = blobUrl;
        blobUrl = URL.createObjectURL(new Blob([jpeg], { type: 'image/jpeg' }));
        img.src = blobUrl;
        if (previous) URL.revokeObjectURL(previous);
        await img.decode();
        if (disposed) return;
        metaRef.current = meta;
        attempt = 0;
        setStatus('live');
      } catch (error) {
        console.warn('[BrowserLiveView] could not show a frame:', error);
      } finally {
        // Main holds the next frame until this ack, so even a frame that failed to show is acked.
        if (!disposed && socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify({ type: 'ack' }));
      }
    };

    const connect = (): void => {
      const socket = new WebSocket(streamUrl(tabId));
      socket.binaryType = 'arraybuffer';
      socketRef.current = socket;
      socket.onopen = () => {
        const width = surfaceRef.current?.clientWidth || window.innerWidth;
        socket.send(JSON.stringify({ type: 'hello', width, dpr: window.devicePixelRatio || 1 }));
      };
      socket.onmessage = (event: MessageEvent) => {
        if (typeof event.data !== 'string') return void showFrame(socket, event.data as ArrayBuffer);
        const parsed = parseTabInfo(event.data);
        if (parsed === 'no-frames') setStatus((current) => (current === 'live' ? current : 'no-frames'));
        else if (parsed) setTab(parsed);
      };
      socket.onclose = (event: CloseEvent) => {
        if (disposed) return;
        if (STOP_CODES.has(event.code) || attempt >= RECONNECT_DELAYS_MS.length) {
          setStatus('stopped');
          return;
        }
        setStatus('connecting');
        timer = setTimeout(connect, RECONNECT_DELAYS_MS[attempt++]);
      };
    };
    connect();

    return () => {
      disposed = true;
      clearTimeout(timer);
      const socket = socketRef.current;
      socketRef.current = null;
      if (socket) {
        socket.onclose = null;
        socket.close();
      }
      if (blobUrl) URL.revokeObjectURL(blobUrl);
    };
  }, [tabId, imgRef, surfaceRef]);

  return { status, tab, metaRef, send };
};
