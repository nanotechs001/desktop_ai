/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import { isYoloMode } from '@/common/config/constants';
import type {
  IProvider,
  TChatConversation,
  TConversationAssistantIdentity,
  TProviderWithModel,
} from '@/common/config/storage';
import {
  ENGINE_CHANGE_DEFAULTS_RESET,
  enginePinOrigin,
  persistEnginePin,
  reloadEnginePins,
} from '@/renderer/hooks/agent/useDefaultEngine';
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

/** The generic bypass alias aioncore maps to each engine's own `yolo_id` (`normalize_requested_mode`). */
const YOLO_ALIAS = 'yolo';

/** True when the chat skips every permission ask: its live runtime's mode, else the mode it stored. */
async function runsInBypassMode(conversation: TChatConversation): Promise<boolean> {
  const runtime = await ipcBridge.conversation.runtimeMode
    .invoke({ conversation_id: conversation.id })
    .catch((error: unknown): null => {
      console.warn('[limitSwitch] Could not read the chat permission mode; using the stored one:', error);
      return null;
    });
  const stored = (conversation.extra as { session_mode?: string } | undefined)?.session_mode;
  return isYoloMode(runtime?.live ? runtime.mode : stored);
}

/**
 * Pin a bot to `engineId` and re-bind its record, as the default-engine sync does (model, permission and thought
 * level go back to auto; the permission is `permission` when given). The pin is tagged `limit`: the next
 * default-engine change releases it (ruling R17). Returns an undo that restores the previous pin (and its origin),
 * engine and those defaults.
 */
async function pinAssistant(assistantId: string, engineId: string, permission?: string): Promise<() => Promise<void>> {
  await reloadEnginePins();
  const previousPin = configService.get('agent.enginePins')?.[assistantId] ?? null;
  const previousOrigin = enginePinOrigin(assistantId);
  const detail = await ipcBridge.assistants.get.invoke({ id: assistantId });
  await persistEnginePin(assistantId, engineId, 'limit');
  try {
    await ipcBridge.assistants.update.invoke({
      id: assistantId,
      agent_id: engineId,
      defaults: permission
        ? { ...ENGINE_CHANGE_DEFAULTS_RESET, permission: { mode: 'fixed', value: permission } }
        : ENGINE_CHANGE_DEFAULTS_RESET,
    });
  } catch (error) {
    await persistEnginePin(assistantId, previousPin, previousOrigin);
    throw error;
  }
  return async () => {
    const { model, permission, thought_level } = detail.defaults;
    await ipcBridge.assistants.update.invoke({
      id: assistantId,
      agent_id: detail.engine.agent_id,
      defaults: { model, permission, thought_level },
    });
    await persistEnginePin(assistantId, previousPin, previousOrigin);
  };
}

/** The selection the chat model selector stores: the provider plus the chosen model. */
const toProviderModel = ({ models: _models, ...provider }: IProvider, model: string): TProviderWithModel => ({
  ...provider,
  use_model: model,
});

type SwitchAndContinueParams = { conversationId: string; target: SwitchTarget; labels: HandoffLabels };

/**
 * Hands `handoff` to the new chat: stashed as its first message, which the chat sends when it opens; when the stash
 * cannot be written (storage full or blocked), sent to the backend right away instead (M7).
 */
async function deliverHandoff(id: string, kind: 'acp' | 'aionrs', handoff: string): Promise<void> {
  try {
    sessionStorage.setItem(`${kind}_initial_message_${id}`, JSON.stringify({ input: handoff }));
  } catch (stashError) {
    console.warn('[limitSwitch] Could not stash the handoff, sending it now:', stashError);
    await ipcBridge.conversation.sendMessage.invoke({ input: handoff, conversation_id: id, files: [] });
  }
}

/**
 * Continue a chat on another engine or model (after a usage limit, or when the user chooses to): re-pin this bot (only; an engine chat moves to
 * the target engine's own entry instead), create a new chat like this one, and give it a handoff of the recent
 * conversation as its first message. The old chat stays as it is. On failure nothing is left behind: the new chat, if
 * created, is removed (never an empty chat), the pin is rolled back and the error is rethrown.
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
  // A bypass chat stays one on an engine that has a bypass mode, so an unattended bot does not stall at every ask.
  const sessionMode =
    engineChanges && isYoloMode(target.engine.yolo_id) && (await runsInBypassMode(conversation))
      ? YOLO_ALIAS
      : undefined;
  const undoPin = assistantId ? await pinAssistant(assistantId, target.engine.id, sessionMode) : null;
  let createdId: string | undefined;
  try {
    createdId = await startNewChatLike(conversation, {
      engine: engineChanges ? target.engine : undefined,
      assistant: entry,
      model: target.kind === 'model' ? toProviderModel(target.provider, target.model) : undefined,
      acpModel: target.kind === 'engine' ? target.model : undefined,
      thoughtLevel: target.kind === 'engine' ? target.thoughtLevel : undefined,
      sessionMode,
    });
    if (!createdId) throw new Error('The backend created no conversation');
    await deliverHandoff(createdId, target.engine.agent_type === 'aionrs' ? 'aionrs' : 'acp', handoff);
    return createdId;
  } catch (error) {
    if (createdId) {
      await ipcBridge.conversation.remove.invoke({ id: createdId }).catch((removeError: unknown) => {
        console.error('[limitSwitch] Could not remove the new chat:', removeError);
      });
    }
    await undoPin?.().catch((undoError: unknown) => {
      console.error('[limitSwitch] Could not roll back the engine pin:', undoError);
    });
    throw error;
  }
}
