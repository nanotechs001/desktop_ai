/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef } from 'react';

/** After the user clicks or types in the pane, agent actions leave the tab on screen alone for this long. */
export const USER_INPUT_GRACE_MS = 3000;

/** Where input counts as the user's work in the pane: the preview panel (tab strip, nav bar, slot) and the browser layer. */
const PANE_SELECTOR = '.preview-panel, [data-browser-tab]';

type FollowAgentTabParams = {
  /** The tabs of the pane on screen (this chat's scope). */
  tabs: ReadonlyArray<{ id: string }>;
  activeTabId: string | null;
  switchTab: (tabId: string) => void;
};

/**
 * Returns the handler for "an agent acted on tab `tabId`": that tab becomes the active one of the pane on screen, unless
 * it is not in this pane (another chat's tab, kept mounted hidden) or the user clicked or typed in the pane within the
 * last {@link USER_INPUT_GRACE_MS}.
 * shortcut: input inside a page reaches the host only as webview focus, which an agent's own clicks cause too, so only
 * host-side clicks and keys in the pane count; upgrade with a main-side user-input signal if in-page typing must hold
 * the tab on screen.
 */
export const useFollowAgentTab = ({
  tabs,
  activeTabId,
  switchTab,
}: FollowAgentTabParams): ((tabId: string) => void) => {
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

  return useCallback((tabId: string) => {
    const current = latest.current;
    if (tabId === current.activeTabId || !current.tabs.some((tab) => tab.id === tabId)) return;
    if (Date.now() - lastInputAt.current < USER_INPUT_GRACE_MS) return;
    current.switchTab(tabId);
  }, []);
};
