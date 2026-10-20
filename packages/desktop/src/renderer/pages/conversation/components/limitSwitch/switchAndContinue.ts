/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import type { IProvider, TChatConversation, TProviderWithModel } from '@/common/config/storage';
import { DEFAULT_AGENT_SETTING_KEY, isUndeletableAgent } from '@/common/types/agent/defaultAgent';
import { ENGINE_CHANGE_DEFAULTS_RESET, persistEnginePin } from '@/renderer/hooks/agent/useDefaultEngine';
import { loadLatestConversationMessages, MAX_MESSAGE_PAGE_LIMIT } from '@/renderer/utils/chat/messagePagination';
import { isEngineEntry } from '@/renderer/utils/ui/agentPresentation';
import { getConversationOrNull } from '../../utils/conversationCache';
import { startNewChatLike } from '../../utils/startNewChatLike';
import { buildHandoffMessage, type HandoffLabels } from './handoffMessage';
import type { SwitchTarget } from './switchTargets';

/**
 * The bot a switch may re-pin: the user's own Agent. Not an engine's generated entry, and not the default Agent,
 * which follows the default engine; for those the switch applies to the new chat only.
 */
export function pinnableAssistantId(conversation: TChatConversation): string | null {
  const assistant = conversation.assistant;
  if (!assistant?.id || isEngineEntry(assistant)) return null;
  return isUndeletableAgent(assistant.id, configService.get(DEFAULT_AGENT_SETTING_KEY)) ? null : assistant.id;
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
 * Continue a chat that hit a usage limit on another engine or model: re-pin this bot (only), create a new chat like
 * this one, and stash a handoff of the recent conversation as its first message, which the chat sends when it opens.
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
  const undoPin = assistantId ? await pinAssistant(assistantId, target.engine.id) : null;
  try {
    const id = await startNewChatLike(conversation, {
      engine: engineChanges ? target.engine : undefined,
      detachAssistant: engineChanges && !assistantId,
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
