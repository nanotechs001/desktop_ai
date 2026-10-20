/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { ipcBridge } from '@/common';
import type { IConversationRateLimitUpdatedEvent } from '@/common/adapter/ipcBridge';

/** The last reading seen per conversation, so reopening a chat shows it before the next one arrives. */
const latestByConversation = new Map<string, IConversationRateLimitUpdatedEvent>();

const SECONDS_TO_MS = 1000;
const hasReset = (resetsAt: number | null, now: number): boolean => resetsAt !== null && resetsAt * SECONDS_TO_MS < now;

/** `event` without its windows that have reset since; null once its own window has (M4): old usage is no warning. */
export function withoutResetWindows(
  event: IConversationRateLimitUpdatedEvent,
  now: number = Date.now()
): IConversationRateLimitUpdatedEvent | null {
  if (hasReset(event.resets_at, now)) return null;
  const windows = event.windows.filter((w) => !hasReset(w.resets_at, now));
  return windows.length === event.windows.length ? event : { ...event, windows };
}

/** The latest plan usage-limit reading for a conversation (pushed live as `conversation.rateLimitUpdated`). */
export function useRateLimitInfo(conversationId: string): IConversationRateLimitUpdatedEvent | null {
  const [info, setInfo] = useState(() => latestByConversation.get(conversationId) ?? null);
  useEffect(() => {
    setInfo(latestByConversation.get(conversationId) ?? null);
    return ipcBridge.conversation.rateLimitUpdated.on((event) => {
      latestByConversation.set(event.conversation_id, event);
      if (event.conversation_id === conversationId) setInfo(event);
    });
  }, [conversationId]);
  // Checked on every render, so a reading kept from before its reset never shows.
  return info ? withoutResetWindows(info) : null;
}
