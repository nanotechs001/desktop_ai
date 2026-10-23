/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** A VA Bot's taskbar robot steps away exactly while the user can see its chat in the main window. */

import React from 'react';
import { render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TChatConversation } from '@/common/config/storage';

const h = vi.hoisted(() => ({
  suspend: vi.fn(),
  setVaBotMode: vi.fn(),
  widgetsEnabled: false,
  preview: { isOpen: false, isVaChatCollapsed: true },
}));

vi.mock('@/renderer/pages/agentWidget/useAgentWidgetSync', () => ({
  useSuspendAgentWidget: (conversationId: string | undefined, chatOpen: boolean) => h.suspend(conversationId, chatOpen),
  useRestoreHiddenAgentWidget: () => undefined,
  useAgentWidgetSettings: () => ({ enabled: h.widgetsEnabled }),
}));
vi.mock('@/renderer/pages/agentWidget/chatLocation', () => ({ useChatLocation: () => 'main' }));
vi.mock('@/common/types/agent/defaultAgent', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/types/agent/defaultAgent')>()),
  isVaBotAgent: () => true,
}));
vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({ ...h.preview, openPreview: vi.fn(), setVaBotMode: h.setVaBotMode }),
}));
vi.mock('@/renderer/pages/conversation/Messages/MessageList', () => ({ default: () => <div>message history</div> }));
vi.mock('@/renderer/pages/conversation/Messages/hooks', () => ({
  MessageListLoadingProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MessageListProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  MessagePaginationProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  useMessageLstCache: vi.fn(),
}));
vi.mock('@/renderer/pages/conversation/Messages/artifacts', () => ({
  ConversationArtifactProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/renderer/pages/conversation/components/ChatLayout', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/renderer/pages/conversation/components/ChatSlider.tsx', () => ({ default: () => null }));
vi.mock('@/renderer/pages/cron', () => ({ CronJobManager: () => null }));
vi.mock('@/renderer/hooks/agent/usePresetAssistantInfo', () => ({
  resolveAssistantConfigId: () => undefined,
  usePresetAssistantInfo: () => ({ info: undefined, isLoading: false }),
}));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({ useLayoutContext: () => ({ isMobile: false }) }));

import ChatConversation from '@/renderer/pages/conversation/components/ChatConversation';

const botChat = {
  id: 'conv-bot',
  user_id: 'user-1',
  name: 'bot chat',
  type: 'gemini',
  model: {},
  extra: { workspace: '/tmp/ws' },
  status: 'finished',
  source: 'aionui',
  created_at: 1,
  modified_at: 1,
  pinned: false,
} as unknown as TChatConversation;

const chatOpenFlag = (preview: { isOpen: boolean; isVaChatCollapsed: boolean }): boolean => {
  h.preview = preview;
  h.suspend.mockClear();
  render(<ChatConversation conversation={botChat} />);
  return h.suspend.mock.calls.at(-1)?.[1] as boolean;
};

beforeEach(() => {
  h.suspend.mockClear();
});

describe('the robot of the VA Bot chat on screen steps away while the user sees its chat', () => {
  it('counts the chat as seen when no pane covers it, though it is collapsed under a pane that is not there', () => {
    expect(chatOpenFlag({ isOpen: false, isVaChatCollapsed: true })).toBe(true);
  });

  it('does not count a chat collapsed under the open browser pane', () => {
    expect(chatOpenFlag({ isOpen: true, isVaChatCollapsed: true })).toBe(false);
  });

  it('counts a chat shown under the open browser pane', () => {
    expect(chatOpenFlag({ isOpen: true, isVaChatCollapsed: false })).toBe(true);
  });
});

describe("a VA Bot chat's place in the main window", () => {
  it('starts closed under the browser for a chatbot, which is talked to through its robot', () => {
    h.widgetsEnabled = true;
    chatOpenFlag({ isOpen: true, isVaChatCollapsed: true });
    expect(h.setVaBotMode).toHaveBeenLastCalledWith(true, false);
  });

  it('starts open when the floating robots are off, since the main window is the only place to chat', () => {
    h.widgetsEnabled = false;
    chatOpenFlag({ isOpen: true, isVaChatCollapsed: false });
    expect(h.setVaBotMode).toHaveBeenLastCalledWith(true, true);
  });
});
