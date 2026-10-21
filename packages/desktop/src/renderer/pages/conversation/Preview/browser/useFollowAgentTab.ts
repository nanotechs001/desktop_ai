/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useMemo, useRef } from 'react';

/** After the user clicks or types in the pane, agent actions leave the tab on screen alone for this long. */
export const USER_INPUT_GRACE_MS = 3000;

/** Where input counts as the user's work in the pane: the preview panel (tab strip, nav bar, slot) and the browser layer. */
const PANE_SELECTOR = '.preview-panel, [data-browser-tab]';

const hasTab = (tabs: ReadonlyArray<{ id: string }>, tabId: string): boolean => tabs.some((tab) => tab.id === tabId);

type FollowAgentTabParams = {
  /** The tabs of the pane on screen (this chat's scope). */
  tabs: ReadonlyArray<{ id: string }>;
  activeTabId: string | null;
  switchTab: (tabId: string) => void;
};

type FollowAgentTab = {
  /** An agent acted on `tabId`. */
  onAgentAction: (tabId: string) => void;
  /** The user pressed a key or the mouse inside `tabId`'s page (main's agentBrowser.userInput). */
  onUserInput: (tabId: string) => void;
};

/**
 * Handlers that bring the agent's tab to the front: on an agent action, that tab becomes the active one of the pane on
 * screen, unless it is not in this pane (another chat's tab, kept mounted hidden) or the user was busy in the pane within
 * the last {@link USER_INPUT_GRACE_MS}. Busy means a click or key in the pane's own controls (seen here) or inside the
 * page of any of this pane's tabs (reported by main, which leaves out the agent's own input).
 */
export const useFollowAgentTab = ({ tabs, activeTabId, switchTab }: FollowAgentTabParams): FollowAgentTab => {
  const lastInputAt = useRef(Number.NEGATIVE_INFINITY);
  const latest = useRef({ tabs, activeTabId, switchTab });
  latest.current = { tabs, activeTabId, switchTab };

  useEffect(() => {
    const note = (event: Event) => {
      if (event.target instanceof Element && event.target.closest(PANE_SELECTOR)) lastInputAt.current = Date.now();
    };
    document.addEventListener('pointerdown', note, true);
    document.addEventListener('keydown', note, true);
    return () => {
      document.removeEventListener('pointerdown', note, true);
      document.removeEventListener('keydown', note, true);
    };
  }, []);

  const onAgentAction = useCallback((tabId: string) => {
    const current = latest.current;
    if (tabId === current.activeTabId || !hasTab(current.tabs, tabId)) return;
    if (Date.now() - lastInputAt.current < USER_INPUT_GRACE_MS) return;
    current.switchTab(tabId);
  }, []);

  const onUserInput = useCallback((tabId: string) => {
    if (hasTab(latest.current.tabs, tabId)) lastInputAt.current = Date.now();
  }, []);

  return useMemo(() => ({ onAgentAction, onUserInput }), [onAgentAction, onUserInput]);
};
