/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TabOwnership } from '@/common/types/browser';
import { targetIdFor, type RelayTargetInfo } from '../targetRegistry';

/** A tab the WebUI may list, in the shape `GET /api/browser-view/tabs` returns. */
export type ViewTab = { id: string; title: string; url: string };

/** Only agent-owned or agent-shared tabs may be listed, streamed or controlled. */
export const isViewable = (o: TabOwnership): boolean => o.owner !== 'user' || o.sharedWith === 'all';

/**
 * The viewable tabs the agent of `conversationId` claimed. A shared user tab has no conversation, so it never lists
 * here; a tab claimed by an MCP that sent no conversation id stays out too (fails closed).
 */
export const viewableTabs = (all: TabOwnership[], targets: RelayTargetInfo[], conversationId: string): ViewTab[] =>
  all.flatMap((o) => {
    if (!isViewable(o) || o.owner === 'user' || o.owner.conversationId !== conversationId) return [];
    const target = targets.find((t) => t.targetId === targetIdFor(o.webContentsId));
    return target ? [{ id: target.targetId, title: target.title, url: target.url }] : [];
  });
