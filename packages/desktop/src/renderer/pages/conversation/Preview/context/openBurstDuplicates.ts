/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { BROWSER_BLANK_URL } from '../browser/constants';
import type { PreviewTab } from './PreviewContext';

/** Copies of one open were written within this long of each other (one IPC event, one chat lookup per window). */
export const OPEN_BURST_MS = 2000;

/** The creation time a browser tab id carries (`browser-<ms>-<random>`), or null for any other id. */
const createdAt = (tab: PreviewTab): number | null => {
  const match = /^browser-(\d+)-/.exec(tab.id);
  return match ? Number(match[1]) : null;
};

/**
 * `tabs` without the stored copies of one agent open that robot windows used to write next to the main window's own:
 * browser tabs that started at the same page (not blank) in the same profile, created within {@link OPEN_BURST_MS} of
 * each other. One per burst stays, `keepId` when it is one of them, else the first. Persisted tabs carry neither their
 * agent ownership nor a webContents id, so this signature is all that tells such a copy apart.
 */
export const dropOpenBurstDuplicates = (tabs: PreviewTab[], keepId: string | null): PreviewTab[] => {
  const groups = new Map<string, { tab: PreviewTab; at: number }[]>();
  for (const tab of tabs) {
    const at = createdAt(tab);
    const start = tab.originalContent ?? tab.content;
    if (tab.content_type !== 'browser' || at === null || start === BROWSER_BLANK_URL) continue;
    const key = `${start}\n${JSON.stringify(tab.metadata?.profile ?? null)}`;
    groups.set(key, [...(groups.get(key) ?? []), { tab, at }]);
  }
  const dropped = new Set<string>();
  for (const group of groups.values()) {
    const sorted = group.toSorted((a, b) => a.at - b.at);
    let burst: PreviewTab[] = [];
    let burstStart = Number.NEGATIVE_INFINITY;
    const closeBurst = () => {
      const kept = burst.find((tab) => tab.id === keepId) ?? burst[0];
      for (const tab of burst) if (tab !== kept) dropped.add(tab.id);
    };
    for (const { tab, at } of sorted) {
      if (at - burstStart > OPEN_BURST_MS) {
        closeBurst();
        burst = [];
        burstStart = at;
      }
      burst = [...burst, tab];
    }
    closeBurst();
  }
  return dropped.size === 0 ? tabs : tabs.filter((tab) => !dropped.has(tab.id));
};
