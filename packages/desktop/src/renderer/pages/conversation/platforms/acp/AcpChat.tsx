/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IConversationMcpStatus } from '@/common/config/storage';
import { ConversationProvider } from '@/renderer/hooks/context/ConversationContext';
import ConversationPlanBar from '@renderer/pages/conversation/PlanBar/ConversationPlanBar';
import { usePlanRecovery } from '@renderer/pages/conversation/PlanBar/usePlanRecovery';
import { CHAT_SURFACE_CONTAINER_CLASS } from '@/renderer/pages/conversation/utils/chatSurfaceWidth';
import FlexFullContainer from '@renderer/components/layout/FlexFullContainer';
import MessageList from '@renderer/pages/conversation/Messages/MessageList';
import AgentConfirmCards from '@renderer/pages/conversation/components/AgentConfirmCards/AgentConfirmCards';
import { ConversationArtifactProvider } from '@renderer/pages/conversation/Messages/artifacts';
import {
  MessageListLoadingProvider,
  MessageListProvider,
  MessagePaginationProvider,
  useMessageLstCache,
} from '@renderer/pages/conversation/Messages/hooks';
import { usePendingConfirmationsRecovery } from '@renderer/pages/conversation/Messages/usePendingConfirmationsRecovery';
import HOC from '@renderer/utils/ui/HOC';
import React from 'react';
import AcpE2EStreamInjector from './AcpE2EStreamInjector';
import AcpSendBox from './AcpSendBox';
import { useAcpMessage } from './useAcpMessage';

const AcpChat: React.FC<{
  conversation_id: string;
  workspace?: string;
  backend: string;
  session_mode?: string;
  cron_job_id?: string;
  hideSendBox?: boolean;
  emptySlot?: React.ReactNode;
  loadedSkills?: string[];
  loadedMcpServers?: string[];
  loadedMcpStatuses?: IConversationMcpStatus[];
  assistantId?: string;
  forkCapability?: { at_turn: boolean };
  promptCapability?: { image: boolean; audio: boolean };
}> = ({
  conversation_id,
  workspace,
  backend,
  session_mode,
  cron_job_id,
  hideSendBox,
  emptySlot,
  loadedSkills,
  loadedMcpServers,
  loadedMcpStatuses,
  assistantId,
  forkCapability,
  promptCapability,
}) => {
  useMessageLstCache(conversation_id);
  usePendingConfirmationsRecovery(conversation_id);
  usePlanRecovery(conversation_id);
  const messageState = useAcpMessage(conversation_id);

  return (
    <ConversationProvider
      value={{
        conversation_id: conversation_id,
        workspace,
        type: 'acp',
        cron_job_id,
        hideSendBox,
        loadedSkills,
        loadedMcpServers,
        loadedMcpStatuses,
        assistantId,
        forkCapability,
        promptCapability,
      }}
    >
      <ConversationArtifactProvider conversation_id={conversation_id}>
        <div className={`${CHAT_SURFACE_CONTAINER_CLASS} flex-1 flex flex-col px-20px min-h-0`}>
          <FlexFullContainer>
            <MessageList className='flex-1' emptySlot={emptySlot} />
          </FlexFullContainer>
          <AgentConfirmCards conversationId={conversation_id} />
          <AcpE2EStreamInjector conversationId={conversation_id} />
          <ConversationPlanBar conversation_id={conversation_id} />
          {!hideSendBox && (
            <AcpSendBox
              conversation_id={conversation_id}
              backend={backend}
              session_mode={session_mode}
              messageState={messageState}
            ></AcpSendBox>
          )}
        </div>
      </ConversationArtifactProvider>
    </ConversationProvider>
  );
};

export default HOC.Wrapper(MessageListProvider, MessageListLoadingProvider, MessagePaginationProvider)(AcpChat);
