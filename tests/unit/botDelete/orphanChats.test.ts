/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Finding the chats left behind by VA Bots that were deleted before bot-delete cleaned up after itself. A wrong match
 * here offers to delete a chat the user still wants, so the negative cases matter as much as the positive ones.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({
  assistantsList: vi.fn(),
  getUserConversations: vi.fn(),
  sidebarGet: vi.fn(),
  get: vi.fn(),
  storedDefaultId: { value: undefined as string | undefined },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    assistants: { list: { invoke: ipc.assistantsList } },
    database: { getUserConversations: { invoke: ipc.getUserConversations } },
    sidebar: { get: { invoke: ipc.sidebarGet }, items: { invoke: vi.fn() } },
    conversation: { get: { invoke: ipc.get }, remove: { invoke: vi.fn() } },
    agentWidget: { remove: { invoke: vi.fn() } },
  },
}));
vi.mock('@/common/adapter/httpBridge', () => ({
  isBackendHttpError: (error: unknown) => typeof (error as { status?: unknown })?.status === 'number',
}));
vi.mock('@/common/config/configService', () => ({ configService: { get: () => ipc.storedDefaultId.value } }));
vi.mock('@/renderer/utils/emitter', () => ({ emitter: { emit: vi.fn() } }));

import { findOrphanChats } from '@/renderer/hooks/assistant/botChats';
import type { TChatConversation } from '@/common/config/storage';

const chat = (id: string, assistant?: { id: string; source: string }): TChatConversation =>
  ({
    id,
    name: `chat ${id}`,
    assistant: assistant && { name: assistant.id, avatar: '', backend: 'b', ...assistant },
  }) as unknown as TChatConversation;

const live = (...items: TChatConversation[]) =>
  ipc.getUserConversations.mockResolvedValue({ items, total: items.length, has_more: false });
const catalog = (...ids: string[]) => ipc.assistantsList.mockResolvedValue(ids.map((id) => ({ id })));

beforeEach(() => {
  vi.clearAllMocks();
  ipc.storedDefaultId.value = undefined;
  catalog('alive', 'aion-default-agent');
  live();
  ipc.sidebarGet.mockResolvedValue({ groups: [], has_more_groups: false });
});

describe('findOrphanChats', () => {
  it('finds user-bot chats whose bot is no longer in the catalog', async () => {
    live(chat('gone1', { id: 'deleted-bot', source: 'user' }), chat('ok', { id: 'alive', source: 'user' }));

    expect((await findOrphanChats()).map((c) => c.id)).toEqual(['gone1']);
  });

  it('finds archived orphans too, through conversation.get (sidebar rows carry no identity)', async () => {
    ipc.sidebarGet.mockResolvedValue({
      groups: [
        {
          scope: { type: 'chats' },
          items: [{ type: 'conversation', conversation: { id: 'arch', name: 'chat arch' } }],
          has_more: false,
        },
      ],
      has_more_groups: false,
    });
    ipc.get.mockResolvedValue(chat('arch', { id: 'deleted-bot', source: 'user' }));

    expect((await findOrphanChats()).map((c) => c.id)).toEqual(['arch']);
  });

  it('never matches the default Agent, built-ins, generated agents, extensions or regular chats', async () => {
    live(
      chat('default-in-catalog', { id: 'aion-default-agent', source: 'user' }),
      chat('builtin', { id: 'builtin-writer', source: 'builtin' }),
      chat('generated', { id: 'claude-gen', source: 'generated' }),
      chat('extension', { id: 'ext-bot', source: 'extension' }),
      chat('plain')
    );

    expect(await findOrphanChats()).toEqual([]);
  });

  it('never matches the default Agent or the hidden butler even when the catalog does not list them', async () => {
    catalog('alive');
    ipc.storedDefaultId.value = 'adopted-default';
    live(
      chat('stored-default', { id: 'adopted-default', source: 'user' }),
      chat('fixed-default', { id: 'aion-default-agent', source: 'user' }),
      chat('butler', { id: 'aionui-assistant', source: 'user' })
    );

    expect(await findOrphanChats()).toEqual([]);
  });

  it('skips chats the user chose to keep, and finds only the new ones', async () => {
    live(chat('old', { id: 'deleted-bot', source: 'user' }), chat('new', { id: 'deleted-bot', source: 'user' }));

    expect((await findOrphanChats(['old'])).map((c) => c.id)).toEqual(['new']);
  });

  it('finds nothing when the catalog is empty or unreadable, so a failed load never offers a delete', async () => {
    live(chat('gone', { id: 'deleted-bot', source: 'user' }));

    catalog();
    await expect(findOrphanChats()).rejects.toThrow();

    ipc.assistantsList.mockRejectedValue(new Error('offline'));
    await expect(findOrphanChats()).rejects.toThrow('offline');
  });

  it('reads the chats before the catalog, so a bot created in between is not flagged', async () => {
    live(chat('fresh', { id: 'new-bot', source: 'user' }));
    // The bot appears in the catalog only once the chats have been read.
    ipc.assistantsList.mockImplementation(async () => {
      const chatsRead = ipc.getUserConversations.mock.calls.length > 0;
      return [{ id: 'alive' }, ...(chatsRead ? [{ id: 'new-bot' }] : [])];
    });

    expect(await findOrphanChats()).toEqual([]);
  });

  it('rejects when the chat list cannot be read', async () => {
    ipc.getUserConversations.mockRejectedValue(new Error('db'));

    await expect(findOrphanChats()).rejects.toThrow('db');
  });
});
