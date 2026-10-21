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
import { createPortal } from 'react-dom';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  chatMounts: 0,
  historyProps: null as null | {
    embedded?: boolean;
    filter?: (c: unknown) => boolean;
    onSelect?: (c: { id: string }) => void;
    onClose: () => void;
  },
  editorProps: null as null | { assistantId: string; onBack: () => void },
  editorMounts: 0,
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
    useEffect(() => {
      h.editorMounts += 1;
    }, []);
    // Arco menus and pickers render into <body>; their key events still bubble through the React tree.
    return <div data-testid='embedded-editor'>{createPortal(<div data-testid='editor-menu' />, document.body)}</div>;
  },
}));
vi.mock('@/renderer/pages/conversation/utils/startNewChatLike', () => ({ startNewChatLike: vi.fn() }));

import { ipcBridge } from '@/common';
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
  return { onShowConversation, rerender, onMinimize: props.onMinimize };
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
  h.editorMounts = 0;
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

  it('Escape inside Settings, or from a menu it opened, leaves the window open; elsewhere it closes it', () => {
    h.conversations = [CURRENT];
    const { onMinimize } = renderPopup('expanded');
    fireEvent.click(navItem('common.settings'));
    fireEvent.keyDown(screen.getByTestId('embedded-editor'), { key: 'Escape' });
    fireEvent.keyDown(screen.getByTestId('editor-menu'), { key: 'Escape' });
    const handled = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    handled.preventDefault();
    document.querySelector('header')!.dispatchEvent(handled);
    expect(onMinimize).not.toHaveBeenCalled();

    fireEvent.keyDown(document.querySelector('header')!, { key: 'Escape' });
    expect(onMinimize).toHaveBeenCalledTimes(1);
  });

  it('Restore keeps the Settings editor (and its unsaved edits) mounted; expanding again shows it as it was', () => {
    h.conversations = [CURRENT];
    const { rerender } = renderPopup('expanded');
    fireEvent.click(navItem('common.settings'));
    const editor = screen.getByTestId('embedded-editor');
    rerender('compact');
    expect(editor.isConnected).toBe(true);
    expect(screen.getByTestId('chat-body').parentElement?.className).not.toMatch(/hidden/);
    rerender('expanded');
    expect(screen.getByTestId('embedded-editor')).toBe(editor);
    expect(navItem('common.settings')).toHaveAttribute('aria-current', 'page');
    expect(h.editorMounts).toBe(1);
  });

  it('renders no sidebar in compact mode', () => {
    h.conversations = [CURRENT, chat('c2', 'Newest chat', 5_000)];
    renderPopup('compact');
    expect(screen.queryByRole('navigation')).toBeNull();
    expect(screen.queryByRole('list', { name: 'pet.widget.recentConversations' })).toBeNull();
    expect(screen.getByTestId('chat-body')).toBeTruthy();
  });
});

describe('moving and resizing the expanded window', () => {
  let adjust: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    // jsdom has no pointer capture.
    Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() });
    adjust = vi.spyOn(ipcBridge.agentWidget.adjustWindow, 'invoke').mockResolvedValue(undefined);
  });
  afterEach(() => vi.restoreAllMocks());
  const press = (el: Element, x: number, y: number) =>
    fireEvent.pointerDown(el, { button: 0, pointerId: 1, screenX: x, screenY: y });
  const move = (el: Element, x: number, y: number) =>
    fireEvent.pointerMove(el, { pointerId: 1, screenX: x, screenY: y });
  const release = (el: Element, x: number, y: number) =>
    fireEvent.pointerUp(el, { pointerId: 1, screenX: x, screenY: y });
  const calls = () => adjust.mock.calls.map(([payload]) => payload);

  it('dragging the title bar sends the screen travel since the press; main moves the window', () => {
    h.conversations = [CURRENT];
    renderPopup('expanded');
    const header = document.querySelector('header')!;
    press(header, 100, 100);
    move(header, 101, 100); // under the threshold: still a click
    expect(adjust).not.toHaveBeenCalled();
    move(header, 140, 120);
    move(header, 150, 130);
    release(header, 150, 130);
    expect(calls()).toEqual([
      { conversation_id: 'c1', gesture: 'move', phase: 'start', dx: 40, dy: 20 },
      { conversation_id: 'c1', gesture: 'move', phase: 'move', dx: 40, dy: 20 },
      { conversation_id: 'c1', gesture: 'move', phase: 'move', dx: 50, dy: 30 },
      { conversation_id: 'c1', gesture: 'move', phase: 'end', dx: 50, dy: 30 },
    ]);
  });

  it('a cancelled drag ends where the pointer last was', () => {
    h.conversations = [CURRENT];
    renderPopup('expanded');
    const header = document.querySelector('header')!;
    press(header, 100, 100);
    move(header, 140, 120);
    fireEvent.pointerCancel(header, { pointerId: 1 });
    expect(calls().at(-1)).toEqual({ conversation_id: 'c1', gesture: 'move', phase: 'end', dx: 40, dy: 20 });
  });

  it('a press on a title-bar button never starts a window drag', () => {
    h.conversations = [CURRENT];
    renderPopup('expanded');
    const button = screen.getByRole('button', { name: 'pet.widget.closePopup' });
    press(button, 100, 100);
    move(button, 160, 140);
    release(button, 160, 140);
    expect(adjust).not.toHaveBeenCalled();
  });

  it('each edge and corner has its resize handle, which sends its own gesture', () => {
    h.conversations = [CURRENT];
    renderPopup('expanded');
    const handles = Array.from(document.querySelectorAll('[data-resize]'));
    expect(handles.map((el) => el.getAttribute('data-resize'))).toEqual(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw']);
    const corner = document.querySelector('[data-resize="se"]')!;
    press(corner, 500, 500);
    move(corner, 480, 520);
    release(corner, 470, 530);
    expect(calls().at(-1)).toEqual({ conversation_id: 'c1', gesture: 'se', phase: 'end', dx: -30, dy: 30 });
  });

  it('the compact popup can be neither dragged nor resized', () => {
    h.conversations = [CURRENT];
    renderPopup('compact');
    expect(document.querySelector('[data-resize]')).toBeNull();
    const header = document.querySelector('header')!;
    press(header, 100, 100);
    move(header, 160, 140);
    release(header, 160, 140);
    expect(adjust).not.toHaveBeenCalled();
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
