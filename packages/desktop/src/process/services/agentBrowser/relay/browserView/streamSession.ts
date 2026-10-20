/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { targetIdFor, type RelayContents, type TargetRegistry } from '../targetRegistry';
import {
  encodeFrame,
  mapTap,
  parseClientMessage,
  type ALLOWED_KEYS,
  type ClientMessage,
  type FrameMeta,
} from './protocol';
import { isViewable } from './rules';
import type { CastViewer, TabCast } from './tabCast';

/** The phone's socket, as the web host adapts it. */
export type StreamPeer = {
  sendBinary(b: Buffer): void;
  sendText(s: string): void;
  close(code: number, reason: string): void;
};

export type StreamHandle = { onMessage(raw: string): void; close(): void };

/** Why a stream was refused or ended. */
export type StreamRefusal = 'tab-closed' | 'not-allowed';

/** A stream as its service holds it: started once its tab's cast is ready, ended by the service on shutdown. */
export type Stream = StreamHandle & {
  start(): void;
  end(reason: StreamRefusal): void;
  isDone(): boolean;
};

export type StreamDeps = {
  registry: TargetRegistry;
  cast: TabCast;
  webContentsId: number;
  peer: StreamPeer;
  /** The stream ended; its service forgets it. */
  onClose(): void;
};

type AllowedKey = (typeof ALLOWED_KEYS)[number];

const NO_FRAMES_MS = 5000;
const TAB_POLL_MS = 1000;
const CLOSE_CODES: Record<StreamRefusal, number> = { 'tab-closed': 1001, 'not-allowed': 1008 };
/** Without a virtual key code Chromium dispatches the key but runs no default action (no submit, no delete). */
const KEY_CODES: Record<AllowedKey, number> = {
  Enter: 13,
  Backspace: 8,
  Tab: 9,
  Escape: 27,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
};
/** Inserted text has no key of its own; any non-agent key report pauses the agent. */
const TEXT_INPUT = { kind: 'key', key: 'Unidentified', code: '' } as const;

/** The tab's contents when a phone may stream it, else why not. */
export const viewableContents = (registry: TargetRegistry, webContentsId: number): RelayContents | StreamRefusal => {
  const ownership = registry.ownership(webContentsId);
  const contents = registry.contents(webContentsId);
  if (!ownership || !contents || contents.isDestroyed()) return 'tab-closed';
  return isViewable(ownership) ? contents : 'not-allowed';
};

/**
 * One phone watching one tab: its frames come from the tab's shared {@link TabCast}; its taps, scrolls and keys go
 * out as CDP input (pausing the agent like a desktop take-over); it hears the tab's title, url and pause state. Ends
 * itself when the tab closes or stops being viewable. Joins the cast at once, so the cast outlives its attach.
 */
export function createStream({ registry, cast, webContentsId, peer, onClose }: StreamDeps): Stream {
  let started = false;
  let done = false;
  /** Metadata of the frame the phone shows, for mapping its taps. */
  let shown: FrameMeta | null = null;
  let lastTab = '';
  let noFrames: NodeJS.Timeout | undefined;
  let poll: NodeJS.Timeout | undefined;
  let unsubscribe: Array<() => void> = [];

  const syncTab = (): void => {
    const target = registry.listTargets().find((t) => t.targetId === targetIdFor(webContentsId));
    const ownership = registry.ownership(webContentsId);
    if (!target || !ownership) return;
    const text = JSON.stringify({ type: 'tab', title: target.title, url: target.url, paused: ownership.paused });
    if (text === lastTab) return;
    lastTab = text;
    peer.sendText(text);
  };

  const hello = (width: number, dpr: number): void => {
    cast.hello(viewer, width, dpr);
    if (shown || noFrames) return;
    noFrames = setTimeout(() => {
      if (!done && !shown) peer.sendText(JSON.stringify({ type: 'no-frames' }));
    }, NO_FRAMES_MS);
  };
  const tap = (nx: number, ny: number): void => {
    if (!shown) return;
    const { x, y } = mapTap(nx, ny, shown);
    registry.noteUserInput(webContentsId, { kind: 'mouse', x, y });
    const click = { x, y, button: 'left', clickCount: 1 };
    cast.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    cast.send('Input.dispatchMouseEvent', { type: 'mousePressed', ...click });
    cast.send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...click });
  };
  const scroll = (nx: number, ny: number, dy: number): void => {
    if (!shown) return;
    const { x, y } = mapTap(nx, ny, shown);
    cast.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
  };
  const key = (name: AllowedKey): void => {
    registry.noteUserInput(webContentsId, { kind: 'key', key: name, code: name });
    const base = { key: name, code: name, windowsVirtualKeyCode: KEY_CODES[name] };
    cast.send('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(name === 'Enter' ? { text: '\r' } : {}) });
    cast.send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };

  const handle = (message: ClientMessage): void => {
    switch (message.type) {
      case 'hello':
        return hello(message.width, message.dpr);
      case 'ack':
        return cast.ack(viewer);
      case 'tap':
        return tap(message.nx, message.ny);
      case 'scroll':
        return scroll(message.nx, message.ny, message.dy);
      case 'text':
        registry.noteUserInput(webContentsId, TEXT_INPUT);
        return cast.send('Input.insertText', { text: message.value });
      case 'key':
        return key(message.key);
      case 'resume':
        return registry.setPaused(webContentsId, false);
    }
  };

  const teardown = (): void => {
    if (done) return;
    done = true;
    clearTimeout(noFrames);
    clearInterval(poll);
    unsubscribe.forEach((off) => off());
    cast.leave(viewer);
    onClose();
  };
  const end = (reason: StreamRefusal): void => {
    if (done) return;
    // Before start the opener refuses instead, so the phone hears nothing yet.
    if (!started) return teardown();
    peer.sendText(JSON.stringify({ type: 'closed', reason }));
    teardown();
    peer.close(CLOSE_CODES[reason], reason);
  };

  const viewer: CastViewer = {
    show(frame) {
      if (done) return;
      shown = frame.meta;
      peer.sendBinary(encodeFrame(frame.meta, frame.jpeg));
    },
    gone: () => end('tab-closed'),
  };
  cast.join(viewer);

  return {
    start() {
      if (started || done) return;
      started = true;
      unsubscribe = [
        registry.onChange(() => {
          const ownership = registry.ownership(webContentsId);
          if (!ownership || done) return;
          if (!isViewable(ownership)) return end('not-allowed');
          syncTab();
        }),
        registry.onDestroyed((last) => {
          if (last.webContentsId === webContentsId) end('tab-closed');
        }),
      ];
      // Electron's contents expose no title event to the relay, so title and url changes are polled.
      poll = setInterval(syncTab, TAB_POLL_MS);
      poll.unref?.();
      syncTab();
    },
    end,
    isDone: () => done,
    onMessage(raw) {
      if (done || !started) return;
      const message = parseClientMessage(raw);
      if (message) handle(message);
    },
    close: teardown,
  };
}
