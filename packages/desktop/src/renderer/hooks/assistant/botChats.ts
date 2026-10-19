/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Every chat of a VA Bot: finding them (live and archived) and removing them. Shared by "delete a bot"
 * and the cleanup of chats left behind by bots deleted earlier.
 */

import { ipcBridge } from '@/common';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import { scopeToToken } from '@/common/adapter/sidebarMapper';
import { configService } from '@/common/config/configService';
import type { TChatConversation } from '@/common/config/storage';
import { isHiddenAgentId } from '@/common/types/agent/hiddenAgents';
import { isUndeletableAgent } from '@/common/types/agent/defaultAgent';
import { emitter } from '@/renderer/utils/emitter';

const LIVE_PAGE_SIZE = 500;
const ARCHIVED_PAGE_SIZE = 100; // the sidebar API's maximum window
const MAX_PAGES = 1000;
export const DEFAULT_REMOVE_CONCURRENCY = 4;

type Page<T> = { items: T[]; has_more: boolean; total?: number };

/**
 * Every live conversation. Throws when a page fails, is malformed or stalls: a partial list must never drive a
 * delete. A `total` that disagrees with the rows is only logged: the backend skips unreadable legacy rows but still
 * counts them, and chats can change while the list is paged.
 */
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
      if (page.total !== undefined && all.length !== page.total) {
        console.warn(`[botChats] the conversation list returned ${all.length} rows for a total of ${page.total}`);
      }
      return all;
    }
    if (page.items.length === 0) throw new Error('Conversation paging stalled');
    cursor = page.items[page.items.length - 1].id;
  }
  throw new Error('Too many conversation pages');
};

/** `fn` over every item, at most `width` at a time. Rejects on the first failure in a batch after it settles. */
const mapInBatches = async <T, R>(items: readonly T[], width: number, fn: (item: T) => Promise<R>): Promise<R[]> => {
  const results: R[] = [];
  for (let start = 0; start < items.length; start += width) {
    // eslint-disable-next-line no-await-in-loop -- bounded concurrency: one batch at a time
    results.push(...(await Promise.all(items.slice(start, start + width).map(fn))));
  }
  return results;
};

/** The ids of every archived conversation, across all groups and their pages. Throws on any failure. */
const listArchivedIds = async (): Promise<string[]> => {
  const first = await ipcBridge.sidebar.get.invoke({ archived: true, limit: ARCHIVED_PAGE_SIZE });
  if (first.has_more_groups) {
    console.warn('[botChats] more archived groups than the sidebar returns; the rest are not searched', first);
  }
  const ids: string[] = [];
  for (const group of first.groups) {
    ids.push(...group.items.map((item) => item.conversation.id));
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
      ids.push(...next.items.map((item) => item.conversation.id));
      hasMore = next.has_more;
      cursor = next.next_cursor;
    }
    if (hasMore) throw new Error('Too many archived pages');
  }
  return ids;
};

/** A chat that is gone is skipped; any other error is thrown. */
const getConversation = async (id: string): Promise<TChatConversation | null> => {
  try {
    return (await ipcBridge.conversation.get.invoke({ id })) ?? null;
  } catch (error) {
    if (isBackendHttpError(error) && error.status === 404) return null;
    throw error;
  }
};

/**
 * Every chat, live and archived, each once, that `match` accepts. Throws when the list can't be read. Sidebar rows
 * carry no assistant identity (only the conversation service fills it in), so archived chats are looked up one by one.
 */
export async function collectChats(match: (conversation: TChatConversation) => boolean): Promise<TChatConversation[]> {
  const [live, archivedIds] = await Promise.all([listLiveConversations(), listArchivedIds()]);
  const liveIds = new Set(live.map((conversation) => conversation.id));
  const archived = await mapInBatches(
    [...new Set(archivedIds)].filter((id) => !liveIds.has(id)),
    DEFAULT_REMOVE_CONCURRENCY,
    getConversation
  );
  const byId = new Map<string, TChatConversation>();
  for (const conversation of [...live, ...archived]) {
    if (conversation && match(conversation)) byId.set(conversation.id, conversation);
  }
  return [...byId.values()];
}

/** The bot's chats, live and archived. */
export const collectBotChats = (agentId: string): Promise<TChatConversation[]> =>
  collectChats((conversation) => conversation.assistant?.id === agentId);

/**
 * Chats left behind by a VA Bot that was deleted: the snapshot keeps `assistant.source === 'user'` and the id, while the
 * definition lookup fails (the name falls back to the raw id). The default Agent and the hidden butler are never
 * orphans even when the catalog does not list them. Throws when the catalog is empty or unreadable: a real install
 * always has the default Agent, so an empty list means a failed load, and treating every bot as gone would be wrong.
 */
export async function findOrphanChats(keptIds: readonly string[] = []): Promise<TChatConversation[]> {
  const catalog = await ipcBridge.assistants.list.invoke();
  if (!Array.isArray(catalog) || catalog.length === 0) throw new Error('Assistant catalog is empty');
  const known = new Set(catalog.map((assistant) => assistant.id));
  const kept = new Set(keptIds);
  const storedDefaultId = configService.get('agent.builtinDefaultId');
  return collectChats(({ id, assistant }) => {
    if (assistant?.source !== 'user' || kept.has(id)) return false;
    return (
      !known.has(assistant.id) && !isUndeletableAgent(assistant.id, storedDefaultId) && !isHiddenAgentId(assistant.id)
    );
  });
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
