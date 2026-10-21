/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DebuggerSessions } from '../debuggerSessions';
import { webContentsIdFromTargetId, type RelayContents, type TargetRegistry } from '../targetRegistry';
import { viewableTabs, type ViewTab } from './rules';
import {
  createStream,
  viewableContents,
  type Stream,
  type StreamHandle,
  type StreamPeer,
  type StreamRefusal,
} from './streamSession';
import { createTabCast, type TabCast } from './tabCast';

export type { StreamHandle, StreamPeer, StreamRefusal } from './streamSession';

/** The WebUI's live view of the agent's browser tabs. */
export type BrowserViewService = {
  listTabs(conversationId: string): ViewTab[];
  openStream(tabId: string, peer: StreamPeer): Promise<StreamHandle | { error: StreamRefusal }>;
  /** Ends every open stream, e.g. when agent browser control turns off. */
  closeAll(reason: StreamRefusal): void;
  /** True while a phone watches (or is starting to watch) the tab. */
  isStreamed(webContentsId: number): boolean;
  /** An agent acted on the tab (AionRelay.reportAction): the phone's live view follows it (listTabs marks it active). */
  noteAgentAction(webContentsId: number): void;
};

export type BrowserViewDeps = { registry: TargetRegistry; sessions: DebuggerSessions };

export function createBrowserViewService({ registry, sessions }: BrowserViewDeps): BrowserViewService {
  /** One cast (one debugger session) per tab, while any stream watches it. */
  const casts = new Map<number, TabCast>();
  const streams = new Set<Stream>();
  /** The order agents last acted on each open tab in (higher is later). */
  const actedAt = new Map<number, number>();
  let actions = 0;
  registry.onDestroyed((last) => actedAt.delete(last.webContentsId));
  let nextSink = 0;

  const castFor = (contents: RelayContents): TabCast => {
    const existing = casts.get(contents.id);
    if (existing) return existing;
    nextSink += 1;
    const cast = createTabCast({
      sessions,
      contents,
      sinkId: `browser-view-${nextSink}`,
      onEnd: () => {
        if (casts.get(contents.id) === cast) casts.delete(contents.id);
      },
    });
    casts.set(contents.id, cast);
    return cast;
  };

  return {
    listTabs: (conversationId) => viewableTabs(registry.all(), registry.listTargets(), conversationId, actedAt),
    async openStream(tabId, peer) {
      const webContentsId = webContentsIdFromTargetId(tabId);
      if (webContentsId === null) return { error: 'tab-closed' };
      const contents = viewableContents(registry, webContentsId);
      if (typeof contents === 'string') return { error: contents };
      const cast = castFor(contents);
      const stream = createStream({ registry, cast, webContentsId, peer, onClose: () => streams.delete(stream) });
      // Tracked before the attach settles, so closeAll ends a stream that is still attaching (it refuses below).
      streams.add(stream);
      const ready = await cast.ready;
      // The tab may have closed or been unshared while the debugger attached.
      const now = viewableContents(registry, webContentsId);
      const refusal = !ready || stream.isDone() ? 'tab-closed' : typeof now === 'string' ? now : null;
      if (refusal) {
        stream.close();
        return { error: refusal };
      }
      stream.start();
      return { onMessage: stream.onMessage, close: stream.close };
    },
    closeAll(reason) {
      Array.from(streams).forEach((stream) => stream.end(reason));
    },
    isStreamed: (webContentsId) => casts.has(webContentsId),
    noteAgentAction: (webContentsId) => {
      actions += 1;
      actedAt.set(webContentsId, actions);
    },
  };
}
