/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Links inside a chat shown in a robot window (switch and continue, its settings button, a saved note, a scheduled
 * task) never move the robot window's own router off its robot page: the robot moves to the chat, or the main window
 * shows the page.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  targets: {
    engines: [] as unknown[],
    providers: [] as unknown[],
    modelEngine: undefined as unknown,
    limitedUntil: {} as Record<string, number | null>,
  },
  switchAndContinue: vi.fn(async () => 'c2'),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }) }));
vi.mock('@/renderer/pages/conversation/components/limitSwitch/switchAndContinue', () => ({
  switchAndContinue: h.switchAndContinue,
  pinnableAssistantId: () => 'bot-1',
}));
vi.mock('@/renderer/pages/conversation/components/limitSwitch/switchTargets', () => ({
  listSwitchTargets: () => h.targets,
}));
vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  useModelProviderList: () => ({ providers: [], getAvailableModels: () => [], formatModelLabel: () => '' }),
}));
vi.mock('@/renderer/utils/model/agentTypes', () => ({
  ENGINE_CATALOG_SWR_KEY: 'engines',
  fetchManagedAgentsOrThrow: async () => [{ id: 'codex', name: 'Codex' }],
}));
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: async (id: string) => ({ id, type: 'acp', assistant: { id: 'bot-1' }, extra: {} }),
}));

import { ipcBridge } from '@/common';
import LimitSwitchActions from '@/renderer/pages/conversation/components/limitSwitch/LimitSwitchActions';
import NoteSavedChip from '@/renderer/pages/conversation/Messages/acp/NoteSavedChip';
import MessageCronTrigger from '@/renderer/pages/conversation/Messages/components/MessageCronTrigger';
import { useForkConversation } from '@/renderer/hooks/chat/useForkConversation';

let path = '';
const Where: React.FC = () => {
  path = useLocation().pathname;
  return null;
};
const renderIn = (ui: React.ReactNode, at: string) =>
  render(
    <MemoryRouter initialEntries={[at]}>
      {ui}
      <Where />
    </MemoryRouter>
  );

const spy = (name: 'showConversation' | 'openPageInMain' | 'openAgentSettings') =>
  vi.spyOn(ipcBridge.agentWidget[name], 'invoke').mockResolvedValue(undefined);

beforeEach(() => {
  h.targets = { engines: [{ id: 'codex', name: 'Codex' }], providers: [], modelEngine: undefined, limitedUntil: {} };
  window.location.hash = '#/widget/c1';
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  window.location.hash = '';
});

describe('in-chat links inside a robot window', () => {
  it('switch and continue moves the robot to the new chat; the window stays on its robot page', async () => {
    const show = spy('showConversation');
    renderIn(<LimitSwitchActions conversationId='c1' />, '/widget/c1');
    fireEvent.click(await screen.findByText('Codex'));
    fireEvent.click(screen.getByText('conversation.agentError.switch.proceed'));
    await waitFor(() => expect(show).toHaveBeenCalledWith({ conversation_id: 'c1', to: 'c2' }));
    expect(path).toBe('/widget/c1');
  });

  it('an engine still at its own plan limit is shown but cannot be picked (risk 16)', async () => {
    h.targets = { ...h.targets, limitedUntil: { codex: null } };
    h.switchAndContinue.mockClear();
    renderIn(<LimitSwitchActions conversationId='c1' />, '/widget/c1');
    const codex = (await screen.findByText('Codex')).closest('button');
    expect(codex?.disabled).toBe(true);
    fireEvent.click(codex as HTMLButtonElement);
    expect(h.switchAndContinue).not.toHaveBeenCalled();
  });

  it('with no engine to switch to, its settings button opens the settings in the main window', async () => {
    h.targets = { engines: [], providers: [], modelEngine: undefined, limitedUntil: {} };
    const open = spy('openPageInMain');
    renderIn(<LimitSwitchActions conversationId='c1' />, '/widget/c1');
    fireEvent.click(await screen.findByText('conversation.agentError.switch.openEngineSettings'));
    expect(open).toHaveBeenCalledWith({ conversation_id: 'c1', path: '/settings/agent' });
    expect(path).toBe('/widget/c1');
  });

  it("a saved note's notebook link opens the bot's settings in the main window", async () => {
    const open = spy('openAgentSettings');
    renderIn(<NoteSavedChip text='a note' source='chat' conversationId='c1' />, '/widget/c1');
    const button = await screen.findByText('messages.noteChip.open');
    await waitFor(() => expect(button.closest('button')?.disabled).toBe(false));
    fireEvent.click(button);
    expect(open).toHaveBeenCalledWith({ conversation_id: 'c1', agent_id: 'bot-1' });
    expect(path).toBe('/widget/c1');
  });

  it('a scheduled-task message opens the task in the main window', () => {
    const open = spy('openPageInMain');
    const artifact = { payload: { cron_job_id: 'cron_1', cron_job_name: 'Daily' } };
    renderIn(<MessageCronTrigger artifact={artifact as never} />, '/widget/c1');
    fireEvent.click(screen.getByTestId('message-cron-trigger'));
    expect(open).toHaveBeenCalledWith({ conversation_id: 'c1', path: '/scheduled/cron_1' });
    expect(path).toBe('/widget/c1');
  });

  it('a fork moves the robot to the forked chat', async () => {
    const show = spy('showConversation');
    vi.spyOn(ipcBridge.conversation.fork, 'invoke').mockResolvedValue({ id: 'c3' } as never);
    vi.spyOn(ipcBridge.conversation.ensureRuntime, 'invoke').mockResolvedValue({} as never);
    const { result } = renderHook(() => useForkConversation('c1'), {
      wrapper: ({ children }) => (
        <MemoryRouter initialEntries={['/widget/c1']}>
          {children}
          <Where />
        </MemoryRouter>
      ),
    });
    await act(() => result.current('m1'));
    expect(show).toHaveBeenCalledWith({ conversation_id: 'c1', to: 'c3' });
    expect(path).toBe('/widget/c1');
  });

  it('the main window still navigates itself', async () => {
    window.location.hash = '#/conversation/c1';
    const show = spy('showConversation');
    renderIn(<LimitSwitchActions conversationId='c1' />, '/conversation/c1');
    fireEvent.click(await screen.findByText('Codex'));
    fireEvent.click(screen.getByText('conversation.agentError.switch.proceed'));
    await waitFor(() => expect(path).toBe('/conversation/c2'));
    expect(show).not.toHaveBeenCalled();
  });
});
