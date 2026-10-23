/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The chat header's "Show as floating widget" button. While a bot's chat is open in the main window its robot
 * steps away (suspended), so asking only to show the robot (ensure) opened nothing and the button seemed dead. It now
 * opens the robot with this chat in its popup, which brings a suspended robot back.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ensure: vi.fn((_payload: unknown) => Promise.resolve(true)),
  openPopup: vi.fn((_payload: unknown) => Promise.resolve(true)),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    agentWidget: {
      getSettings: { invoke: () => Promise.resolve({ enabled: true }) },
      settingsChanged: { on: () => () => {} },
      ensure: { invoke: (payload: unknown) => h.ensure(payload) },
      openPopup: { invoke: (payload: unknown) => h.openPopup(payload) },
    },
  },
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { ShowAgentWidgetButton } from '@/renderer/pages/agentWidget/WidgetChatPlaceholder';

afterEach(() => {
  cleanup();
  h.ensure.mockClear();
  h.openPopup.mockClear();
});

describe('ShowAgentWidgetButton', () => {
  it("opens the robot with this chat in its popup, also while the chat's robot has stepped away", async () => {
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <ShowAgentWidgetButton conversationId='c1' agentId='bot-a' />
      </SWRConfig>
    );
    fireEvent.click(await screen.findByRole('button', { name: 'pet.widget.showWidget' }));
    await waitFor(() => expect(h.openPopup).toHaveBeenCalledWith({ conversation_id: 'c1', agent_id: 'bot-a' }));
    expect(h.ensure).not.toHaveBeenCalled();
  });
});
