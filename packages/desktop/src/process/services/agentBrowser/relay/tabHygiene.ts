/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TargetRegistry } from './targetRegistry';

/** A chat keeps at most this many agent tabs the cap may close; the least recently used one goes first. */
export const MAX_AGENT_TABS_PER_CHAT = 3;
/** An agent tab nobody (agent or user) used for this long is closed. */
export const AGENT_TAB_IDLE_MS = 15 * 60_000;
const SWEEP_INTERVAL_MS = 60_000;
/** A close the pane never carried out is forgotten after this, so a later cap or sweep may ask again. */
const CLOSE_PENDING_MS = 10_000;

export type TabHygieneDeps = {
  registry: TargetRegistry;
  /** Asks the pane to close a tab: the path an agent's own `tabs close` takes, so the pane and the phone follow. */
  closeTab(webContentsId: number): void;
  /** The tab the pane last reported on screen, if any; it is never closed. */
  shownTab(): number | null;
  /** True while a phone watches the tab; it is never closed. */
  isStreamed?(webContentsId: number): boolean;
  /** True while a risky-action ask is open on the tab; it is never closed. */
  isConfirming?(webContentsId: number): boolean;
};

export type TabHygiene = {
  /**
   * An agent tab (never a popup window) was claimed or inherited: it is tracked from now on, and its chat's least
   * recently used closable tabs are closed down to the cap. The adopted tab itself is never closed here.
   */
  adopt(webContentsId: number): void;
  /** Stops the idle sweep. */
  close(): void;
};

/**
 * Keeps agents from piling up tabs: a per-chat cap and an idle sweep every minute. Only a closable tab is ever
 * closed: agent-owned, not shared, not on screen, not typed in since its page loaded, not watched by a phone, no
 * risky ask open. "Used" is the registry's last use (an agent command or user input on the tab).
 */
export function startTabHygiene({
  registry,
  closeTab,
  shownTab,
  isStreamed,
  isConfirming,
}: TabHygieneDeps): TabHygiene {
  const agentTabs = new Set<number>();
  /** Asked to close and not gone yet: neither counted nor asked again. */
  const closing = new Set<number>();

  const closable = (webContentsId: number): boolean => {
    const tab = registry.ownership(webContentsId);
    if (!tab || tab.owner === 'user' || tab.sharedWith !== null) return false;
    if (registry.typedSinceLoad(webContentsId) || isStreamed?.(webContentsId) || isConfirming?.(webContentsId)) {
      return false;
    }
    return !closing.has(webContentsId) && webContentsId !== shownTab();
  };
  const chatOf = (webContentsId: number): string | undefined => {
    const owner = registry.ownership(webContentsId)?.owner;
    return owner && owner !== 'user' ? owner.conversationId : undefined;
  };
  const lastUsedAt = (webContentsId: number): number => registry.lastUse(webContentsId)?.at ?? 0;
  const closeNow = (webContentsId: number): void => {
    closing.add(webContentsId);
    setTimeout(() => closing.delete(webContentsId), CLOSE_PENDING_MS).unref?.();
    closeTab(webContentsId);
  };

  const offDestroyed = registry.onDestroyed(({ webContentsId }) => {
    agentTabs.delete(webContentsId);
    closing.delete(webContentsId);
  });

  const sweep = (): void => {
    const now = Date.now();
    for (const webContentsId of agentTabs) {
      if (closable(webContentsId) && now - lastUsedAt(webContentsId) >= AGENT_TAB_IDLE_MS) closeNow(webContentsId);
    }
  };
  const timer = setInterval(sweep, SWEEP_INTERVAL_MS);
  timer.unref?.();

  return {
    adopt(webContentsId) {
      const owner = registry.ownership(webContentsId)?.owner;
      if (!owner || owner === 'user') return;
      agentTabs.add(webContentsId);
      // Already being closed (an earlier adopt of the same takeover chose it): it must not count the others again.
      if (closing.has(webContentsId)) return;
      const chat = owner.conversationId;
      if (!chat) return;
      // A fresh array from filter, so sorting it in place touches nothing else.
      const others = [...agentTabs]
        .filter((id) => id !== webContentsId && chatOf(id) === chat && closable(id))
        .sort((a, b) => lastUsedAt(a) - lastUsedAt(b));
      const excess = others.length - MAX_AGENT_TABS_PER_CHAT + 1;
      if (excess > 0) others.slice(0, excess).forEach(closeNow);
    },
    close() {
      clearInterval(timer);
      offDestroyed();
    },
  };
}
