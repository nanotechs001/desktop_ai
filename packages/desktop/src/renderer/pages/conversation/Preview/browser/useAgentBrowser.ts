/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import type { AgentActionEvent, TabOwnership } from '@/common/types/browser';

/** The action feed keeps this many actions per tab, in memory only. */
export const MAX_AGENT_ACTIONS = 50;

/** Longest label kept in the feed; the MCP already bounds labels, this keeps the renderer safe on its own. */
export const MAX_AGENT_LABEL_LENGTH = 200;

/** Returns a new list with `event` added (label cut to {@link MAX_AGENT_LABEL_LENGTH}), trimmed to the newest {@link MAX_AGENT_ACTIONS}. */
export const appendAction = (actions: AgentActionEvent[], event: AgentActionEvent): AgentActionEvent[] =>
  [...actions, { ...event, label: event.label.slice(0, MAX_AGENT_LABEL_LENGTH) }].slice(-MAX_AGENT_ACTIONS);

/**
 * Ownership and recent agent actions of one browser tab, found by its webContentsId.
 * State lives with the tab's viewer, so a closed tab takes its feed with it.
 */
export const useAgentBrowser = (
  webContentsId: number | null
): { ownership: TabOwnership | null; actions: AgentActionEvent[] } => {
  const [ownership, setOwnership] = useState<TabOwnership | null>(null);
  const [actions, setActions] = useState<AgentActionEvent[]>([]);
  const gotEvent = useRef(false);

  useEffect(() => {
    setOwnership(null);
    setActions([]);
    if (webContentsId === null) return;
    gotEvent.current = false;
    let alive = true;
    const find = (list: TabOwnership[]): TabOwnership | null =>
      list.find((entry) => entry.webContentsId === webContentsId) ?? null;

    const offOwnership = ipcBridge.agentBrowser.ownershipChanged.on((list) => {
      gotEvent.current = true;
      setOwnership(find(list));
    });
    const offAction = ipcBridge.agentBrowser.agentAction.on((event) => {
      if (event.webContentsId === webContentsId) setActions((prev) => appendAction(prev, event));
    });
    // Ownership set before this mounted is only available by asking; an event that arrived first is newer.
    void ipcBridge.agentBrowser.getOwnership
      .invoke()
      .then((res) => {
        if (alive && res.success && res.data && !gotEvent.current) setOwnership(find(res.data));
      })
      .catch((error: unknown) => console.warn('[BrowserViewer] could not read tab ownership:', error));

    return () => {
      alive = false;
      offOwnership();
      offAction();
    };
  }, [webContentsId]);

  return { ownership, actions };
};
