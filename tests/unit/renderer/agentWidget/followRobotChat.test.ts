/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const conversations = vi.hoisted(() => new Map<string, unknown>());
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: vi.fn(async (id: string) => conversations.get(id) ?? null),
}));
vi.mock('@/common/config/configService', () => ({ configService: { get: vi.fn(() => undefined) } }));
const bridge = vi.hoisted(() => ({
  robots: [] as Array<{ conversation_id: string; agent_id?: string; hidden: boolean }>,
  chats: [] as Array<{ id: string; created_at: number; assistant?: { id: string } }>,
  showConversation: vi.fn(async (_p: unknown) => undefined),
  remove: vi.fn(async (_p: unknown) => undefined),
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    agentWidget: {
      listRobots: { invoke: async () => bridge.robots },
      showConversation: { invoke: bridge.showConversation },
      remove: { invoke: bridge.remove },
    },
    database: { getUserConversations: { invoke: async () => ({ items: bridge.chats, has_more: false }) } },
  },
}));

import { followRobotChat, retireRobotChat } from '@/renderer/pages/agentWidget/useAgentWidgetSync';

const deps = () => ({ revealBrowserFor: vi.fn(), navigate: vi.fn() });

beforeEach(() => {
  conversations.clear();
  conversations.set('bot-a', { id: 'bot-a', assistant: { id: 'bot-1', source: 'user' } });
  conversations.set('plain', { id: 'plain' });
});

describe('followRobotChat', () => {
  it("switches the main window from a VA Bot chat to the robot's chat, with its browser pane", async () => {
    const d = deps();
    await expect(followRobotChat('/conversation/bot-a', 'bot-b', d)).resolves.toBe(true);
    expect(d.revealBrowserFor).toHaveBeenCalledWith('bot-b');
    expect(d.navigate).toHaveBeenCalledWith('/conversation/bot-b');
  });

  it('switches from the home page too', async () => {
    const d = deps();
    await expect(followRobotChat('/guid', 'bot-b', d)).resolves.toBe(true);
    expect(d.navigate).toHaveBeenCalledWith('/conversation/bot-b');
    expect(d.revealBrowserFor).toHaveBeenCalledWith('bot-b');
  });

  it('stays put on a plain chat, off a chat route, or when already on that chat', async () => {
    const d = deps();
    await expect(followRobotChat('/conversation/plain', 'bot-b', d)).resolves.toBe(false);
    await expect(followRobotChat('/settings/about', 'bot-b', d)).resolves.toBe(false);
    await expect(followRobotChat('/conversation/bot-a', 'bot-a', d)).resolves.toBe(false);
    expect(d.revealBrowserFor).not.toHaveBeenCalled();
    expect(d.navigate).not.toHaveBeenCalled();
  });
});

describe('retireRobotChat', () => {
  beforeEach(() => {
    bridge.showConversation.mockClear();
    bridge.remove.mockClear();
    bridge.robots = [{ conversation_id: 'gone', agent_id: 'bot-1', hidden: false }];
    bridge.chats = [
      { id: 'older', created_at: 1, assistant: { id: 'bot-1' } },
      { id: 'newest', created_at: 3, assistant: { id: 'bot-1' } },
      { id: 'other-bot', created_at: 9, assistant: { id: 'bot-2' } },
    ];
  });

  it("moves the robot of a deleted chat (or a rolled-back switch) to its bot's newest remaining chat", async () => {
    await retireRobotChat('gone');
    expect(bridge.showConversation).toHaveBeenCalledWith({ conversation_id: 'gone', to: 'newest' });
    expect(bridge.remove).not.toHaveBeenCalled();
  });

  it('removes the robot when its bot has no chat left, or it stands for no bot', async () => {
    bridge.chats = [{ id: 'other-bot', created_at: 9, assistant: { id: 'bot-2' } }];
    await retireRobotChat('gone');
    bridge.robots = [{ conversation_id: 'plain', hidden: false }];
    await retireRobotChat('plain');
    expect(bridge.remove.mock.calls).toEqual([[{ conversation_id: 'gone' }], [{ conversation_id: 'plain' }]]);
    expect(bridge.showConversation).not.toHaveBeenCalled();
  });

  it('leaves alone a chat that has no robot', async () => {
    await retireRobotChat('no-robot');
    expect(bridge.remove).not.toHaveBeenCalled();
    expect(bridge.showConversation).not.toHaveBeenCalled();
  });
});
