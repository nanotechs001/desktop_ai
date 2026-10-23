/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import useSWR from 'swr';
import { DEFAULT_AGENT_ID } from '@/common/types/agent/defaultAgent';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';

/**
 * The Agent of a chat, for a chip's settings link: the default Agent for a chat without one. `unresolved` when the
 * chat is gone (its Agent can't be known), `loading` until the chat is read.
 */
export const useChatAgent = (conversationId?: string) => {
  // Shares the chat page's cache entry, so this is no extra request.
  const { data: conversation } = useSWR(conversationId ? `conversation/${conversationId}` : null, () =>
    getConversationOrNull(conversationId!)
  );
  return {
    agentId: conversation?.assistant?.id ?? DEFAULT_AGENT_ID,
    unresolved: conversationId !== undefined && conversation === null,
    loading: conversationId !== undefined && conversation === undefined,
  };
};
