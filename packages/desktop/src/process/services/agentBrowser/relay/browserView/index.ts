/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { DebuggerSessions } from '../debuggerSessions';
import { webContentsIdFromTargetId, type TargetRegistry } from '../targetRegistry';
import { viewableTabs, type ViewTab } from './rules';
import {
  openStreamSession,
  viewableContents,
  type StreamHandle,
  type StreamPeer,
  type StreamRefusal,
  type TabShare,
} from './streamSession';

export type { StreamHandle, StreamPeer, StreamRefusal } from './streamSession';

/** The WebUI's live view of the agent's browser tabs. */
export type BrowserViewService = {
  listTabs(conversationId: string): ViewTab[];
  openStream(tabId: string, peer: StreamPeer): Promise<StreamHandle | { error: StreamRefusal }>;
};

export type BrowserViewDeps = { registry: TargetRegistry; sessions: DebuggerSessions };

export function createBrowserViewService({ registry, sessions }: BrowserViewDeps): BrowserViewService {
  /** Open streams per tab, oldest first. */
  const streams = new Map<number, object[]>();
  let nextSink = 0;

  const join = (webContentsId: number): TabShare => {
    const me = {};
    const list = (): object[] => streams.get(webContentsId) ?? [];
    streams.set(webContentsId, [...list(), me]);
    return {
      paces: () => list()[0] === me,
      alone: () => list().length === 1 && list()[0] === me,
      leave() {
        const left = list().filter((s) => s !== me);
        if (left.length > 0) streams.set(webContentsId, left);
        else streams.delete(webContentsId);
      },
    };
  };

  return {
    listTabs: (conversationId) => viewableTabs(registry.all(), registry.listTargets(), conversationId),
    async openStream(tabId, peer) {
      const webContentsId = webContentsIdFromTargetId(tabId);
      if (webContentsId === null) return { error: 'tab-closed' };
      const contents = viewableContents(registry, webContentsId);
      if (typeof contents === 'string') return { error: contents };
      nextSink += 1;
      const sinkId = `browser-view-${nextSink}`;
      return openStreamSession({ registry, sessions, contents, sinkId, peer, share: join(webContentsId) });
    },
  };
}
