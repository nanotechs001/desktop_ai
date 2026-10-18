/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback } from 'react';
import { ipcBridge } from '@/common';
import type { IConversationMcpStatus, IProvider, TChatConversation, TProviderWithModel } from '@/common/config/storage';
import { usePresetAssistantInfo } from '@/renderer/hooks/agent/usePresetAssistantInfo';
import { resolveCronJobId } from '@/renderer/pages/cron/cronUtils';
import AcpChat from '../platforms/acp/AcpChat';
import AionrsChat from '../platforms/aionrs/AionrsChat';
import { useAionrsModelSelection } from '../platforms/aionrs/useAionrsModelSelection';
import { useActiveLease } from '../hooks/useActiveLease';
import LegacyReadOnlyConversation from '../platforms/legacy/LegacyReadOnlyConversation';
import { useConversationRuntimeView } from '../runtime/useConversationRuntimeView';
import { resolveConversationBackend } from '../utils/conversationAssistantIdentity';
import { isLegacyReadOnlyConversationType } from '../utils/conversationRuntime';
import SingleChatEmptyState from './SingleChatEmptyState';

/**
 * The interactive chat surface of one conversation — message list, tool calls,
 * approvals, send box (mic, stop) — shared by the main conversation page and
 * the floating agent widget. Both mount these same components against the same
 * backend conversation, so there is exactly one message store and one stream.
 */

type AionrsConversation = Extract<TChatConversation, { type: 'aionrs' }>;

const extraList = <K extends 'skills' | 'mcp_servers'>(conversation: TChatConversation, key: K) =>
  (conversation.extra as Record<K, string[] | undefined> | undefined)?.[key];
const extraMcpStatuses = (conversation: TChatConversation) =>
  (conversation.extra as { mcp_statuses?: IConversationMcpStatus[] } | undefined)?.mcp_statuses;

/** ACP / Antigravity / legacy read-only conversations. Returns null for types rendered elsewhere. */
export function renderAcpConversationChat(params: {
  conversation: TChatConversation;
  backend: string | undefined;
  assistantId: string | undefined;
  hideSendBox?: boolean;
}): React.ReactNode {
  const { conversation, backend, assistantId } = params;
  // Greeting shown while the conversation has no messages yet (freshly created
  // or cloned window). Each *Chat forwards it to MessageList's empty slot.
  const emptySlot = <SingleChatEmptyState conversation_id={conversation.id} />;
  if (isLegacyReadOnlyConversationType(conversation.type)) {
    return <LegacyReadOnlyConversation key={conversation.id} conversation={conversation} emptySlot={emptySlot} />;
  }
  switch (conversation.type) {
    case 'acp':
    // Antigravity reports its own conversation type but renders through the
    // ACP chat surface: same extra payload, same event stream, same send box.
    // Without this case it falls to `default: null` — the chat area renders
    // empty, no send box mounts, and the queued initial message in
    // `acp_initial_message_<id>` is never delivered, so the turn never starts.
    case 'antigravity':
      return (
        <AcpChat
          key={conversation.id}
          conversation_id={conversation.id}
          workspace={conversation.extra?.workspace}
          backend={backend || 'claude'}
          session_mode={conversation.extra?.session_mode}
          cron_job_id={resolveCronJobId(conversation.extra)}
          hideSendBox={params.hideSendBox}
          emptySlot={emptySlot}
          loadedSkills={extraList(conversation, 'skills')}
          loadedMcpServers={extraList(conversation, 'mcp_servers')}
          loadedMcpStatuses={extraMcpStatuses(conversation)}
          assistantId={assistantId}
          forkCapability={conversation.fork_capability}
          promptCapability={conversation.prompt_capability}
        ></AcpChat>
      );
    default:
      return null;
  }
}

/**
 * Model selection for an aionrs conversation. Switching models stops the
 * running turn first; the agent is rebuilt with the new model on the next send.
 */
export function useAionrsConversationModel(conversation: AionrsConversation) {
  const runtimeView = useConversationRuntimeView(conversation.id);
  const onSelectModel = useCallback(
    async (_provider: IProvider, modelName: string) => {
      const selected = { ..._provider, use_model: modelName } as TProviderWithModel;
      // Kill running agent on model switch — will be rebuilt with new model on next message
      if (runtimeView.activeTurnId) {
        const result = await ipcBridge.conversation.stop.invoke({
          conversation_id: conversation.id,
          turn_id: runtimeView.activeTurnId,
        });
        runtimeView.markStopAcknowledged(runtimeView.activeTurnId, result.runtime);
      }
      const ok = await ipcBridge.conversation.update.invoke({ id: conversation.id, updates: { model: selected } });
      return Boolean(ok);
    },
    [conversation.id, runtimeView]
  );
  return useAionrsModelSelection({ initialModel: conversation.model, onSelectModel });
}

export function renderAionrsConversationChat(params: {
  conversation: AionrsConversation;
  modelSelection: ReturnType<typeof useAionrsConversationModel>;
  assistantId: string | undefined;
}): React.ReactNode {
  const { conversation } = params;
  return (
    <AionrsChat
      conversation_id={conversation.id}
      workspace={conversation.extra.workspace}
      emptySlot={<SingleChatEmptyState conversation_id={conversation.id} />}
      modelSelection={params.modelSelection}
      session_mode={conversation.extra?.session_mode}
      cron_job_id={resolveCronJobId(conversation.extra)}
      loadedSkills={extraList(conversation, 'skills')}
      loadedMcpServers={extraList(conversation, 'mcp_servers')}
      loadedMcpStatuses={extraMcpStatuses(conversation)}
      assistantId={params.assistantId}
      forkCapability={conversation.fork_capability}
    />
  );
}

const AionrsChatBody: React.FC<{ conversation: AionrsConversation }> = ({ conversation }) => {
  const modelSelection = useAionrsConversationModel(conversation);
  const { info } = usePresetAssistantInfo(conversation);
  return <>{renderAionrsConversationChat({ conversation, modelSelection, assistantId: info?.assistantId })}</>;
};

const AcpChatBody: React.FC<{ conversation: TChatConversation }> = ({ conversation }) => {
  const { info, isLoading } = usePresetAssistantInfo(conversation);
  // Wait for the assistant identity so the chat never mounts with the wrong backend and remounts.
  if (isLoading) return null;
  return (
    <>
      {renderAcpConversationChat({
        conversation,
        backend: resolveConversationBackend(conversation, info?.backend),
        assistantId: info?.assistantId,
      })}
    </>
  );
};

/** Self-contained chat surface for one conversation (used by the floating widget). */
const ConversationChatBody: React.FC<{ conversation: TChatConversation }> = ({ conversation }) => {
  // Same "someone is looking at this conversation" lease the main conversation page holds.
  useActiveLease({ type: 'conversation', id: conversation.id });
  return conversation.type === 'aionrs' ? (
    <AionrsChatBody key={conversation.id} conversation={conversation} />
  ) : (
    <AcpChatBody key={conversation.id} conversation={conversation} />
  );
};

export default ConversationChatBody;
