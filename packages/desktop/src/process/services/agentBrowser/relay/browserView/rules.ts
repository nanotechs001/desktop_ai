/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TabOwnership } from '@/common/types/browser';
import { targetIdFor, type RelayTargetInfo } from '../targetRegistry';

/**
 * A tab the WebUI may list, in the shape `GET /api/browser-view/tabs` returns. `active` marks the one the agent acted on
 * last, which the phone follows.
 */
export type ViewTab = { id: string; title: string; url: string; active?: true };

/** Only agent-owned or agent-shared tabs may be listed, streamed or controlled. */
export const isViewable = (o: TabOwnership): boolean => o.owner !== 'user' || o.sharedWith === 'all';

/**
 * The viewable tabs of `conversationId`: those its agent claimed, and shared user tabs its agent used last
 * (`lastChatOf`, webContentsId → the chat of the last agent that used it), so the phone can watch the page it is
 * asked about. A tab claimed by an MCP that sent no conversation id stays out (fails closed). `actedAt`
 * (webContentsId → when an agent last acted there, higher is later) picks the `active` tab; none before the agent acts
 * on a listed tab.
 */
export const viewableTabs = (
  all: TabOwnership[],
  targets: RelayTargetInfo[],
  conversationId: string,
  actedAt: ReadonlyMap<number, number> = new Map(),
  lastChatOf: (webContentsId: number) => string | undefined = () => undefined
): ViewTab[] => {
  const chatOf = (o: TabOwnership): string | undefined =>
    o.owner === 'user' ? lastChatOf(o.webContentsId) : o.owner.conversationId;
  const listed = all.flatMap((o) => {
    if (!isViewable(o) || chatOf(o) !== conversationId) return [];
    const target = targets.find((t) => t.targetId === targetIdFor(o.webContentsId));
    return target ? [{ webContentsId: o.webContentsId, target }] : [];
  });
  const latest = listed.reduce<{ webContentsId: number; at: number } | null>((best, { webContentsId }) => {
    const at = actedAt.get(webContentsId);
    return at !== undefined && (!best || at > best.at) ? { webContentsId, at } : best;
  }, null);
  return listed.map(({ webContentsId, target: { targetId: id, title, url } }) =>
    webContentsId === latest?.webContentsId ? { id, title, url, active: true } : { id, title, url }
  );
};
