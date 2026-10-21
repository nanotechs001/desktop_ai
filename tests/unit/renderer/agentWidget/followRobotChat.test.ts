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

import { followRobotChat } from '@/renderer/pages/agentWidget/useAgentWidgetSync';

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
