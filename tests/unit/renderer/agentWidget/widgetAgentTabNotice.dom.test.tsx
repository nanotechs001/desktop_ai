/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The robot's chat popup tells the user when its own agent puts a page in front (open, switch, navigate) and offers
 * Watch, which shows that chat's browser in the main window. Another chat's agent never shows here.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

type Handler<T> = (event: T) => void;
const h = vi.hoisted(() => ({
  open: [] as Handler<{ url: string; background: boolean; conversationId?: string }>[],
  action: [] as Handler<{ webContentsId: number; op: string; label: string }>[],
  ownership: [] as Handler<unknown[]>[],
  watchInMain: vi.fn(() => Promise.resolve()),
  getOwnership: vi.fn(() =>
    Promise.resolve({
      success: true,
      data: [
        { webContentsId: 7, owner: { clientId: 'x', label: 'Bot', conversationId: 'c1' } },
        { webContentsId: 8, owner: { clientId: 'y', label: 'Other', conversationId: 'c2' } },
        { webContentsId: 9, owner: 'user' },
      ],
    })
  ),
  on:
    <T,>(list: Handler<T>[]) =>
    (handler: Handler<T>) => {
      list.push(handler);
      return () => list.splice(list.indexOf(handler), 1);
    },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    browser: { openTabRequested: { on: h.on(h.open) } },
    agentBrowser: {
      agentAction: { on: h.on(h.action) },
      ownershipChanged: { on: h.on(h.ownership) },
      getOwnership: { invoke: h.getOwnership },
    },
    agentWidget: { watchInMain: { invoke: h.watchInMain } },
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, o?: { site?: string }) => (o?.site ? `${k}:${o.site}` : k),
    i18n: { language: 'en' },
  }),
}));
vi.mock('@/renderer/pages/conversation/components/ConversationChatBody', () => ({ default: () => null }));
vi.mock('@/renderer/components/layout/Titlebar/HistoryPanel', () => ({ HistoryPanelBody: () => null }));
vi.mock('@/renderer/pages/conversation/components/NewChatButton', () => ({ useStartNewChat: () => vi.fn() }));
vi.mock('@/renderer/hooks/context/ConversationHistoryContext', () => ({
  ConversationHistoryProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import WidgetChatPopup from '@/renderer/pages/agentWidget/WidgetChatPopup';

const NOTICE = 'pet.widget.agentOpenedSite';
const renderPopup = async () => {
  render(
    <WidgetChatPopup
      conversation={{ id: 'c1', assistant: { id: 'bot-1', name: 'Bot' } } as never}
      name='Bot'
      state='idle'
      layout={{ bot_offset_x: 0, bot_size: 64 } as never}
      visible
      chatReady
      onMinimize={vi.fn()}
      onClose={vi.fn()}
      onReturnToMain={vi.fn()}
      onHideWidget={vi.fn()}
      onShowConversation={vi.fn()}
      onOpenBotSettings={vi.fn()}
    />
  );
  await act(async () => {}); // ownership lookup
};
const fire = <T,>(list: Handler<T>[], event: T) => act(() => list.forEach((handler) => handler(event)));

afterEach(() => {
  cleanup();
  h.watchInMain.mockClear();
});

describe('robot popup: the agent opened a tab', () => {
  it("names the site its own agent opened, and Watch reveals that chat's browser in the main window", async () => {
    await renderPopup();
    expect(screen.queryByText(new RegExp(NOTICE))).toBeNull();

    fire(h.open, { url: 'https://www.example.com/a?q=1', background: false, conversationId: 'c1' });
    expect(screen.getByText(`${NOTICE}:www.example.com`)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'pet.widget.watchTab' }));
    expect(h.watchInMain).toHaveBeenCalledWith({ conversation_id: 'c1' });
    expect(screen.queryByText(new RegExp(NOTICE))).toBeNull();
  });

  it("follows its agent's switch and navigate reports on the chat's own tabs", async () => {
    await renderPopup();
    fire(h.action, { webContentsId: 7, op: 'navigate', label: 'https://docs.test/page' });
    expect(screen.getByText(`${NOTICE}:docs.test`)).toBeInTheDocument();
    fire(h.action, { webContentsId: 7, op: 'switch', label: 'https://two.test/' });
    expect(screen.getByText(`${NOTICE}:two.test`)).toBeInTheDocument();
    fire(h.action, { webContentsId: 7, op: 'click', label: 'Publish' });
    expect(screen.getByText(`${NOTICE}:two.test`)).toBeInTheDocument();
  });

  it("ignores another chat's agent, the user's own tabs and pages opened without a chat", async () => {
    await renderPopup();
    fire(h.open, { url: 'https://other.test/', background: false, conversationId: 'c2' });
    fire(h.open, { url: 'https://popup.test/', background: false });
    fire(h.action, { webContentsId: 8, op: 'open', label: 'https://other.test/' });
    fire(h.action, { webContentsId: 9, op: 'navigate', label: 'https://mine.test/' });
    expect(screen.queryByText(new RegExp(NOTICE))).toBeNull();
    expect(h.watchInMain).not.toHaveBeenCalled();
  });
});
