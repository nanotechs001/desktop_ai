/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback } from 'react';

import type { TChatConversation } from '@/common/config/storage';
import { DEFAULT_AGENT_SETTING_KEY, isVaBotAgent } from '@/common/types/agent/defaultAgent';
import { useConfig } from '@/renderer/hooks/config/useConfig';

/** Filter for the main agent's chats: VA Bots keep their conversations in their own history. */
export const useRegularChatsOnly = (): ((conversation: TChatConversation) => boolean) => {
  const [storedDefaultAgentId] = useConfig(DEFAULT_AGENT_SETTING_KEY);
  return useCallback(
    (conversation: TChatConversation) => !isVaBotAgent(conversation.assistant, storedDefaultAgentId),
    [storedDefaultAgentId]
  );
};
