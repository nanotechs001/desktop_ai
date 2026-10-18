import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { TChatConversation } from '@/common/config/storage';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, opts?: { name?: string }) => `${key}:${opts?.name ?? ''}` }),
}));
const panel = vi.hoisted(() => ({ filter: undefined as undefined | ((c: TChatConversation) => boolean) }));
vi.mock('@/renderer/components/layout/Titlebar/HistoryPanel', () => ({
  default: ({ open, title, filter }: { open: boolean; title?: string; filter?: (c: TChatConversation) => boolean }) => {
    panel.filter = filter;
    return open ? <div data-testid='history-panel'>{title}</div> : null;
  },
}));

import AgentHistoryButton from '@/renderer/components/layout/Titlebar/AgentHistoryButton';

const chat = (assistantId?: string) =>
  ({ id: 'c', assistant: assistantId ? { id: assistantId } : undefined }) as unknown as TChatConversation;

describe('AgentHistoryButton', () => {
  it("opens the history panel titled for the bot and listing only that bot's chats", () => {
    render(<AgentHistoryButton agentId='bot-1' agentName='Shopper' />);
    expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'conversation.history.botChatHistory:Shopper' }));

    expect(screen.getByTestId('history-panel')).toHaveTextContent('conversation.history.botChatHistory:Shopper');
    expect(panel.filter?.(chat('bot-1'))).toBe(true);
    expect(panel.filter?.(chat('bot-2'))).toBe(false);
    expect(panel.filter?.(chat())).toBe(false);
  });
});
