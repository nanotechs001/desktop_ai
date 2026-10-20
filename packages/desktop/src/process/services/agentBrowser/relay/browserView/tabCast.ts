/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DebuggerSessions, RelayEvent } from '../debuggerSessions';
import type { RelayContents } from '../targetRegistry';
import { ALLOWED_VIEWER_METHODS, frameMetaSchema, type FrameMeta } from './protocol';

export type CastFrame = { meta: FrameMeta; jpeg: Buffer };

/** One phone watching the tab. */
export type CastViewer = {
  show(frame: CastFrame): void;
  /** The tab's debugger session ended under the viewer. */
  gone(): void;
};

/** A tab's one screencast (a tab has one debugger, so one CDP client), shared by every phone watching it. */
export type TabCast = {
  /** Resolves false when the debugger could not attach or detached meanwhile. */
  readonly ready: Promise<boolean>;
  join(viewer: CastViewer): void;
  /** The viewer's phone said hello: it casts from now on, at `width × dpr` device px at most. */
  hello(viewer: CastViewer, width: number, dpr: number): void;
  /** The viewer's phone decoded the frame it shows. */
  ack(viewer: CastViewer): void;
  leave(viewer: CastViewer): void;
  /** Sends a viewer command on the tab's session. */
  send(method: string, params: Record<string, unknown>): void;
};

export type TabCastDeps = {
  sessions: DebuggerSessions;
  contents: RelayContents;
  sinkId: string;
  /** The cast ended (last viewer left, or the session went); the owner forgets it. */
  onEnd(): void;
};

type Frame = CastFrame & { ackId: number; seq: number };
/** `maxWidth` null: not casting yet. `seen`: seq of the last frame shown; `busy`: the phone has not acked it. */
type ViewerState = { maxWidth: number | null; seen: number; busy: boolean };

const MAX_WIDTH_PX = 1280;
const JPEG_QUALITY = 55;

const logCommandError = (error: unknown): void => {
  console.warn('[BrowserView] viewer command failed:', error);
};

const frameOf = (params: Record<string, unknown>, seq: number): Frame | null => {
  const meta = frameMetaSchema.safeParse(params.metadata);
  const { data, sessionId } = params;
  if (!meta.success || typeof data !== 'string' || typeof sessionId !== 'number') return null;
  return { meta: meta.data, jpeg: Buffer.from(data, 'base64'), ackId: sessionId, seq };
};

/**
 * Back-pressure (ruling R3): every frame's CDP ack is owed until a casting phone acks a frame newer than the last
 * flush, which sends every owed ack at once; so the fastest phone paces Chrome and a slower one only ever gets the
 * newest frame when it acks. A frame is never acked just because a newer one replaced it.
 */
export function createTabCast({ sessions, contents, sinkId, onEnd }: TabCastDeps): TabCast {
  const viewers = new Map<CastViewer, ViewerState>();
  let relayId = '';
  let ended = false;
  let seq = 0;
  let newest: Frame | null = null;
  let owed: number[] = [];
  let flushedThrough = 0;
  /** The `maxWidth` the screencast runs at; null when stopped. */
  let castWidth: number | null = null;

  const live = (): boolean => !ended && relayId !== '' && sessions.session(relayId) !== null && !contents.isDestroyed();
  const send = (method: string, params: Record<string, unknown>): void => {
    if (!ALLOWED_VIEWER_METHODS.has(method)) throw new Error(`${method} is not allowed for the browser view`);
    if (live()) sessions.send(relayId, method, params).catch(logCommandError);
  };

  const flush = (): void => {
    owed.forEach((ackId) => send('Page.screencastFrameAck', { sessionId: ackId }));
    owed = [];
    flushedThrough = seq;
  };
  /** Shows the newest frame to every casting phone that is free and has not seen it. */
  const pump = (): void => {
    if (!newest) return;
    const frame = newest;
    viewers.forEach((state, viewer) => {
      if (state.maxWidth === null || state.busy || state.seen >= frame.seq) return;
      viewers.set(viewer, { ...state, seen: frame.seq, busy: true });
      viewer.show({ meta: frame.meta, jpeg: frame.jpeg });
    });
  };

  /** Casts at the widest phone's width, restarting only when that changes; stops when nobody casts. */
  const retune = (): void => {
    const widths = Array.from(viewers.values(), (s) => s.maxWidth).filter((w): w is number => w !== null);
    const width = widths.length > 0 ? Math.max(...widths) : null;
    if (width === castWidth) return;
    if (width === null) {
      flush();
      send('Page.stopScreencast', {});
      newest = null;
    } else {
      send('Page.startScreencast', { format: 'jpeg', quality: JPEG_QUALITY, maxWidth: width });
    }
    castWidth = width;
  };

  const end = (): void => {
    if (ended) return;
    ended = true;
    onEnd();
  };
  const onGone = (): void => {
    end();
    Array.from(viewers.keys()).forEach((viewer) => viewer.gone());
  };

  const sink = {
    id: sinkId,
    emit(event: RelayEvent): void {
      if (ended) return;
      if (event.method === 'Target.detachedFromTarget' && event.params.sessionId === relayId) return onGone();
      if (event.method !== 'Page.screencastFrame' || event.sessionId !== relayId) return;
      const frame = frameOf(event.params, seq + 1);
      if (!frame) return;
      seq = frame.seq;
      owed = [...owed, frame.ackId];
      newest = frame;
      pump();
    },
  };

  const ready = sessions.attach(contents, sink).then(
    (id) => {
      relayId = id;
      sessions.ready(id);
      // The debugger may have detached while it attached; and everyone may have left meanwhile.
      if (sessions.session(id) === null) end();
      else if (viewers.size === 0) leaveLast();
      return !ended;
    },
    (error: unknown) => {
      console.warn('[BrowserView] could not attach to the tab:', error);
      end();
      return false;
    }
  );

  function leaveLast(): void {
    retune();
    if (live()) sessions.detachSession(relayId);
    end();
  }

  return {
    ready,
    join(viewer) {
      viewers.set(viewer, { maxWidth: null, seen: 0, busy: false });
    },
    hello(viewer, width, dpr) {
      const state = viewers.get(viewer);
      if (!state || ended) return;
      viewers.set(viewer, { ...state, maxWidth: Math.min(MAX_WIDTH_PX, Math.round(width * dpr)) });
      retune();
      pump();
    },
    ack(viewer) {
      const state = viewers.get(viewer);
      if (!state || state.maxWidth === null || !state.busy) return;
      viewers.set(viewer, { ...state, busy: false });
      if (state.seen > flushedThrough) flush();
      pump();
    },
    leave(viewer) {
      if (!viewers.delete(viewer) || ended || relayId === '') return;
      if (viewers.size === 0) leaveLast();
      else retune();
    },
    send,
  };
}
