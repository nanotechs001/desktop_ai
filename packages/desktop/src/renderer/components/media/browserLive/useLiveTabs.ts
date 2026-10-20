/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';

/** A desktop tab the WebUI may watch, as `GET /api/browser-view/tabs` lists it. */
export type LiveTab = { id: string; title: string; url: string; paused: boolean };

const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The stream route's own rule for a tab id. */
const TAB_ID = /^wc-\d{1,9}$/;
const POLL_MS = 5000;

export const isWatchableConversation = (id: string | null): id is string => id !== null && CONVERSATION_ID.test(id);

const parseTab = (tab: unknown): LiveTab | null => {
  if (typeof tab !== 'object' || tab === null) return null;
  const { id, title, url, paused } = tab as Record<string, unknown>;
  if (typeof id !== 'string' || !TAB_ID.test(id)) return null;
  return {
    id,
    title: typeof title === 'string' ? title : '',
    url: typeof url === 'string' ? url : '',
    paused: paused === true,
  };
};

const parseTabs = (body: unknown): LiveTab[] => {
  const tabs = typeof body === 'object' && body !== null ? (body as { tabs?: unknown }).tabs : undefined;
  if (!Array.isArray(tabs)) return [];
  return tabs.map(parseTab).filter((tab): tab is LiveTab => tab !== null);
};

/**
 * The conversation's watchable desktop tabs, asked for at once and every 5 s while the page is visible. Null until the
 * first answer (and when `conversationId` is null or not a valid id); `generation` asks again from scratch.
 */
export const useLiveTabs = (conversationId: string | null, generation = 0): LiveTab[] | null => {
  const [tabs, setTabs] = useState<LiveTab[] | null>(null);

  useEffect(() => {
    if (!isWatchableConversation(conversationId)) return;
    let live = true;
    setTabs(null);
    const load = (): void => {
      if (document.visibilityState === 'hidden') return;
      fetch(`/api/browser-view/tabs?conversation=${encodeURIComponent(conversationId)}`, { credentials: 'include' })
        .then((response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return response.json() as Promise<unknown>;
        })
        .then((body) => {
          if (live) setTabs(parseTabs(body));
        })
        .catch((error: unknown) => {
          console.warn('[BrowserLiveView] could not list the browser tabs:', error);
          // A failed refresh keeps the last list; only a first failure means "nothing to watch".
          if (live) setTabs((current) => current ?? []);
        });
    };
    const onVisibilityChange = (): void => {
      if (document.visibilityState === 'visible') load();
    };
    load();
    const timer = setInterval(load, POLL_MS);
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [conversationId, generation]);

  return tabs;
};
