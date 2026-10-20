/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import type {
  IProvider,
  TChatConversation,
  TConversationAssistantIdentity,
  TProviderWithModel,
} from '@/common/config/storage';
import { ENGINE_CHANGE_DEFAULTS_RESET, persistEnginePin } from '@/renderer/hooks/agent/useDefaultEngine';
import { loadLatestConversationMessages, MAX_MESSAGE_PAGE_LIMIT } from '@/renderer/utils/chat/messagePagination';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';
import { isEngineEntry } from '@/renderer/utils/ui/agentPresentation';
import { getConversationOrNull } from '../../utils/conversationCache';
import { startNewChatLike } from '../../utils/startNewChatLike';
import { buildHandoffMessage, type HandoffLabels } from './handoffMessage';
import type { SwitchTarget } from './switchTargets';

/**
 * The bot a switch re-pins: any Agent, the default Agent included (pinning it moves only that bot; the default
 * engine stays). An engine's own generated entry is not a bot: its chat moves to the target engine's entry instead.
 */
export function pinnableAssistantId(conversation: TChatConversation): string | null {
  const assistant = conversation.assistant;
  return assistant?.id && !isEngineEntry(assistant) ? assistant.id : null;
}

/** The target engine's own generated entry, as a conversation identity; throws when the engine has none. */
async function engineEntryIdentity(engine: ManagedAgent): Promise<TConversationAssistantIdentity> {
  const entry = (await ipcBridge.assistants.list.invoke()).find(
    (assistant) => isEngineEntry(assistant) && assistant.agent_id === engine.id
  );
  if (!entry) throw new Error(`Engine ${engine.id} has no entry of its own`);
  return {
    id: entry.id,
    source: entry.source,
    name: entry.name,
    avatar: entry.avatar ?? '',
    backend: entry.agent?.acp_backend || entry.agent?.type || engine.backend || '',
  };
}

/**
 * Pin a bot to `engineId` and re-bind its record, as the default-engine sync does (model, permission and thought
 * level go back to auto). Returns an undo that restores the previous pin, engine and those defaults.
 */
async function pinAssistant(assistantId: string, engineId: string): Promise<() => Promise<void>> {
  const previousPin = configService.get('agent.enginePins')?.[assistantId] ?? null;
  const detail = await ipcBridge.assistants.get.invoke({ id: assistantId });
  await persistEnginePin(assistantId, engineId);
  try {
    await ipcBridge.assistants.update.invoke({
      id: assistantId,
      agent_id: engineId,
      defaults: ENGINE_CHANGE_DEFAULTS_RESET,
    });
  } catch (error) {
    await persistEnginePin(assistantId, previousPin);
    throw error;
  }
  return async () => {
    const { model, permission, thought_level } = detail.defaults;
    await ipcBridge.assistants.update.invoke({
      id: assistantId,
      agent_id: detail.engine.agent_id,
      defaults: { model, permission, thought_level },
    });
    await persistEnginePin(assistantId, previousPin);
  };
}

/** The selection the chat model selector stores: the provider plus the chosen model. */
const toProviderModel = ({ models: _models, ...provider }: IProvider, model: string): TProviderWithModel => ({
  ...provider,
  use_model: model,
});

type SwitchAndContinueParams = { conversationId: string; target: SwitchTarget; labels: HandoffLabels };

/**
 * Continue a chat that hit a usage limit on another engine or model: re-pin this bot (only; an engine chat moves to
 * the target engine's own entry instead), create a new chat like this one, and stash a handoff of the recent conversation as its first message, which the chat sends when it opens.
 * The old chat stays as it is. On failure nothing is stashed, the pin is rolled back and the error is rethrown.
 */
export async function switchAndContinue({ conversationId, target, labels }: SwitchAndContinueParams): Promise<string> {
  const conversation = await getConversationOrNull(conversationId);
  if (!conversation) throw new Error(`Conversation ${conversationId} not found`);
  const page = await loadLatestConversationMessages(conversationId, {
    limit: MAX_MESSAGE_PAGE_LIMIT,
    contentMode: 'full',
  });
  const handoff = buildHandoffMessage(page.items, labels);

  const currentEngineId = (conversation.extra as { agent_id?: string } | undefined)?.agent_id;
  const sameModelEngine = target.kind === 'model' && conversation.type === 'aionrs';
  const engineChanges = !sameModelEngine && target.engine.id !== currentEngineId;
  const assistantId = engineChanges ? pinnableAssistantId(conversation) : null;
  const onEngineEntry = engineChanges && conversation.assistant && !assistantId;
  const entry = onEngineEntry ? await engineEntryIdentity(target.engine) : undefined;
  const undoPin = assistantId ? await pinAssistant(assistantId, target.engine.id) : null;
  try {
    const id = await startNewChatLike(conversation, {
      engine: engineChanges ? target.engine : undefined,
      assistant: entry,
      model: target.kind === 'model' ? toProviderModel(target.provider, target.model) : undefined,
    });
    if (!id) throw new Error('The backend created no conversation');
    const initialMessageKind = target.engine.agent_type === 'aionrs' ? 'aionrs' : 'acp';
    sessionStorage.setItem(`${initialMessageKind}_initial_message_${id}`, JSON.stringify({ input: handoff }));
    return id;
  } catch (error) {
    await undoPin?.().catch((undoError: unknown) => {
      console.error('[limitSwitch] Could not roll back the engine pin:', undoError);
    });
    throw error;
  }
}
