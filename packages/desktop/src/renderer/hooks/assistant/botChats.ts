/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Every chat of a VA Bot: finding them (live and archived) and removing them. Shared by "delete a bot"
 * and the cleanup of chats left behind by bots deleted earlier.
 */

import { ipcBridge } from '@/common';
import { scopeToToken } from '@/common/adapter/sidebarMapper';
import type { TChatConversation } from '@/common/config/storage';
import { emitter } from '@/renderer/utils/emitter';

const LIVE_PAGE_SIZE = 500;
const ARCHIVED_PAGE_SIZE = 100; // the sidebar API's maximum window
const MAX_PAGES = 1000;
export const DEFAULT_REMOVE_CONCURRENCY = 4;

type Page<T> = { items: T[]; has_more: boolean; total?: number };

/** Every live conversation. Throws when a page fails, is malformed, or the pages don't add up: a partial list must never drive a delete. */
const listLiveConversations = async (): Promise<TChatConversation[]> => {
  const all: TChatConversation[] = [];
  let cursor: string | undefined;
  for (let i = 0; i < MAX_PAGES; i++) {
    // eslint-disable-next-line no-await-in-loop -- each cursor comes from the previous page
    const page: Page<TChatConversation> = await ipcBridge.database.getUserConversations.invoke({
      cursor,
      limit: LIVE_PAGE_SIZE,
    });
    if (!Array.isArray(page?.items)) throw new Error('Malformed conversation page');
    all.push(...page.items);
    if (!page.has_more) {
      if (page.total !== undefined && all.length !== page.total) throw new Error('Conversation pages are incomplete');
      return all;
    }
    if (page.items.length === 0) throw new Error('Conversation paging stalled');
    cursor = page.items[page.items.length - 1].id;
  }
  throw new Error('Too many conversation pages');
};

/** Every archived conversation, across all groups and their pages. Throws on any failure. */
const listArchivedConversations = async (): Promise<TChatConversation[]> => {
  const first = await ipcBridge.sidebar.get.invoke({ archived: true, limit: ARCHIVED_PAGE_SIZE });
  const all: TChatConversation[] = [];
  for (const group of first.groups) {
    all.push(...group.items.map((item) => item.conversation));
    let hasMore = group.has_more;
    let cursor = group.next_cursor;
    for (let i = 0; hasMore && i < MAX_PAGES; i++) {
      if (!cursor) throw new Error('Archived paging has no cursor');
      // eslint-disable-next-line no-await-in-loop -- each cursor comes from the previous page
      const next = await ipcBridge.sidebar.items.invoke({
        scope: scopeToToken(group.scope),
        cursor,
        limit: ARCHIVED_PAGE_SIZE,
        archived: true,
      });
      all.push(...next.items.map((item) => item.conversation));
      hasMore = next.has_more;
      cursor = next.next_cursor;
    }
    if (hasMore) throw new Error('Too many archived pages');
  }
  return all;
};

/** The bot's chats, live and archived, each once. Throws when the list can't be read completely. */
export async function collectBotChats(agentId: string): Promise<TChatConversation[]> {
  const [live, archived] = await Promise.all([listLiveConversations(), listArchivedConversations()]);
  const byId = new Map<string, TChatConversation>();
  for (const conversation of [...live, ...archived]) {
    if (conversation.assistant?.id === agentId) byId.set(conversation.id, conversation);
  }
  return [...byId.values()];
}

export type RemoveChatsOptions = {
  /** After each chat settles (removed or failed). */
  onProgress?: (done: number, total: number) => void;
  /** After a chat was removed, e.g. to leave it if it is the open one. */
  onRemoved?: (conversationId: string) => void;
  /** At most this many removals at once. */
  concurrency?: number;
};

export type RemoveChatsResult = { removed: string[]; failed: string[] };

/** The backend refuses with `false` or rejects; both mean the chat is still there. */
const removeOne = async (conversationId: string): Promise<void> => {
  const removed = await ipcBridge.conversation.remove.invoke({ id: conversationId });
  if (!removed) throw new Error(`Could not delete conversation ${conversationId}`);
  emitter.emit('conversation.deleted', conversationId);
  // Main also drops the robot when the list changes, but not on a timing we can rely on; this is idempotent.
  await ipcBridge.agentWidget.remove.invoke({ conversation_id: conversationId }).catch((error: unknown) => {
    console.warn('[botChats] could not remove the robot of a deleted chat:', error);
  });
};

/** Removes the chats, a few at a time, never stopping at a failure. */
export async function removeChats(
  conversations: readonly TChatConversation[],
  { onProgress, onRemoved, concurrency = DEFAULT_REMOVE_CONCURRENCY }: RemoveChatsOptions
): Promise<RemoveChatsResult> {
  const removed: string[] = [];
  const failed: string[] = [];
  const total = conversations.length;
  const width = Math.max(1, Math.floor(concurrency));
  let done = 0;

  for (let start = 0; start < total; start += width) {
    // eslint-disable-next-line no-await-in-loop -- bounded concurrency: one batch at a time
    await Promise.allSettled(
      conversations.slice(start, start + width).map(async ({ id }) => {
        try {
          await removeOne(id);
          removed.push(id);
          onRemoved?.(id);
        } catch (error) {
          console.warn('[botChats] could not delete a chat:', error);
          failed.push(id);
        }
        done += 1;
        onProgress?.(done, total);
      })
    );
  }
  return { removed, failed };
}
