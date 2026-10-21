/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The account-level subscription usage store: merging readings per backend, persistence, and reset windows.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { IConversationRateLimitUpdatedEvent } from '@/common/adapter/ipcBridge';

const mocks = vi.hoisted(() => ({
  listeners: new Set<(event: IConversationRateLimitUpdatedEvent) => void>(),
  conversation: null as unknown,
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

type Store = typeof import('@/renderer/pages/conversation/components/limitSwitch/subscriptionUsage');

const NOW_MS = 1_785_000_000_000;
const NOW_S = NOW_MS / 1000;
const KEY = 'subscription-usage:v1';

const reading = (over: Partial<IConversationRateLimitUpdatedEvent> = {}): IConversationRateLimitUpdatedEvent => ({
  user_id: 'u',
  conversation_id: 'c-1',
  status: 'allowed',
  rate_limit_type: 'five_hour',
  resets_at: NOW_S + 3600,
  utilization: null,
  windows: [],
  surpassed_threshold: null,
  ...over,
});

const load = async (): Promise<Store> => {
  vi.resetModules();
  return import('@/renderer/pages/conversation/components/limitSwitch/subscriptionUsage');
};

const push = (event: IConversationRateLimitUpdatedEvent) =>
  act(() => {
    for (const listener of mocks.listeners) listener(event);
  });

describe('subscription usage store', () => {
  beforeEach(() => {
    localStorage.clear();
    mocks.listeners.clear();
    mocks.conversation = null;
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('merges windows from successive readings, keeping the kinds a newer reading does not name', async () => {
    const { mergeReading } = await load();
    const first = mergeReading(
      {},
      'claude',
      reading({ windows: [{ kind: 'five_hour', utilization: 0.2, resets_at: NOW_S + 100 }] }),
      NOW_MS
    );
    const second = mergeReading(
      first,
      'claude',
      reading({
        windows: [
          { kind: 'five_hour', utilization: 0.4, resets_at: NOW_S + 100 },
          { kind: 'seven_day', utilization: 0.1, resets_at: NOW_S + 9000 },
        ],
      }),
      NOW_MS + 5
    );
    const third = mergeReading(
      second,
      'claude',
      reading({ windows: [{ kind: 'seven_day', utilization: 0.15, resets_at: NOW_S + 9000 }] }),
      NOW_MS + 10
    );

    expect(third.claude.windows).toEqual({
      five_hour: { utilization: 0.4, resets_at: NOW_S + 100 },
      seven_day: { utilization: 0.15, resets_at: NOW_S + 9000 },
    });
    expect(third.claude.updated_at).toBe(NOW_MS + 10);
    expect(first.claude.windows.seven_day).toBeUndefined();
  });

  it('keys readings per backend', async () => {
    const { mergeReading } = await load();
    const state = mergeReading(
      mergeReading(
        {},
        'claude',
        reading({ windows: [{ kind: 'five_hour', utilization: 0.3, resets_at: null }] }),
        NOW_MS
      ),
      'codex',
      reading({ windows: [{ kind: 'seven_day', utilization: 0.6, resets_at: null }] }),
      NOW_MS
    );

    expect(state.claude.windows).toEqual({ five_hour: { utilization: 0.3, resets_at: null } });
    expect(state.codex.windows).toEqual({ seven_day: { utilization: 0.6, resets_at: null } });
  });

  it('ignores a reading without windows (API-key sessions), and the headline of one', async () => {
    const { mergeReading } = await load();
    const empty = {};
    expect(mergeReading(empty, 'claude', reading({ utilization: 0.5 }), NOW_MS)).toBe(empty);
  });

  it('adds the headline Opus or Sonnet window of a subscription reading', async () => {
    const { mergeReading } = await load();
    const state = mergeReading(
      {},
      'claude',
      reading({
        rate_limit_type: 'seven_day_opus',
        utilization: 0.8,
        resets_at: NOW_S + 50,
        windows: [{ kind: 'five_hour', utilization: 0.1, resets_at: NOW_S + 10 }],
      }),
      NOW_MS
    );

    expect(state.claude.windows.seven_day_opus).toEqual({ utilization: 0.8, resets_at: NOW_S + 50 });
  });

  it('shows a window whose reset has passed as reset, at 0%', async () => {
    const { currentWindows } = await load();
    const windows = currentWindows(
      {
        windows: {
          five_hour: { utilization: 0.9, resets_at: NOW_S - 1 },
          seven_day: { utilization: 0.4, resets_at: NOW_S + 60 },
        },
        updated_at: NOW_MS - 10_000,
      },
      NOW_MS
    );

    expect(windows.five_hour).toEqual({ utilization: 0, resets_at: null });
    expect(windows.seven_day).toEqual({ utilization: 0.4, resets_at: NOW_S + 60 });
  });

  it('feeds every rateLimitUpdated into the store and persists it across reloads', async () => {
    const first = await load();
    const { result } = renderHook(() => first.useSubscriptionUsage('claude', 'c-1'));
    expect(result.current).toBeNull();

    push(reading({ windows: [{ kind: 'five_hour', utilization: 0.42, resets_at: NOW_S + 600 }] }));

    expect(result.current?.windows.five_hour?.utilization).toBe(0.42);
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}').claude.windows.five_hour.utilization).toBe(0.42);

    const reloaded = await load();
    const { result: after } = renderHook(() => reloaded.useSubscriptionUsage('claude', 'c-1'));
    expect(after.current?.windows.five_hour?.utilization).toBe(0.42);
  });

  it('looks up the backend of a reading from a chat that is not on screen', async () => {
    const store = await load();
    mocks.conversation = { id: 'c-bg', type: 'acp', extra: { backend: 'codex' } };
    const { result } = renderHook(() => store.useSubscriptionUsage('codex', 'c-1'));

    push(reading({ conversation_id: 'c-bg', windows: [{ kind: 'seven_day', utilization: 0.3, resets_at: null }] }));

    await waitFor(() => expect(result.current?.windows.seven_day?.utilization).toBe(0.3));
  });

  it('ignores a corrupt stored value', async () => {
    localStorage.setItem(KEY, '{"claude":{"windows":"nope"}}');
    const store = await load();
    const { result } = renderHook(() => store.useSubscriptionUsage('claude', 'c-1'));
    expect(result.current).toBeNull();
  });

  it('gates on a five_hour or seven_day window', async () => {
    const { hasSubscriptionWindows } = await load();
    expect(hasSubscriptionWindows(null)).toBe(false);
    expect(hasSubscriptionWindows({ windows: { overage: { utilization: 1, resets_at: null } }, updated_at: 0 })).toBe(
      false
    );
    expect(hasSubscriptionWindows({ windows: { seven_day: { utilization: 0, resets_at: null } }, updated_at: 0 })).toBe(
      true
    );
  });
});
