/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The near-limit warning bar above the send box: when it shows, its copy, dismissal, and its switch actions.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { IConversationRateLimitUpdatedEvent } from '@/common/adapter/ipcBridge';

const enConversation = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales/en-US/conversation.json'),
    'utf8'
  )
) as Record<string, unknown>;

const translate = (key: string, params: Record<string, unknown> = {}): string => {
  const value = key
    .replace(/^conversation\./, '')
    .split('.')
    .reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      enConversation
    );
  if (typeof value !== 'string') return key;
  return value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params[name] ?? ''));
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'en-US' } }),
}));

const mocks = vi.hoisted(() => ({
  listeners: new Set<(event: IConversationRateLimitUpdatedEvent) => void>(),
  conversation: null as unknown,
  engines: [] as unknown[],
  switchAndContinue: vi.fn(),
}));
vi.mock('@/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/common')>();
  return {
    ...actual,
    ipcBridge: {
      ...actual.ipcBridge,
      conversation: {
        ...actual.ipcBridge.conversation,
        rateLimitUpdated: {
          on: (callback: (event: IConversationRateLimitUpdatedEvent) => void) => {
            mocks.listeners.add(callback);
            return () => mocks.listeners.delete(callback);
          },
          emit: () => {},
        },
      },
    },
  };
});
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: async () => mocks.conversation,
}));
vi.mock('@/renderer/utils/model/agentTypes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/utils/model/agentTypes')>()),
  fetchManagedAgentsOrThrow: async () => mocks.engines,
}));
vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  useModelProviderList: () => ({ providers: [], getAvailableModels: () => [], formatModelLabel: () => '' }),
}));
vi.mock('@/renderer/pages/conversation/components/limitSwitch/switchAndContinue', () => ({
  pinnableAssistantId: () => 'bot-1',
  switchAndContinue: mocks.switchAndContinue,
}));

import UsageWarningBar from '@/renderer/pages/conversation/components/limitSwitch/UsageWarningBar';
import { MessageListProvider } from '@/renderer/pages/conversation/Messages/hooks';

const engine = (id: string) => ({
  id,
  name: `Engine ${id}`,
  agent_type: 'acp',
  enabled: true,
  status: 'online',
  installed: true,
});

const push = (conversationId: string, over: Partial<IConversationRateLimitUpdatedEvent>) =>
  act(() => {
    for (const listener of mocks.listeners) {
      listener({
        user_id: 'u',
        conversation_id: conversationId,
        status: 'allowed',
        rate_limit_type: 'five_hour',
        resets_at: 1_785_754_200,
        utilization: null,
        windows: [],
        surpassed_threshold: null,
        ...over,
      });
    }
  });

const renderBar = (conversationId: string) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <MemoryRouter initialEntries={[`/conversation/${conversationId}`]}>
        <Routes>
          <Route
            path={`/conversation/${conversationId}`}
            element={<UsageWarningBar conversationId={conversationId} />}
          />
          <Route path='/conversation/:id' element={<div>opened new chat</div>} />
          <Route path='/settings/agent' element={<div>engine settings</div>} />
        </Routes>
      </MemoryRouter>
    </SWRConfig>
  );

const withAlternatives = (conversationId: string) => {
  mocks.conversation = { id: conversationId, type: 'acp', extra: { agent_id: 'claude' }, assistant: { id: 'bot-1' } };
  mocks.engines = [engine('claude'), engine('codex')];
};

describe('UsageWarningBar', () => {
  // The readings' resets are in 2026-08; the bar ignores readings whose window has already reset.
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(1_785_000_000_000);
  });
  afterEach(() => {
    cleanup();
    mocks.switchAndContinue.mockReset();
    vi.restoreAllMocks();
  });

  it('hides a reading whose window has already reset (M4)', () => {
    withAlternatives('c-stale');
    renderBar('c-stale');
    push('c-stale', { utilization: 0.97, resets_at: 1_784_000_000 });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('shows the used percent of the window at 90% and offers the switch buttons', async () => {
    withAlternatives('c-show');
    renderBar('c-show');
    push('c-show', { utilization: 0.92 });

    expect(screen.getByText(/^You've used 92% of your Claude 5-hour limit · resets /)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Engine codex' })).toBeInTheDocument();
  });

  it('names the most-used window, weekly Opus included', () => {
    withAlternatives('c-window');
    renderBar('c-window');
    push('c-window', {
      utilization: 0.2,
      windows: [{ kind: 'seven_day_opus', utilization: 1.04, resets_at: 1_786_000_000 }],
    });

    expect(screen.getByText(/^You've used 104% of your Claude weekly Opus limit/)).toBeInTheDocument();
  });

  it('shows on allowed_warning even without a utilization figure', () => {
    withAlternatives('c-warn');
    renderBar('c-warn');
    push('c-warn', { status: 'allowed_warning' });

    expect(screen.getByText(/^You're close to your Claude 5-hour limit · resets /)).toBeInTheDocument();
  });

  it('stays hidden below 90%, for readings of other chats, and once the limit is hit', () => {
    withAlternatives('c-hidden');
    renderBar('c-hidden');
    push('c-hidden', { utilization: 0.89 });
    push('c-other', { utilization: 0.99 });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    push('c-hidden', { status: 'rejected', utilization: 1 });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });

  it('keeps a dismissal for the same bucket and comes back on the next bucket or a new reset', () => {
    withAlternatives('c-dismiss');
    renderBar('c-dismiss');
    push('c-dismiss', { utilization: 0.9 });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    push('c-dismiss', { utilization: 0.94 });
    expect(screen.queryByRole('status')).not.toBeInTheDocument();

    push('c-dismiss', { utilization: 0.95 });
    expect(screen.getByText(/^You've used 95%/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
    push('c-dismiss', { utilization: 0.96, resets_at: 1_785_800_000 });
    expect(screen.getByText(/^You've used 96%/)).toBeInTheDocument();
  });

  it('switches through the existing flow, telling the next AI the previous one was close to its limit', async () => {
    withAlternatives('c-switch');
    mocks.switchAndContinue.mockResolvedValue('c-new');
    renderBar('c-switch');
    push('c-switch', { utilization: 0.97 });

    fireEvent.click(await screen.findByRole('button', { name: 'Engine codex' }));
    expect(mocks.switchAndContinue).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: translate('conversation.agentError.switch.proceed') }));

    expect(await screen.findByText('opened new chat')).toBeInTheDocument();
    expect(mocks.switchAndContinue).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'c-switch',
        target: { kind: 'engine', engine: mocks.engines[1], model: undefined, thoughtLevel: undefined },
        labels: expect.objectContaining({
          header: expect.stringContaining('the previous AI was close to its usage limit'),
        }),
      })
    );
  });

  // The 90% warning was dismissed (or never came: only some engines report usage) and then the model failed: the switch
  // choices pop up again for that error. A dismissal covers that error only; the next one shows them again.
  it('pops up again with the switch buttons when the chat ends in a limit or model error', async () => {
    withAlternatives('c-failed');
    const failed = (id: string) => ({
      id,
      type: 'tips',
      position: 'center',
      conversation_id: 'c-failed',
      content: {
        type: 'error',
        content: "You've hit your session limit",
        error: { message: 'limit', code: 'USER_LLM_PROVIDER_USAGE_LIMITED', resolution: { kind: 'switch_engine' } },
      },
    });
    const renderWith = (messages: unknown[]) =>
      render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <MemoryRouter initialEntries={['/conversation/c-failed']}>
            <MessageListProvider value={messages as never}>
              <UsageWarningBar conversationId='c-failed' />
            </MessageListProvider>
          </MemoryRouter>
        </SWRConfig>
      );

    const first = renderWith([failed('e1')]);
    expect(screen.getByRole('status')).toHaveTextContent(translate('conversation.usageWarning.limitHit'));
    expect(await screen.findByRole('button', { name: 'Engine codex' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: translate('conversation.usageWarning.dismiss') }));
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    first.unmount();

    renderWith([failed('e1'), failed('e2')]);
    expect(screen.getByRole('status')).toHaveTextContent(translate('conversation.usageWarning.limitHit'));
  });

  it('shows the backup notice with a Settings button when there is nothing to switch to', async () => {
    mocks.conversation = { id: 'c-alone', type: 'acp', extra: { agent_id: 'claude' } };
    mocks.engines = [engine('claude')];
    renderBar('c-alone');
    push('c-alone', { utilization: 0.93 });

    expect(
      await screen.findByText(
        'You only have one AI connected. Add another engine or model in Settings so you can switch when you hit a limit.'
      )
    ).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add an engine in Settings' }));
    expect(await screen.findByText('engine settings')).toBeInTheDocument();
  });
});
