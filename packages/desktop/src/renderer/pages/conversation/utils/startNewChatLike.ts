/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { TChatConversation } from '@/common/config/storage';
import { emitter } from '@/renderer/utils/emitter';
import { getConversationOrNull } from './conversationCache';

/**
 * The `extra` keys a new chat with the same assistant takes from `source`: its engine, identity and chosen settings.
 * An allowlist, so nothing bound to the old chat rides along: its schedule (`cronJobId`/`cron_job_id`), team, fork,
 * backend session, usage, pin or first-turn files. The backend re-resolves the rest from the assistant.
 */
const CARRIED_EXTRA_KEYS = [
  'workspace',
  'backend',
  'cli_path',
  'agent_name',
  'custom_agent_id',
  'agent_id',
  'agent_source',
  'preset_assistant_id',
  'session_mode',
  'current_model_id',
  'sandboxMode',
  'codexModel',
  'session_mcp_servers',
  'skills',
] as const;

/**
 * Creates an empty chat with the same assistant, engine, model and settings as `source`, over the aioncore HTTP API
 * (so it also works in the WebUI). The backend resolves the assistant's current rule, notes and skills for the new chat.
 * Returns the new conversation's id, or null when the backend made none.
 */
export async function startNewChatLike(source: TChatConversation): Promise<string | null> {
  // The stored copy, so settings changed since the page loaded (e.g. session mode) carry over.
  const latest = (await getConversationOrNull(source.id)) ?? source;
  const sourceExtra: Record<string, unknown> = latest.extra ?? {};
  // A temporary folder belongs to its chat: without a workspace the backend makes a fresh one, as for any new chat.
  const dropWorkspace = sourceExtra.is_temporary_workspace === true;
  const extra = Object.fromEntries(
    CARRIED_EXTRA_KEYS.filter((key) => key in sourceExtra && !(dropWorkspace && key === 'workspace')).map((key) => [
      key,
      sourceExtra[key],
    ])
  );
  // Only what creating the chat needs: never its source/channel binding, history or runtime state.
  const model = 'model' in latest ? latest.model : undefined; // aionrs only: the other types carry it in `extra`
  const conversation = { type: latest.type, model, assistant: latest.assistant, name: '', extra };
  const created = await ipcBridge.conversation.createWithConversation.invoke({
    conversation: conversation as TChatConversation,
  });
  if (!created?.id) return null;
  emitter.emit('chat.history.refresh');
  return created.id;
}
