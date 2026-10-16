/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PreviewTab } from './PreviewContext';

/**
 * A browser tab of a scope that is not on screen. Its webview stays mounted (hidden) so a page, and
 * an agent working in it, survive switching to another project's chat.
 */
export type BackgroundTab = {
  scope: string;
  tab: PreviewTab;
  /** When it left the screen; the least recently used user tab is unmounted first. */
  since: number;
};

/** Live webviews across all scopes; beyond this the least recently used user tabs are unmounted. */
export const MAX_LIVE_BROWSER_TABS = 20;

const isBrowserTab = (tab: PreviewTab): boolean => tab.content_type === 'browser';

/**
 * The background with the leaving scope's browser tabs added. Their activity badge is cleared: it is
 * only kept up to date for the scope on screen, and the next agent action lights it again.
 */
export const leaveScope = (
  background: readonly BackgroundTab[],
  scope: string,
  tabs: readonly PreviewTab[],
  now: number
): BackgroundTab[] => [
  ...background,
  ...tabs.filter(isBrowserTab).map((tab) => ({
    scope,
    tab: tab.metadata?.agentActive ? { ...tab, metadata: { ...tab.metadata, agentActive: false } } : tab,
    since: now,
  })),
];

/**
 * The entering scope's tabs, its live background tabs taking the place of their stored copies (they
 * carry the current page and the agent badge), and the background without them.
 */
export const enterScope = (
  background: readonly BackgroundTab[],
  scope: string,
  storedTabs: readonly PreviewTab[]
): { tabs: PreviewTab[]; rest: BackgroundTab[] } => {
  const live = new Map(background.filter((entry) => entry.scope === scope).map((entry) => [entry.tab.id, entry.tab]));
  const storedIds = new Set(storedTabs.map((tab) => tab.id));
  return {
    tabs: [
      ...storedTabs.map((tab) => live.get(tab.id) ?? tab),
      ...[...live.values()].filter((tab) => !storedIds.has(tab.id)),
    ],
    rest: background.filter((entry) => entry.scope !== scope),
  };
};

/**
 * The browser tabs whose webviews stay mounted: every tab of the scope on screen, then background
 * tabs until {@link MAX_LIVE_BROWSER_TABS}, dropping the least recently used user tabs (never an
 * agent's). Sorted by id, so a tab's place among its siblings never changes: moving a `<webview>`
 * in the DOM reloads it.
 */
export const liveBrowserTabs = (
  current: readonly PreviewTab[],
  background: readonly BackgroundTab[],
  max = MAX_LIVE_BROWSER_TABS
): PreviewTab[] => {
  const onScreen = current.filter(isBrowserTab);
  const excess = onScreen.length + background.length - max;
  const evicted = new Set(
    background
      .filter((entry) => !entry.tab.metadata?.agentOwned)
      .toSorted((a, b) => a.since - b.since)
      .slice(0, Math.max(0, excess))
      .map((entry) => entry.tab.id)
  );
  return [...onScreen, ...background.filter((entry) => !evicted.has(entry.tab.id)).map((entry) => entry.tab)].toSorted(
    (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
};
