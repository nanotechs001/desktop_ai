/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useRef } from 'react';
import { Button, Message, Tooltip } from '@arco-design/web-react';
import { Plus } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import type { TChatConversation } from '@/common/config/storage';
import { getConversationCreateErrorMessage } from '@/renderer/pages/conversation/utils/conversationCreateError';
import { startNewChatLike } from '@/renderer/pages/conversation/utils/startNewChatLike';

/**
 * Returns a click handler that starts an empty chat with the same assistant as `conversation` and hands the new id to
 * `onCreated`. A failure shows an error toast and calls nothing; clicks while one is being made are ignored.
 */
export function useStartNewChat(
  conversation: TChatConversation | null | undefined,
  onCreated: (conversationId: string) => void
): () => Promise<void> {
  const { t } = useTranslation();
  const busyRef = useRef(false);
  return useCallback(async () => {
    if (!conversation || busyRef.current) return;
    busyRef.current = true;
    try {
      const id = await startNewChatLike(conversation);
      if (id) onCreated(id);
      else Message.error(t('conversation.createFailed'));
    } catch (error) {
      console.error('Failed to start a new chat:', error);
      Message.error(getConversationCreateErrorMessage(error, t));
    } finally {
      busyRef.current = false;
    }
  }, [conversation, onCreated, t]);
}

/** Conversation header "+": a new chat with this chat's assistant, then opens it (desktop and WebUI alike). */
export const ConversationNewChatButton: React.FC<{ conversation: TChatConversation }> = ({ conversation }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const open = useCallback(
    (id: string): void => {
      void navigate(`/conversation/${id}`);
    },
    [navigate]
  );
  const start = useStartNewChat(conversation, open);
  const label = t('conversation.welcome.newConversation');
  return (
    <Tooltip content={label}>
      <Button size='mini' aria-label={label} icon={<Plus theme='outline' size='14' />} onClick={() => void start()} />
    </Tooltip>
  );
};
