import type { TChatConversation } from '@/common/config/storage';
import type { PresetAssistantInfo } from '@/renderer/hooks/agent/usePresetAssistantInfo';
import { resolveAssistantAvatar } from '@/renderer/utils/model/assistantAvatar';
import { agentFromPresetInfo, type AgentIdentity } from '@/renderer/utils/ui/agentPresentation';
import type { TFunction } from 'i18next';

/**
 * Resolve the effective runtime backend for a conversation.
 *
 * New assistant-led flows should pass the assistant backend explicitly when it
 * is known. Legacy conversations may still fall back to `extra.backend`.
 */
export function resolveConversationBackend(
  conversation: TChatConversation | undefined,
  presetAssistantBackend?: string
): string | undefined {
  const explicitAssistantBackend = presetAssistantBackend?.trim();
  if (explicitAssistantBackend) {
    return explicitAssistantBackend;
  }

  if (!conversation) return undefined;

  const conversationAssistantBackend = conversation.assistant?.backend?.trim();
  if (conversationAssistantBackend) {
    return conversationAssistantBackend;
  }

  if (conversation.type === 'acp') {
    return conversation.extra?.backend;
  }

  if (conversation.type === 'openclaw-gateway') {
    return conversation.extra?.backend || 'openclaw-gateway';
  }

  if (conversation.type === 'remote') {
    return 'remote';
  }

  return conversation.type;
}

export type ConversationLeadingMark =
  | {
      kind: 'emoji';
      value: string;
      label: string;
    }
  | {
      kind: 'image';
      value: string;
      label: string;
    }
  | {
      kind: 'assistant_fallback';
      label: string;
    };

/**
 * The mark a conversation row shows: its Agent's avatar, or the neutral robot labelled with the
 * Agent name. Never a logo or name derived from the engine behind the chat.
 */
export function resolveConversationLeadingMark(
  conversation: TChatConversation,
  assistantInfo: PresetAssistantInfo | null | undefined,
  t: TFunction
): ConversationLeadingMark {
  const snapshot = conversation.assistant;
  const agent: AgentIdentity | null =
    agentFromPresetInfo(assistantInfo) ??
    (snapshot ? { name: snapshot.name.trim() || snapshot.id, avatar: snapshot.avatar } : null);
  const label = agent?.name || t('agent.displayName');

  const avatar = resolveAssistantAvatar(agent?.avatar);
  if (avatar.kind === 'emoji') return { kind: 'emoji', value: avatar.value, label };
  if (avatar.kind === 'image') return { kind: 'image', value: avatar.value, label };
  return { kind: 'assistant_fallback', label };
}
