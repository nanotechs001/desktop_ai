/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DebuggerSessions, RelayEvent } from '../debuggerSessions';
import { targetIdFor, type RelayContents, type TargetRegistry } from '../targetRegistry';
import {
  ALLOWED_VIEWER_METHODS,
  encodeFrame,
  frameMetaSchema,
  mapTap,
  parseClientMessage,
  type ALLOWED_KEYS,
  type ClientMessage,
  type FrameMeta,
} from './protocol';
import { isViewable } from './rules';

/** The phone's socket, as the web host adapts it. */
export type StreamPeer = {
  sendBinary(b: Buffer): void;
  sendText(s: string): void;
  close(code: number, reason: string): void;
};

export type StreamHandle = { onMessage(raw: string): void; close(): void };

/** Why a stream was refused or ended. */
export type StreamRefusal = 'tab-closed' | 'not-allowed';

/** How a stream shares its tab's one screencast (one CDP client per tab) with the tab's other streams. */
export type TabShare = {
  /** True for the tab's oldest stream: only it acks CDP frames, so the screencast is paced once. */
  paces(): boolean;
  /** True when no other stream is on the tab, so stopping the screencast stops nobody else's. */
  alone(): boolean;
  leave(): void;
};

export type StreamSessionDeps = {
  registry: TargetRegistry;
  sessions: DebuggerSessions;
  contents: RelayContents;
  sinkId: string;
  peer: StreamPeer;
  share: TabShare;
};

type AllowedKey = (typeof ALLOWED_KEYS)[number];
type Frame = { meta: FrameMeta; jpeg: Buffer; ackId: number };

const MAX_WIDTH_PX = 1280;
const JPEG_QUALITY = 55;
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

const logCommandError = (error: unknown): void => {
  console.warn('[BrowserView] viewer command failed:', error);
};

const frameOf = (params: Record<string, unknown>): Frame | null => {
  const meta = frameMetaSchema.safeParse(params.metadata);
  const { data, sessionId } = params;
  if (!meta.success || typeof data !== 'string' || typeof sessionId !== 'number') return null;
  return { meta: meta.data, jpeg: Buffer.from(data, 'base64'), ackId: sessionId };
};

/** The tab's contents when a phone may stream it, else why not. */
export const viewableContents = (registry: TargetRegistry, webContentsId: number): RelayContents | StreamRefusal => {
  const ownership = registry.ownership(webContentsId);
  const contents = registry.contents(webContentsId);
  if (!ownership || !contents || contents.isDestroyed()) return 'tab-closed';
  return isViewable(ownership) ? contents : 'not-allowed';
};

/**
 * Streams one tab to a phone over the tab's shared debugger: a jpeg screencast paced by the phone's acks (one frame
 * in flight), the phone's taps, scrolls and keys as CDP input (pausing the agent like a desktop take-over), and the
 * tab's title, url and pause state. Ends itself when the tab closes or stops being viewable.
 */
export async function openStreamSession(deps: StreamSessionDeps): Promise<StreamHandle | { error: StreamRefusal }> {
  const { registry, sessions, contents, peer, share } = deps;
  const webContentsId = contents.id;
  let relayId = '';
  let done = false;
  let casting = false;
  /** Metadata of the frame the phone shows, for mapping its taps. */
  let shown: FrameMeta | null = null;
  /** CDP ack id of the frame the phone has not acked yet. */
  let inFlight: number | null = null;
  /** The newest frame waiting for the phone's ack. */
  let held: Frame | null = null;
  let lastTab = '';
  let noFrames: NodeJS.Timeout | undefined;
  let poll: NodeJS.Timeout | undefined;
  let unsubscribe: Array<() => void> = [];

  const cdp = (method: string, params: Record<string, unknown>): void => {
    if (!ALLOWED_VIEWER_METHODS.has(method)) throw new Error(`${method} is not allowed for the browser view`);
    sessions.send(relayId, method, params).catch(logCommandError);
  };
  const ackCdp = (ackId: number): void => {
    if (share.paces()) cdp('Page.screencastFrameAck', { sessionId: ackId });
  };

  const syncTab = (): void => {
    const target = registry.listTargets().find((t) => t.targetId === targetIdFor(webContentsId));
    const ownership = registry.ownership(webContentsId);
    if (!target || !ownership) return;
    const text = JSON.stringify({ type: 'tab', title: target.title, url: target.url, paused: ownership.paused });
    if (text === lastTab) return;
    lastTab = text;
    peer.sendText(text);
  };

  const forward = (frame: Frame): void => {
    peer.sendBinary(encodeFrame(frame.meta, frame.jpeg));
    shown = frame.meta;
    inFlight = frame.ackId;
  };
  const onFrame = (frame: Frame): void => {
    clearTimeout(noFrames);
    // Another stream's screencast: this phone has not asked yet, but the frame must not stall the tab.
    if (!casting) return ackCdp(frame.ackId);
    if (inFlight === null) return forward(frame);
    if (held) ackCdp(held.ackId);
    held = frame;
  };
  const onAck = (): void => {
    if (inFlight === null) return;
    ackCdp(inFlight);
    inFlight = null;
    const next = held;
    held = null;
    if (next) forward(next);
  };

  const startCast = (width: number, dpr: number): void => {
    casting = true;
    const maxWidth = Math.min(MAX_WIDTH_PX, Math.round(width * dpr));
    cdp('Page.startScreencast', { format: 'jpeg', quality: JPEG_QUALITY, maxWidth });
    if (shown || noFrames) return;
    noFrames = setTimeout(() => {
      if (!done) peer.sendText(JSON.stringify({ type: 'no-frames' }));
    }, NO_FRAMES_MS);
  };

  const tap = (nx: number, ny: number): void => {
    if (!shown) return;
    const { x, y } = mapTap(nx, ny, shown);
    registry.noteUserInput(webContentsId, { kind: 'mouse', x, y });
    const click = { x, y, button: 'left', clickCount: 1 };
    cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    cdp('Input.dispatchMouseEvent', { type: 'mousePressed', ...click });
    cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', ...click });
  };
  const scroll = (nx: number, ny: number, dy: number): void => {
    if (!shown) return;
    const { x, y } = mapTap(nx, ny, shown);
    cdp('Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: 0, deltaY: dy });
  };
  const key = (name: AllowedKey): void => {
    registry.noteUserInput(webContentsId, { kind: 'key', key: name, code: name });
    const base = { key: name, code: name, windowsVirtualKeyCode: KEY_CODES[name] };
    cdp('Input.dispatchKeyEvent', { type: 'keyDown', ...base, ...(name === 'Enter' ? { text: '\r' } : {}) });
    cdp('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
  };

  const handle = (message: ClientMessage): void => {
    switch (message.type) {
      case 'hello':
        return startCast(message.width, message.dpr);
      case 'ack':
        return onAck();
      case 'tap':
        return tap(message.nx, message.ny);
      case 'scroll':
        return scroll(message.nx, message.ny, message.dy);
      case 'text':
        registry.noteUserInput(webContentsId, TEXT_INPUT);
        return cdp('Input.insertText', { text: message.value });
      case 'key':
        return key(message.key);
      case 'resume':
        return registry.setPaused(webContentsId, false);
    }
  };

  /** Stops the screencast when no other stream watches it, else hands its pacing on; then drops the session. */
  const teardown = (): void => {
    if (done) return;
    done = true;
    clearTimeout(noFrames);
    clearInterval(poll);
    unsubscribe.forEach((off) => off());
    if (sessions.session(relayId)) {
      if (!contents.isDestroyed()) {
        if (share.alone()) cdp('Page.stopScreencast', {});
        else [inFlight, held?.ackId].forEach((ackId) => typeof ackId === 'number' && ackCdp(ackId));
      }
      sessions.detachSession(relayId);
    }
    share.leave();
  };
  const end = (reason: StreamRefusal): void => {
    if (done) return;
    peer.sendText(JSON.stringify({ type: 'closed', reason }));
    teardown();
    peer.close(CLOSE_CODES[reason], reason);
  };

  const sink = {
    id: deps.sinkId,
    emit(event: RelayEvent): void {
      if (done) return;
      if (event.method === 'Target.detachedFromTarget' && event.params.sessionId === relayId) return end('tab-closed');
      if (event.method !== 'Page.screencastFrame' || event.sessionId !== relayId) return;
      const frame = frameOf(event.params);
      if (frame) onFrame(frame);
    },
  };

  try {
    relayId = await sessions.attach(contents, sink);
  } catch (error) {
    console.warn('[BrowserView] could not attach to the tab:', error);
    share.leave();
    return { error: 'tab-closed' };
  }
  // The tab may have closed or been unshared while the debugger attached.
  const refusal = viewableContents(registry, webContentsId);
  if (typeof refusal === 'string') {
    sessions.detachSession(relayId);
    share.leave();
    return { error: refusal };
  }

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
  sessions.ready(relayId);
  syncTab();

  return {
    onMessage(raw) {
      if (done) return;
      const message = parseClientMessage(raw);
      if (message) handle(message);
    },
    close: teardown,
  };
}
