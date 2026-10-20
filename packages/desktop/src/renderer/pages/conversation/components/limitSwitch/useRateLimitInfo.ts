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
  return info;
}
