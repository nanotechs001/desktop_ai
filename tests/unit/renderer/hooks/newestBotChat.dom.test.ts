/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * A bot's newest chat pulls its browser tabs. A scheduled run's own chat is listed with the bot's chats, but it never
 * counts as newer, so the user's latest chat keeps the tabs after every run (risk 14).
 */

import { describe, expect, it, vi } from 'vitest';
import type { TChatConversation } from '@/common/config/storage';

vi.mock('@/common', () => ({ ipcBridge: {} }));

import {
  hasNewerSnapshotConversationOfAssistant,
  setConversationListForTest,
} from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';

const chat = (id: string, created_at: number, extra: Record<string, unknown> = {}) =>
  ({ id, created_at, assistant: { id: 'bot-1' }, extra }) as unknown as TChatConversation;

describe('hasNewerSnapshotConversationOfAssistant', () => {
  it("does not count a scheduled run's own chat as the bot's newer chat", () => {
    setConversationListForTest([chat('mine', 10), chat('run', 20, { cron_job_id: 'cron_1', scheduled_run: true })]);

    expect(hasNewerSnapshotConversationOfAssistant('bot-1', 'mine', 10)).toBe(false);
  });

  it("still counts the user's own newer chat, also one a scheduled task is bound to", () => {
    setConversationListForTest([chat('mine', 10), chat('bound', 20, { cron_job_id: 'cron_1' })]);

    expect(hasNewerSnapshotConversationOfAssistant('bot-1', 'mine', 10)).toBe(true);
  });
});
