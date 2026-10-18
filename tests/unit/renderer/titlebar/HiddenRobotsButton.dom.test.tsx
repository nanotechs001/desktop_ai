/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Hidden VA Bot robots can be shown again: from the titlebar list, and by opening the bot's chat.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  hidden: [] as Array<{ conversation_id: string; agent_id?: string }>,
  hiddenListener: null as null | ((list: Array<{ conversation_id: string; agent_id?: string }>) => void),
  ensure: vi.fn((_payload: unknown) => Promise.resolve(true)),
  conversations: {} as Record<string, { id: string; name?: string; assistant?: { id: string; name: string } }>,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    agentWidget: {
      getSettings: { invoke: () => Promise.resolve({ enabled: true }) },
      settingsChanged: { on: () => () => {} },
      listHidden: { invoke: () => Promise.resolve(h.hidden) },
      hiddenChanged: {
        on: (fn: typeof h.hiddenListener) => {
          h.hiddenListener = fn;
          return () => {
            h.hiddenListener = null;
          };
        },
      },
      ensure: { invoke: (payload: unknown) => h.ensure(payload) },
    },
  },
}));

vi.mock('@/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/utils/platform')>()),
  isElectronDesktop: () => true,
}));

vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: (id: string) => Promise.resolve(h.conversations[id] ?? null),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import HiddenRobotsButton from '@/renderer/components/layout/Titlebar/HiddenRobotsButton';
import { useRestoreHiddenAgentWidget } from '@/renderer/pages/agentWidget/useAgentWidgetSync';

const renderButton = () =>
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <HiddenRobotsButton iconSize={18} />
    </SWRConfig>
  );

beforeEach(() => {
  h.hidden = [];
  h.ensure.mockClear();
  h.conversations = {
    c1: { id: 'c1', name: 'Chat one', assistant: { id: 'bot-1', name: 'Research Bot' } },
    c2: { id: 'c2', name: 'Chat two', assistant: { id: 'bot-2', name: 'Sales Bot' } },
  };
});

afterEach(() => cleanup());

describe('HiddenRobotsButton', () => {
  it('renders nothing while no robot is hidden', async () => {
    renderButton();
    await act(async () => {});
    expect(screen.queryByTestId('titlebar-hidden-robots')).toBeNull();
  });

  it('lists hidden robots by bot name and shows the picked one again', async () => {
    h.hidden = [{ conversation_id: 'c1', agent_id: 'bot-1' }];
    renderButton();
    fireEvent.click(await screen.findByTestId('titlebar-hidden-robots'));
    fireEvent.click(await screen.findByText('Research Bot'));
    await waitFor(() =>
      expect(h.ensure).toHaveBeenCalledWith({ conversation_id: 'c1', force: true, agent_id: 'bot-1' })
    );
  });

  it('"Show all" brings back every hidden robot and skips robots whose chat is gone', async () => {
    h.hidden = [
      { conversation_id: 'c1', agent_id: 'bot-1' },
      { conversation_id: 'c2', agent_id: 'bot-2' },
      { conversation_id: 'gone', agent_id: 'bot-3' },
    ];
    renderButton();
    fireEvent.click(await screen.findByTestId('titlebar-hidden-robots'));
    expect(await screen.findByText('Sales Bot')).toBeTruthy();
    expect(screen.queryByTestId('hidden-robot-gone')).toBeNull();
    fireEvent.click(screen.getByText('pet.widget.showAllRobots'));
    await waitFor(() => expect(h.ensure).toHaveBeenCalledTimes(2));
  });

  it('disappears once the main process reports no hidden robots', async () => {
    h.hidden = [{ conversation_id: 'c1', agent_id: 'bot-1' }];
    renderButton();
    await screen.findByTestId('titlebar-hidden-robots');
    act(() => h.hiddenListener?.([]));
    await waitFor(() => expect(screen.queryByTestId('titlebar-hidden-robots')).toBeNull());
  });
});

describe('useRestoreHiddenAgentWidget', () => {
  it("opening a bot's chat shows its hidden robot again, even if hidden from another chat", async () => {
    h.hidden = [{ conversation_id: 'old-chat', agent_id: 'bot-1' }];
    renderHook(() => useRestoreHiddenAgentWidget('c1', 'bot-1'));
    await waitFor(() =>
      expect(h.ensure).toHaveBeenCalledWith({ conversation_id: 'c1', force: true, agent_id: 'bot-1' })
    );
  });

  it('leaves bots alone whose robot is not hidden', async () => {
    h.hidden = [{ conversation_id: 'c2', agent_id: 'bot-2' }];
    renderHook(() => useRestoreHiddenAgentWidget('c1', 'bot-1'));
    await act(async () => {});
    expect(h.ensure).not.toHaveBeenCalled();
  });
});
