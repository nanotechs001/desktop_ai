/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The robot's chat popup header: the settings gear shows only for a conversation that belongs to a VA Bot, and
 * asks to open that bot's settings.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));
vi.mock('@/renderer/pages/conversation/components/ConversationChatBody', () => ({ default: () => null }));
vi.mock('@/renderer/components/layout/Titlebar/HistoryPanel', () => ({ HistoryPanelBody: () => null }));
vi.mock('@/renderer/hooks/context/ConversationHistoryContext', () => ({
  ConversationHistoryProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

import WidgetChatPopup from '@/renderer/pages/agentWidget/WidgetChatPopup';

const SETTINGS_LABEL = 'pet.widget.botSettings';
const LAYOUT = { bot_offset_x: 0, bot_size: 64 };

const renderPopup = (assistant: { id: string; name: string } | undefined, onOpenBotSettings = vi.fn()) => {
  render(
    <WidgetChatPopup
      conversation={{ id: 'c1', assistant } as never}
      name='Bot'
      state='idle'
      layout={LAYOUT as never}
      visible
      chatReady
      onMinimize={vi.fn()}
      onClose={vi.fn()}
      onReturnToMain={vi.fn()}
      onHideWidget={vi.fn()}
      onShowConversation={vi.fn()}
      onOpenBotSettings={onOpenBotSettings}
    />
  );
  return onOpenBotSettings;
};

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
