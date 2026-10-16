/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { usePresetAssistantInfo } from '@renderer/hooks/agent/usePresetAssistantInfo';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { agentFromPresetInfo, getAgentPresentation } from '@/renderer/utils/ui/agentPresentation';

type Props = {
  senderName: string;
  /** Sender teammate's conversation id — enables Agent avatar resolution via conversation extras. */
  senderConversationId?: string;
};

/**
 * Avatar shown next to a teammate's message bubble: the sender's Agent avatar, or the robot icon
 * when it has none. Never the engine's vendor logo.
 */
const TeammateMessageAvatar: React.FC<Props> = ({ senderName, senderConversationId }) => {
  const { t } = useTranslation();
  // Share the SWR key with AgentChatSlot / TeamAgentIdentity so this hits cache
  // instead of firing another fetch for the same conversation.
  const { data: conversation } = useSWR(senderConversationId ? ['team-conversation', senderConversationId] : null, () =>
    getConversationOrNull(senderConversationId!)
  );
  const { info: presetInfo } = usePresetAssistantInfo(conversation ?? undefined);
  const agent = agentFromPresetInfo(presetInfo);
  const { avatar } = getAgentPresentation({ name: agent?.name ?? senderName, avatar: agent?.avatar }, t);

  return (
    <span className='w-20px h-20px rounded-full flex items-center justify-center bg-fill-2 text-t-secondary'>
      {avatar}
    </span>
  );
};

export default TeammateMessageAvatar;
