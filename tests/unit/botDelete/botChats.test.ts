/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Gathering and removing every chat of a VA Bot: the shared step of "delete a bot" and the
 * leftover-chats cleanup. Deleting is permanent, so the failure paths matter as much as the happy one.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  getUserConversations: vi.fn(),
  sidebarGet: vi.fn(),
  sidebarItems: vi.fn(),
  remove: vi.fn(),
  widgetRemove: vi.fn(),
  emit: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    database: { getUserConversations: { invoke: ipc.getUserConversations } },
    sidebar: { get: { invoke: ipc.sidebarGet }, items: { invoke: ipc.sidebarItems } },
    conversation: { remove: { invoke: ipc.remove } },
    agentWidget: { remove: { invoke: ipc.widgetRemove } },
  },
}));
vi.mock('@/renderer/utils/emitter', () => ({ emitter: { emit: ipc.emit } }));

import { collectBotChats, removeChats } from '@/renderer/hooks/assistant/botChats';
import type { TChatConversation } from '@/common/config/storage';

const chat = (id: string, assistantId?: string): TChatConversation =>
  ({
    id,
    name: `chat ${id}`,
    assistant: assistantId ? { id: assistantId, source: 'user', name: 'n', avatar: '', backend: 'b' } : undefined,
  }) as unknown as TChatConversation;

const page = (items: TChatConversation[], total: number, has_more = false) => ({ items, total, has_more });
const archivedGroup = (items: TChatConversation[], extra: object = {}) => ({
  scope: { type: 'chats' as const },
  items: items.map((conversation) => ({ type: 'conversation' as const, conversation })),
  has_more: false,
  ...extra,
});

beforeEach(() => {
  vi.clearAllMocks();
  ipc.getUserConversations.mockResolvedValue(page([], 0));
  ipc.sidebarGet.mockResolvedValue({ groups: [], has_more_groups: false });
  ipc.remove.mockResolvedValue(true);
  ipc.widgetRemove.mockResolvedValue(undefined);
});

describe('collectBotChats', () => {
  it('returns only the chats of this bot, across every page of the live list', async () => {
    ipc.getUserConversations
      .mockResolvedValueOnce(page([chat('a', 'bot'), chat('x', 'other')], 4, true))
      .mockResolvedValueOnce(page([chat('b', 'bot'), chat('y')], 4, false));

    const found = await collectBotChats('bot');

    expect(found.map((c) => c.id)).toEqual(['a', 'b']);
    expect(ipc.getUserConversations).toHaveBeenNthCalledWith(1, expect.objectContaining({ cursor: undefined }));
    expect(ipc.getUserConversations).toHaveBeenNthCalledWith(2, expect.objectContaining({ cursor: 'x' }));
  });

  it('includes the archived chats, paging each archived group, and counts a chat in both lists once', async () => {
    ipc.getUserConversations.mockResolvedValue(page([chat('live', 'bot'), chat('both', 'bot')], 2));
    ipc.sidebarGet.mockResolvedValue({
      groups: [
        archivedGroup([chat('arch1', 'bot'), chat('both', 'bot'), chat('arch-other', 'other')], {
          has_more: true,
          next_cursor: 'c1',
        }),
        { ...archivedGroup([chat('proj1', 'bot')]), scope: { type: 'project', project_id: 'p', name: 'P' } },
      ],
      has_more_groups: false,
    });
    ipc.sidebarItems.mockResolvedValue({
      items: [{ type: 'conversation', conversation: chat('arch2', 'bot') }],
      has_more: false,
    });

    const found = await collectBotChats('bot');

    expect(found.map((c) => c.id).toSorted()).toEqual(['arch1', 'arch2', 'both', 'live', 'proj1']);
    expect(ipc.sidebarGet).toHaveBeenCalledWith(expect.objectContaining({ archived: true }));
    expect(ipc.sidebarItems).toHaveBeenCalledWith(
      expect.objectContaining({ scope: 'chats', cursor: 'c1', archived: true })
    );
  });

  it('never matches chats of the default Agent, other bots or plain chats', async () => {
    ipc.getUserConversations.mockResolvedValue(page([chat('1'), chat('2', 'other'), chat('3', 'bot-2')], 3));
    expect(await collectBotChats('bot')).toEqual([]);
  });

  it.each([
    ['a live page fails', () => ipc.getUserConversations.mockRejectedValue(new Error('down'))],
    ['a live page is malformed', () => ipc.getUserConversations.mockResolvedValue({ items: 'nope' })],
    ['the live pages do not add up to the total', () => ipc.getUserConversations.mockResolvedValue(page([], 3))],
    ['a page says there is more but is empty', () => ipc.getUserConversations.mockResolvedValue(page([], 3, true))],
    ['the archive read fails', () => ipc.sidebarGet.mockRejectedValue(new Error('down'))],
    [
      'an archived group page fails',
      () => {
        ipc.sidebarGet.mockResolvedValue({
          groups: [archivedGroup([], { has_more: true, next_cursor: 'c' })],
          has_more_groups: false,
        });
        ipc.sidebarItems.mockRejectedValue(new Error('down'));
      },
    ],
  ])('throws instead of returning a partial list when %s', async (_name, arrange) => {
    arrange();
    await expect(collectBotChats('bot')).rejects.toThrow();
  });
});

describe('removeChats', () => {
  const chats = ['a', 'b', 'c'].map((id) => chat(id, 'bot'));

  it('removes each chat, tells the app (events and robots), and reports what was removed', async () => {
    const onRemoved = vi.fn();
    const result = await removeChats(chats, { onRemoved });

    expect(result).toEqual({ removed: ['a', 'b', 'c'], failed: [] });
    expect(ipc.remove).toHaveBeenCalledWith({ id: 'b' });
    expect(ipc.emit).toHaveBeenCalledWith('conversation.deleted', 'b');
    expect(ipc.widgetRemove).toHaveBeenCalledWith({ conversation_id: 'b' });
    expect(onRemoved.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'c']);
  });

  it('reports progress after each chat', async () => {
    const onProgress = vi.fn();
    await removeChats(chats, { onProgress, concurrency: 1 });
    expect(onProgress.mock.calls).toEqual([
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it('keeps going past a failure and lists exactly the chats that failed (rejected or refused)', async () => {
    ipc.remove.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'a') throw new Error('boom');
      return id !== 'b';
    });
    const onRemoved = vi.fn();

    const result = await removeChats(chats, { onRemoved });

    expect(result).toEqual({ removed: ['c'], failed: ['a', 'b'] });
    expect(ipc.emit).toHaveBeenCalledTimes(1);
    expect(ipc.widgetRemove).toHaveBeenCalledTimes(1);
    expect(onRemoved).toHaveBeenCalledWith('c');
  });

  it('still counts a chat as removed when its robot cannot be removed', async () => {
    ipc.widgetRemove.mockRejectedValue(new Error('no widget'));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await removeChats(chats.slice(0, 1), {})).toEqual({ removed: ['a'], failed: [] });
    warn.mockRestore();
  });

  it('never runs more removals at once than the concurrency allows', async () => {
    let running = 0;
    let peak = 0;
    ipc.remove.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return true;
    });

    const many = Array.from({ length: 10 }, (_, i) => chat(`c${i}`, 'bot'));
    const result = await removeChats(many, { concurrency: 3 });

    expect(result.removed).toHaveLength(10);
    expect(peak).toBe(3);
  });

  it('defaults to a bounded concurrency of 4', async () => {
    let running = 0;
    let peak = 0;
    ipc.remove.mockImplementation(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 5));
      running -= 1;
      return true;
    });
    await removeChats(
      Array.from({ length: 9 }, (_, i) => chat(`c${i}`, 'bot')),
      {}
    );
    expect(peak).toBe(4);
  });

  it('does nothing for an empty list', async () => {
    expect(await removeChats([], {})).toEqual({ removed: [], failed: [] });
    expect(ipc.remove).not.toHaveBeenCalled();
  });
});
