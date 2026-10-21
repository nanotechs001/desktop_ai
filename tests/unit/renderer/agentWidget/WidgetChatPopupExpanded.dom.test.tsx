/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The robot popup's expanded window: a sidebar with Chat / Recent / Settings and this bot's recent conversations,
 * beside a chat that is never remounted while the views switch.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import React, { useEffect } from 'react';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  chatMounts: 0,
  historyProps: null as null | {
    embedded?: boolean;
    filter?: (c: unknown) => boolean;
    onSelect?: (c: { id: string }) => void;
    onClose: () => void;
  },
  editorProps: null as null | { assistantId: string; onBack: () => void },
  conversations: [] as unknown[],
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));
vi.mock('@/renderer/pages/conversation/components/ConversationChatBody', () => ({
  default: () => {
    useEffect(() => {
      h.chatMounts += 1;
    }, []);
    return <div data-testid='chat-body' />;
  },
}));
vi.mock('@/renderer/components/layout/Titlebar/HistoryPanel', () => ({
  HistoryPanelBody: (props: NonNullable<typeof h.historyProps>) => {
    h.historyProps = props;
    return <div data-testid='history-panel' />;
  },
}));
vi.mock('@/renderer/hooks/context/ConversationHistoryContext', () => ({
  ConversationHistoryProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync', () => ({
  useConversationListSync: () => ({ conversations: h.conversations }),
}));
vi.mock('@/renderer/pages/settings/AssistantSettings/AssistantEditorPage', () => ({
  EmbeddedAssistantEditor: (props: NonNullable<typeof h.editorProps>) => {
    h.editorProps = props;
    return <div data-testid='embedded-editor' />;
  },
}));
vi.mock('@/renderer/pages/conversation/utils/startNewChatLike', () => ({ startNewChatLike: vi.fn() }));

import WidgetChatPopup from '@/renderer/pages/agentWidget/WidgetChatPopup';

const BOT = { id: 'bot-1', name: 'Research Bot' };
const chat = (id: string, name: string, modified_at: number, assistant = BOT) => ({ id, name, modified_at, assistant });
const CURRENT = chat('c1', 'Current chat', 3_000);

const LAYOUT = { conversation_id: 'c1', bot_offset_x: 0, bot_size: 64, expanded: true };

const renderPopup = (windowMode: 'compact' | 'expanded', onShowConversation = vi.fn()) => {
  const props = {
    conversation: CURRENT as never,
    name: 'Bot',
    state: 'idle' as const,
    visible: true,
    chatReady: true,
    onMinimize: vi.fn(),
    onClose: vi.fn(),
    onReturnToMain: vi.fn(),
    onHideWidget: vi.fn(),
    onShowConversation,
    onOpenBotSettings: vi.fn(),
  };
  const view = render(<WidgetChatPopup {...props} layout={{ ...LAYOUT, window_mode: windowMode } as never} />);
  const rerender = (mode: 'compact' | 'expanded') =>
    view.rerender(<WidgetChatPopup {...props} layout={{ ...LAYOUT, window_mode: mode } as never} />);
  return { onShowConversation, rerender };
};

const nav = () => screen.getByRole('navigation');
const navItem = (label: string) => within(nav()).getByRole('button', { name: label });
const recentRows = () =>
  within(screen.getByRole('list', { name: 'pet.widget.recentConversations' })).getAllByRole('button');

afterEach(() => {
  cleanup();
  h.chatMounts = 0;
  h.historyProps = null;
  h.editorProps = null;
  h.conversations = [];
});

describe('WidgetChatPopup expanded window', () => {
  it("shows the nav and only this bot's recent chats, newest first, with the current one selected", () => {
    h.conversations = [
      CURRENT,
      chat('c2', 'Newest chat', 5_000),
      chat('c3', 'Another bot', 9_000, { id: 'bot-2', name: 'Other' }),
      chat('c4', '', 1_000),
    ];
    renderPopup('expanded');

    const labels = within(nav())
      .getAllByRole('button')
      .map((b) => b.textContent);
    expect(labels).toEqual(['pet.widget.navChat', 'conversation.history.recents', 'common.settings']);
    expect(navItem('pet.widget.navChat')).toHaveAttribute('aria-current', 'page');

    const rows = recentRows();
    expect(rows.map((r) => r.querySelector('[data-row-title]')?.textContent)).toEqual([
      'Newest chat',
      'Current chat',
      'conversation.welcome.newConversation',
    ]);
    expect(rows[1]).toHaveAttribute('aria-current', 'true');
    expect(rows[0]).not.toHaveAttribute('aria-current');
    expect(rows[0].querySelector('[data-row-time]')?.textContent).not.toBe('');
  });

  it('caps the recent list at 30 rows', () => {
    h.conversations = Array.from({ length: 40 }, (_, i) => chat(`x${i}`, `Chat ${i}`, i));
    renderPopup('expanded');
    expect(recentRows()).toHaveLength(30);
    expect(recentRows()[0].textContent).toContain('Chat 39');
  });

  it('moves the robot to a recent chat that is clicked', () => {
    h.conversations = [CURRENT, chat('c2', 'Newest chat', 5_000)];
    const { onShowConversation } = renderPopup('expanded');
    fireEvent.click(recentRows()[0]);
    expect(onShowConversation).toHaveBeenCalledWith('c2');
  });

  it('keeps the same chat body while switching to Recent and Settings and back, and between modes', () => {
    h.conversations = [CURRENT];
    const { rerender } = renderPopup('expanded');
    const body = screen.getByTestId('chat-body');

    fireEvent.click(navItem('conversation.history.recents'));
    expect(screen.getByTestId('history-panel')).toBeTruthy();
    expect(navItem('conversation.history.recents')).toHaveAttribute('aria-current', 'page');
    fireEvent.click(navItem('common.settings'));
    expect(screen.getByTestId('embedded-editor')).toBeTruthy();
    expect(screen.queryByTestId('history-panel')).toBeNull();
    fireEvent.click(navItem('pet.widget.navChat'));
    rerender('compact');
    rerender('expanded');

    expect(screen.getByTestId('chat-body')).toBe(body);
    expect(h.chatMounts).toBe(1);
  });

  it("Recent is this bot's searchable history; a pick moves the robot and returns to the chat", () => {
    h.conversations = [CURRENT];
    const { onShowConversation } = renderPopup('expanded');
    fireEvent.click(navItem('conversation.history.recents'));

    const props = h.historyProps!;
    expect(props.embedded).toBe(true);
    expect(props.filter?.(chat('a', 'a', 1))).toBe(true);
    expect(props.filter?.(chat('b', 'b', 1, { id: 'bot-2', name: 'Other' }))).toBe(false);
    props.onSelect?.({ id: 'c9' });
    expect(onShowConversation).toHaveBeenCalledWith('c9');

    fireEvent.click(navItem('conversation.history.recents')); // still open: back through the panel's close
    React.act(() => props.onClose());
    expect(screen.queryByTestId('history-panel')).toBeNull();
    expect(navItem('pet.widget.navChat')).toHaveAttribute('aria-current', 'page');
  });

  it('Settings edits this bot inline; its back returns to the chat', () => {
    h.conversations = [CURRENT];
    renderPopup('expanded');
    fireEvent.click(navItem('common.settings'));
    expect(h.editorProps?.assistantId).toBe('bot-1');

    React.act(() => h.editorProps!.onBack());
    expect(screen.queryByTestId('embedded-editor')).toBeNull();
    expect(navItem('pet.widget.navChat')).toHaveAttribute('aria-current', 'page');
  });

  it('renders no sidebar in compact mode', () => {
    h.conversations = [CURRENT, chat('c2', 'Newest chat', 5_000)];
    renderPopup('compact');
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('list', { name: 'pet.widget.recentConversations' })).toBeNull();
    expect(screen.getByTestId('chat-body')).toBeTruthy();
  });
});

describe('robot in the expanded window', () => {
  it('stands inset by its hop headroom, so its hop never clips at the window top', () => {
    const css = readFileSync(
      path.resolve(__dirname, '../../../../packages/desktop/src/renderer/pages/agentWidget/AgentWidget.module.css'),
      'utf8'
    );
    const rule = css.match(/\.root\[data-window='expanded'\] \.bot\s*{[^}]*}/)?.[0] ?? '';
    expect(rule).toMatch(/top:\s*var\(--hop-headroom/);
  });
});
