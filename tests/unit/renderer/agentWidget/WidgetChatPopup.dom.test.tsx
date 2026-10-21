/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The robot's chat popup header: the settings gear shows only for a conversation that belongs to a VA Bot, and
 * asks to open that bot's settings.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Message } from '@arco-design/web-react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));
vi.mock('@/renderer/pages/conversation/components/ConversationChatBody', () => ({ default: () => null }));
vi.mock('@/renderer/components/layout/Titlebar/HistoryPanel', () => ({ HistoryPanelBody: () => null }));
const startNewChatLike = vi.hoisted(() => vi.fn());
vi.mock('@/renderer/pages/conversation/utils/startNewChatLike', () => ({ startNewChatLike }));
vi.mock('@/renderer/hooks/context/ConversationHistoryContext', () => ({
  ConversationHistoryProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import WidgetChatPopup from '@/renderer/pages/agentWidget/WidgetChatPopup';

const SETTINGS_LABEL = 'pet.widget.botSettings';
const LAYOUT = { conversation_id: 'c1', bot_offset_x: 0, bot_size: 64, window_mode: 'compact' };

const renderPopup = (
  assistant: { id: string; name: string; source?: string } | undefined,
  onOpenBotSettings = vi.fn(),
  onShowConversation = vi.fn(),
  layout: object = LAYOUT
) => {
  render(
    <WidgetChatPopup
      conversation={{ id: 'c1', assistant } as never}
      name='Bot'
      state='idle'
      layout={layout as never}
      visible
      chatReady
      onMinimize={vi.fn()}
      onClose={vi.fn()}
      onReturnToMain={vi.fn()}
      onHideWidget={vi.fn()}
      onShowConversation={onShowConversation}
      onOpenBotSettings={onOpenBotSettings}
    />
  );
  return onOpenBotSettings;
};

const colorDots = () =>
  Array.from(document.querySelectorAll<HTMLElement>('span[aria-hidden="true"]')).filter(
    (span) => span.style.backgroundColor === 'rgb(62, 99, 221)'
  );

afterEach(cleanup);

describe('WidgetChatPopup settings gear', () => {
  it('opens the settings of the bot the conversation belongs to', () => {
    const onOpenBotSettings = renderPopup({ id: 'bot-1', name: 'Bot' });
    fireEvent.click(screen.getByLabelText(SETTINGS_LABEL));
    expect(onOpenBotSettings).toHaveBeenCalledWith('bot-1');
  });

  it('is absent when the conversation has no VA Bot', () => {
    renderPopup(undefined);
    expect(screen.queryByLabelText(SETTINGS_LABEL)).toBeNull();
  });

  it('sits just before the hide button', () => {
    renderPopup({ id: 'bot-1', name: 'Bot' });
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels.indexOf(SETTINGS_LABEL) + 1).toBe(labels.indexOf('pet.widget.hideWidget'));
  });
});

describe('WidgetChatPopup header', () => {
  it("names the bot, not the chat's title", () => {
    render(
      <WidgetChatPopup
        conversation={{ id: 'c1', name: 'Opening greeting', assistant: { id: 'bot-1', name: 'Research Bot' } } as never}
        name='Opening greeting'
        state='idle'
        layout={LAYOUT as never}
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
    expect(screen.getByRole('dialog', { name: 'Research Bot' })).toBeTruthy();
    expect(screen.getByText('Research Bot')).toBeTruthy();
    expect(screen.queryByText('Opening greeting')).toBeNull();
  });

  it('falls back to the given name without a bot', () => {
    renderPopup(undefined);
    expect(screen.getByText('Bot')).toBeTruthy();
  });

  it('shows no color dot: the color lives on the robot', () => {
    configService.setLocal('agent.colors', { 'bot-1': '#3e63dd' });
    renderPopup({ id: 'bot-1', name: 'Bot', source: 'user' });
    expect(colorDots()).toHaveLength(0);
  });
});

describe('WidgetChatPopup new chat', () => {
  const NEW_CHAT = 'conversation.welcome.newConversation';

  afterEach(() => {
    startNewChatLike.mockReset();
    vi.restoreAllMocks();
  });

  it('sits next to the history button and has an accessible name', () => {
    renderPopup({ id: 'bot-1', name: 'Bot' });
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels.indexOf(NEW_CHAT)).toBe(labels.indexOf('conversation.history.botChatHistory') + 1);
  });

  it('starts a new chat with the same bot and moves the robot to it', async () => {
    startNewChatLike.mockResolvedValue('c2');
    const onShowConversation = vi.fn();
    renderPopup({ id: 'bot-1', name: 'Bot' }, vi.fn(), onShowConversation);
    fireEvent.click(screen.getByRole('button', { name: NEW_CHAT }));

    await waitFor(() => expect(onShowConversation).toHaveBeenCalledWith('c2'));
    expect(startNewChatLike).toHaveBeenCalledWith(expect.objectContaining({ assistant: { id: 'bot-1', name: 'Bot' } }));
  });

  it('shows an error and keeps the robot where it is when the chat cannot be made', async () => {
    startNewChatLike.mockRejectedValue(new Error('boom'));
    const error = vi.spyOn(Message, 'error').mockImplementation(() => () => {});
    const onShowConversation = vi.fn();
    renderPopup({ id: 'bot-1', name: 'Bot' }, vi.fn(), onShowConversation);
    fireEvent.click(screen.getByRole('button', { name: NEW_CHAT }));

    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(onShowConversation).not.toHaveBeenCalled();
  });

  it('is absent without a VA Bot', () => {
    renderPopup(undefined);
    expect(screen.queryByRole('button', { name: NEW_CHAT })).toBeNull();
  });
});

describe('WidgetChatPopup window mode', () => {
  const EXPAND = 'pet.widget.expandWindow';
  const RESTORE = 'pet.widget.restoreWindow';

  afterEach(() => vi.restoreAllMocks());

  it('offers Expand just before the close button in compact mode, and no minimize button', () => {
    const invoke = vi.spyOn(ipcBridge.agentWidget.setWindowMode, 'invoke').mockResolvedValue(undefined);
    renderPopup({ id: 'bot-1', name: 'Bot' });
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels.indexOf(EXPAND) + 1).toBe(labels.indexOf('pet.widget.closePopup'));
    expect(labels).not.toContain(RESTORE);
    expect(labels).not.toContain('pet.widget.minimize');
    fireEvent.click(screen.getByRole('button', { name: EXPAND }));
    expect(invoke).toHaveBeenCalledWith({ conversation_id: 'c1', mode: 'expanded' });
  });

  it('offers Restore instead in expanded mode', () => {
    const invoke = vi.spyOn(ipcBridge.agentWidget.setWindowMode, 'invoke').mockResolvedValue(undefined);
    renderPopup({ id: 'bot-1', name: 'Bot' }, vi.fn(), vi.fn(), { ...LAYOUT, window_mode: 'expanded' });
    const labels = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(labels).not.toContain(EXPAND);
    expect(labels).not.toContain('pet.widget.minimize');
    fireEvent.click(screen.getByRole('button', { name: RESTORE }));
    expect(invoke).toHaveBeenCalledWith({ conversation_id: 'c1', mode: 'compact' });
  });
});
