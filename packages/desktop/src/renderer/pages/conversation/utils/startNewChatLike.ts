/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { TChatConversation } from '@/common/config/storage';
import { emitter } from '@/renderer/utils/emitter';
import { getConversationOrNull } from './conversationCache';

/** State that belongs to one chat: its backend session, usage, pin, schedule and first-turn attachments. */
const PER_CHAT_EXTRA_KEYS = new Set([
  'acp_session_id',
  'acp_session_conversation_id',
  'acp_session_updated_at',
  'last_token_usage',
  'last_context_limit',
  'pinned',
  'pinned_at',
  'cron_job_id',
  'default_files',
  'is_temporary_workspace',
]);

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
    Object.entries(sourceExtra).filter(
      ([key]) => !PER_CHAT_EXTRA_KEYS.has(key) && !(dropWorkspace && key === 'workspace')
    )
  );
  const created = await ipcBridge.conversation.createWithConversation.invoke({
    conversation: { ...latest, name: '', extra } as TChatConversation,
  });
  if (!created?.id) return null;
  emitter.emit('chat.history.refresh');
  return created.id;
}
