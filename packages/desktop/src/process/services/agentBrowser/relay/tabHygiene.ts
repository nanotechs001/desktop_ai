/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { DEFAULT_AGENT_ID } from '@/common/types/agent/defaultAgent';
import type { TargetRegistry } from './targetRegistry';

/**
 * A chat keeps at most this many agent tabs the cap may close; the least recently used one goes first. A VA Bot's tabs
 * are shared by its chats instead, and only the bot cap ({@link MAX_BOT_TABS}) trims them.
 */
export const MAX_AGENT_TABS_PER_CHAT = 3;
/** An agent tab nobody (agent or user) used for this long is closed. */
export const AGENT_TAB_IDLE_MS = 15 * 60_000;
/** A VA Bot's one browser (its profile) keeps at most this many tabs, user and agent tabs together. */
export const MAX_BOT_TABS = 5;
/** A bot tab with no user input, agent action or time on screen for this long may go once the bot is over its cap. */
export const BOT_TAB_IDLE_MS = 15 * 60_000;
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
  /** True while a "Leave site?" ask is open on the tab; it is never closed. */
  isLeaving?(webContentsId: number): boolean;
  /** True for a tab of the pane (not a popup window): only those count toward, and are closed by, the bot cap. */
  isPaneTab?(webContentsId: number): boolean;
  /** Whether the chat's agent turn is running now; its tabs are never closed by the bot cap. Rejecting keeps them. */
  isTurnRunning?(conversationId: string): Promise<boolean>;
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
 * Keeps agents from piling up tabs: a per-chat cap and an idle sweep every minute, plus a cap of {@link MAX_BOT_TABS}
 * on each VA Bot's whole browser (see `trimBotTabs`). Only a closable tab is ever
 * closed: agent-owned, not shared, not on screen, not typed in since its page loaded, not watched by a phone, no
 * risky ask open. "Used" is the registry's last use (an agent command or user input on the tab).
 */
export function startTabHygiene({
  registry,
  closeTab,
  shownTab,
  isStreamed,
  isConfirming,
  isLeaving,
  isPaneTab,
  isTurnRunning,
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

  /** The bot cap may close any tab of the bot's browser, the user's too, but never one still in use or worth keeping. */
  const botCapClosable = (webContentsId: number, now: number): boolean =>
    !closing.has(webContentsId) &&
    webContentsId !== shownTab() &&
    !registry.typedSinceLoad(webContentsId) &&
    !isStreamed?.(webContentsId) &&
    !isConfirming?.(webContentsId) &&
    !isLeaving?.(webContentsId) &&
    now - lastUsedAt(webContentsId) >= BOT_TAB_IDLE_MS;
  /** The chat whose agent drives the tab: its owner's, else (a user tab) the last agent's that used it. */
  const drivingChat = (webContentsId: number): string | undefined =>
    chatOf(webContentsId) ?? registry.lastUse(webContentsId)?.conversationId;
  const turnRunning = async (webContentsId: number): Promise<boolean> => {
    const chat = drivingChat(webContentsId);
    if (!chat || !isTurnRunning) return false;
    return isTurnRunning(chat).catch((error: unknown) => {
      console.warn('[TabHygiene] could not tell whether a chat is working; its tab stays:', error);
      return true;
    });
  };

  /** A tab of a VA Bot's own browser (not the default Agent's shared fallback profile, nor a temporary one). */
  const isBotTab = (webContentsId: number): boolean => {
    const profile = registry.ownership(webContentsId)?.profile;
    return profile?.kind === 'agent' && profile.agentId !== DEFAULT_AGENT_ID;
  };

  /** Each VA Bot's open pane tabs (not the default Agent's shared fallback profile, nor any temporary one). */
  const botTabSets = (): number[][] => {
    const byBot = new Map<string, number[]>();
    for (const { webContentsId, profile } of registry.all()) {
      if (profile.kind !== 'agent' || profile.agentId === DEFAULT_AGENT_ID) continue;
      if (closing.has(webContentsId) || isPaneTab?.(webContentsId) === false) continue;
      byBot.set(profile.agentId, [...(byBot.get(profile.agentId) ?? []), webContentsId]);
    }
    return [...byBot.values()];
  };
  const trimBotTabs = async (now: number): Promise<void> => {
    for (const tabs of botTabSets()) {
      let excess = tabs.length - MAX_BOT_TABS;
      const idle = tabs.filter((id) => botCapClosable(id, now)).toSorted((a, b) => lastUsedAt(a) - lastUsedAt(b));
      for (const webContentsId of idle) {
        if (excess <= 0) break;
        // oxlint-disable-next-line no-await-in-loop -- one at a time: each answer decides whether another must go
        if ((await turnRunning(webContentsId)) || !botCapClosable(webContentsId, Date.now())) continue;
        closeNow(webContentsId);
        excess -= 1;
      }
    }
  };

  let trimming = false;
  const sweep = (): void => {
    const now = Date.now();
    // Time on screen is use: the tab shown now was looked at until this sweep at least.
    const shown = shownTab();
    if (shown !== null) registry.touch(shown);
    for (const webContentsId of agentTabs) {
      if (closable(webContentsId) && now - lastUsedAt(webContentsId) >= AGENT_TAB_IDLE_MS) closeNow(webContentsId);
    }
    if (trimming) return;
    trimming = true;
    trimBotTabs(now)
      .catch((error: unknown) => console.warn("[TabHygiene] could not trim a bot's tabs:", error))
      .finally(() => {
        trimming = false;
      });
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
      if (!chat || isBotTab(webContentsId)) return;
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
