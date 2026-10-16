/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { usePresetAssistantInfo } from '@renderer/hooks/agent/usePresetAssistantInfo';
import { agentFromPresetInfo, getAgentPresentation } from '@/renderer/utils/ui/agentPresentation';

type Props = {
  conversation_id: string;
};

/** Edge of the Agent avatar in the 48px tile. */
const AVATAR_SIZE_PX = 32;

/**
 * Empty state shown in a single-chat window that has no messages yet (for
 * example a freshly created or cloned conversation). Renders the chat's Agent
 * (name and avatar, or the neutral "Agent" and robot while it is unknown or
 * still loading) plus a short greeting so the pre-built window is not blank.
 * The chat title is a summary of the first message, never the Agent identity.
 */
const SingleChatEmptyState: React.FC<Props> = ({ conversation_id }) => {
  const { t } = useTranslation();

  // Reuse an SWR-cached read of the conversation record; the send box and chat
  // surface hit the same backend get, so this dedupes rather than refetches.
  const { data: conversation } = useSWR(conversation_id ? ['single-conversation', conversation_id] : null, () =>
    getConversationOrNull(conversation_id)
  );
  const { info: presetInfo } = usePresetAssistantInfo(conversation ?? undefined);

  if (!conversation) return null;

  const { name, avatar } = getAgentPresentation(agentFromPresetInfo(presetInfo), t, AVATAR_SIZE_PX);

  return (
    <div
      data-testid='single-chat-empty-state'
      className='flex flex-col items-center gap-20px px-24px text-center max-w-360px'
    >
      <span className='w-48px h-48px rounded-8px flex items-center justify-center bg-fill-2'>{avatar}</span>
      <div className='flex flex-col gap-6px'>
        <span className='text-16px font-semibold text-t-primary'>{name}</span>
        <span data-testid='single-chat-empty-state-greeting' className='text-13px text-t-secondary'>
          {t('conversation.emptyState.greeting')}
        </span>
      </div>
    </div>
  );
};

export default SingleChatEmptyState;
