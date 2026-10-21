/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The send-box plan usage indicator: when it shows, its colour level, and its popover rows.
 */

import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
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

vi.mock('@arco-design/web-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@arco-design/web-react')>()),
  Popover: ({
    children,
    content,
    title,
  }: {
    children?: React.ReactNode;
    content?: React.ReactNode;
    title?: React.ReactNode;
  }) => (
    <>
      {children}
      <div data-testid='popover'>
        {title}
        {content}
      </div>
    </>
  ),
}));

const mocks = vi.hoisted(() => ({
  listeners: new Set<(event: IConversationRateLimitUpdatedEvent) => void>(),
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
  getConversationOrNull: async () => null,
}));

const NOW_MS = 1_785_000_000_000;
const NOW_S = NOW_MS / 1000;
const HOUR = 3600;

const push = (over: Partial<IConversationRateLimitUpdatedEvent>) =>
  act(() => {
    for (const listener of mocks.listeners) {
      listener({
        user_id: 'u',
        conversation_id: 'c-1',
        status: 'allowed',
        rate_limit_type: 'five_hour',
        resets_at: null,
        utilization: null,
        windows: [],
        surpassed_threshold: null,
        ...over,
      });
    }
  });

const renderIndicator = async (backend = 'claude') => {
  vi.resetModules();
  const { default: SubscriptionUsageIndicator } =
    await import('@/renderer/pages/conversation/components/limitSwitch/SubscriptionUsageIndicator');
  return render(<SubscriptionUsageIndicator backend={backend} conversationId='c-1' />);
};

describe('SubscriptionUsageIndicator', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.listeners.clear();
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it('stays hidden without a 5-hour or weekly window (API-key sessions report none)', async () => {
    const { container } = await renderIndicator();
    push({ utilization: 0.5, resets_at: NOW_S + HOUR });
    expect(container).toBeEmptyDOMElement();
  });

  it('stays hidden for another engine than the one the reading came from', async () => {
    localStorage.setItem(
      'subscription-usage:v1',
      JSON.stringify({
        codex: { windows: { five_hour: { utilization: 0.5, resets_at: null } }, updated_at: NOW_MS },
      })
    );
    const { container } = await renderIndicator('claude');
    expect(container).toBeEmptyDOMElement();
  });

  it('shows the higher of the 5-hour and weekly use, coloured by level', async () => {
    await renderIndicator();
    push({
      windows: [
        { kind: 'five_hour', utilization: 0.3, resets_at: NOW_S + HOUR },
        { kind: 'seven_day', utilization: 0.8, resets_at: NOW_S + 3 * 24 * HOUR },
      ],
    });

    const trigger = screen.getByRole('button', { name: 'Claude usage: 80% used' });
    expect(trigger.dataset.level).toBe('warning');

    push({ windows: [{ kind: 'five_hour', utilization: 0.95, resets_at: NOW_S + HOUR }] });
    expect(screen.getByRole('button', { name: 'Claude usage: 95% used' }).dataset.level).toBe('danger');
  });

  it('lists each window with its use and reset in the popover', async () => {
    await renderIndicator();
    push({
      rate_limit_type: 'seven_day_opus',
      utilization: 0.5,
      resets_at: NOW_S + 2 * 24 * HOUR,
      windows: [
        { kind: 'five_hour', utilization: 0.42, resets_at: NOW_S + 2 * HOUR + 14 * 60 },
        { kind: 'seven_day', utilization: 0.1, resets_at: NOW_S + 3 * 24 * HOUR },
      ],
    });

    const popover = screen.getByTestId('popover');
    expect(popover).toHaveTextContent('Claude usage');
    expect(popover).toHaveTextContent('5-hour window');
    expect(popover).toHaveTextContent('42% used · resets in 2h 14m');
    expect(popover).toHaveTextContent('Weekly');
    expect(popover).toHaveTextContent(/10% used · resets [A-Z][a-z]{2} \d+/);
    expect(popover).toHaveTextContent('Weekly (Opus)');
    expect(popover).not.toHaveTextContent('Weekly (Sonnet)');
    expect(popover).toHaveTextContent('Updated just now');
  });

  it('shows a window whose reset has passed as reset at 0%', async () => {
    localStorage.setItem(
      'subscription-usage:v1',
      JSON.stringify({
        claude: {
          windows: {
            five_hour: { utilization: 0.9, resets_at: NOW_S - 1 },
            seven_day: { utilization: 0, resets_at: NOW_S + 3 * 24 * HOUR },
          },
          updated_at: NOW_MS - 3 * HOUR * 1000,
        },
      })
    );
    await renderIndicator();

    expect(screen.getByRole('button', { name: 'Claude usage: 0% used' })).toBeInTheDocument();
    const popover = screen.getByTestId('popover');
    expect(popover).toHaveTextContent('0% used · reset');
    expect(popover).toHaveTextContent('Updated 3h 0m ago');
  });

  it('hides once every 5-hour and weekly window has reset', async () => {
    localStorage.setItem(
      'subscription-usage:v1',
      JSON.stringify({
        claude: { windows: { five_hour: { utilization: 0.9, resets_at: NOW_S - 1 } }, updated_at: NOW_MS - 1000 },
      })
    );
    const { container } = await renderIndicator();
    expect(container).toBeEmptyDOMElement();
  });

  it('hides in a chat whose own latest reading came with no windows (an API-key session)', async () => {
    localStorage.setItem(
      'subscription-usage:v1',
      JSON.stringify({
        claude: { windows: { five_hour: { utilization: 0.4, resets_at: NOW_S + HOUR } }, updated_at: NOW_MS },
      })
    );
    const { container } = await renderIndicator();
    expect(screen.getByRole('button', { name: 'Claude usage: 40% used' })).toBeInTheDocument();
    push({ utilization: 0.5, resets_at: NOW_S + HOUR });
    expect(container).toBeEmptyDOMElement();
  });

  it('updates when a window resets, without a new reading', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      await renderIndicator();
      push({
        windows: [
          { kind: 'five_hour', utilization: 0.8, resets_at: NOW_S + 60 },
          { kind: 'seven_day', utilization: 0.2, resets_at: NOW_S + 3 * 24 * HOUR },
        ],
      });
      expect(screen.getByRole('button', { name: 'Claude usage: 80% used' })).toBeInTheDocument();

      vi.mocked(Date.now).mockReturnValue(NOW_MS + 60_000);
      act(() => {
        vi.advanceTimersByTime(60_000);
      });

      expect(screen.getByRole('button', { name: 'Claude usage: 20% used' })).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});
