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
  getConversation: null as null | ((id: string) => Promise<unknown>),
  assistants: [] as unknown[],
}));
vi.mock('@/common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/common')>();
  return {
    ...actual,
    ipcBridge: {
      ...actual.ipcBridge,
      assistants: { ...actual.ipcBridge.assistants, list: { invoke: async () => mocks.assistants } },
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
  getConversationOrNull: async (id: string) => (mocks.getConversation ? mocks.getConversation(id) : mocks.conversation),
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

const WEEK_MS = 7 * 24 * 3600 * 1000;
/** A stored 5-hour window without a reset time, read at `updated_at`. */
const noReset = (updated_at: number) => ({
  windows: { five_hour: { utilization: 0.4, resets_at: null } },
  updated_at,
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
    mocks.getConversation = null;
    mocks.assistants = [];
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

  it("files each reading under its chat's engine row, so two logins of one engine keep their own usage", async () => {
    const store = await load();
    const chats: Record<string, unknown> = {
      'c-main': { id: 'c-main', type: 'acp', extra: { backend: 'claude', agent_id: 'claude-main' } },
      'c-work': { id: 'c-work', type: 'acp', extra: { backend: 'claude', agent_id: 'claude-work' } },
    };
    mocks.getConversation = async (id) => chats[id];
    const { result: main } = renderHook(() => store.useSubscriptionUsage('claude-main', 'c-1'));
    const { result: work } = renderHook(() => store.useSubscriptionUsage('claude-work', 'c-2'));

    push(reading({ conversation_id: 'c-main', windows: [{ kind: 'five_hour', utilization: 0.2, resets_at: null }] }));
    push(reading({ conversation_id: 'c-work', windows: [{ kind: 'five_hour', utilization: 0.8, resets_at: null }] }));

    await waitFor(() => expect(work.current?.windows.five_hour?.utilization).toBe(0.8));
    await waitFor(() => expect(main.current?.windows.five_hour?.utilization).toBe(0.2));
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}').claude).toBeUndefined();
  });

  it('files a background chat under its preset assistant engine, as the on-screen chat does', async () => {
    const store = await load();
    mocks.conversation = {
      id: 'c-bg',
      type: 'acp',
      extra: { backend: 'claude', preset_assistant_id: 'builtin-coder' },
    };
    mocks.assistants = [{ id: 'coder', name: 'Coder', agent: { type: 'acp', acp_backend: 'codex' } }];
    const { result } = renderHook(() => store.useSubscriptionUsage('codex', 'c-1'));

    push(reading({ conversation_id: 'c-bg', windows: [{ kind: 'five_hour', utilization: 0.7, resets_at: null }] }));

    await waitFor(() => expect(result.current?.windows.five_hour?.utilization).toBe(0.7));
    expect(JSON.parse(localStorage.getItem(KEY) ?? '{}').claude).toBeUndefined();
  });

  it('keeps a reading that arrives before any send box mounts once the app starts the feed', async () => {
    const store = await load();
    store.startSubscriptionUsageFeed();
    store.startSubscriptionUsageFeed();
    mocks.conversation = { id: 'c-early', type: 'acp', extra: { backend: 'claude' } };

    push(reading({ conversation_id: 'c-early', windows: [{ kind: 'five_hour', utilization: 0.25, resets_at: null }] }));

    expect(mocks.listeners.size).toBe(1);
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem(KEY) ?? '{}').claude?.windows.five_hour.utilization).toBe(0.25)
    );
    const { result } = renderHook(() => store.useSubscriptionUsage('claude', 'c-1'));
    expect(result.current?.windows.five_hour?.utilization).toBe(0.25);
  });

  it('follows the readings another window stores (a robot window would otherwise keep what it read at load)', async () => {
    const store = await load();
    const { result } = renderHook(() => store.useSubscriptionUsage('claude', 'c-1'));
    expect(result.current).toBeNull();

    const stored = JSON.stringify({
      claude: { windows: { five_hour: { utilization: 0.9, resets_at: null } }, updated_at: NOW_MS },
    });
    localStorage.setItem(KEY, stored);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: stored }));
    });

    expect(result.current?.windows.five_hour?.utilization).toBe(0.9);
  });

  it('leaves storage to the main window: a robot window shows a reading but does not store it', async () => {
    window.location.hash = '#/widget/c-1';
    try {
      const store = await load();
      const setItem = vi.spyOn(Storage.prototype, 'setItem');
      const { result } = renderHook(() => store.useSubscriptionUsage('claude', 'c-1'));

      push(reading({ windows: [{ kind: 'five_hour', utilization: 0.42, resets_at: NOW_S + 600 }] }));

      expect(result.current?.windows.five_hour?.utilization).toBe(0.42);
      expect(setItem).not.toHaveBeenCalled();
    } finally {
      window.location.hash = '';
    }
  });

  it('ignores a corrupt stored value', async () => {
    localStorage.setItem(KEY, '{"claude":{"windows":"nope"}}');
    const store = await load();
    const { result } = renderHook(() => store.useSubscriptionUsage('claude', 'c-1'));
    expect(result.current).toBeNull();
  });

  it('gates on a five_hour or seven_day window', async () => {
    const { hasSubscriptionWindows } = await load();
    expect(hasSubscriptionWindows(null, NOW_MS)).toBe(false);
    expect(
      hasSubscriptionWindows({ windows: { overage: { utilization: 1, resets_at: null } }, updated_at: NOW_MS }, NOW_MS)
    ).toBe(false);
    expect(
      hasSubscriptionWindows(
        { windows: { seven_day: { utilization: 0, resets_at: null } }, updated_at: NOW_MS },
        NOW_MS
      )
    ).toBe(true);
  });

  it('gates on a window that has not expired', async () => {
    const { hasSubscriptionWindows } = await load();
    const usage = (fiveHourReset: number, weeklyReset: number) => ({
      windows: {
        five_hour: { utilization: 0.5, resets_at: fiveHourReset },
        seven_day: { utilization: 0.5, resets_at: weeklyReset },
      },
      updated_at: NOW_MS - 1000,
    });
    expect(hasSubscriptionWindows(usage(NOW_S - 10, NOW_S - 5), NOW_MS)).toBe(false);
    expect(hasSubscriptionWindows(usage(NOW_S - 10, NOW_S + 5), NOW_MS)).toBe(true);
  });

  it('gates on a reading from the last 7 days, which is also when a window without a reset expires', async () => {
    const { hasSubscriptionWindows } = await load();
    expect(hasSubscriptionWindows(noReset(NOW_MS - WEEK_MS + 1000), NOW_MS)).toBe(true);
    expect(hasSubscriptionWindows(noReset(NOW_MS - WEEK_MS - 1000), NOW_MS)).toBe(false);
    const futureReset = {
      windows: { seven_day: { utilization: 0.4, resets_at: NOW_S + 3600 } },
      updated_at: NOW_MS - WEEK_MS - 1000,
    };
    expect(hasSubscriptionWindows(futureReset, NOW_MS)).toBe(false);
  });

  it("hides the account's usage in a chat whose own latest reading came with no windows (an API-key session)", async () => {
    const store = await load();
    const { result } = renderHook(() => store.useSubscriptionUsage('claude', 'c-1'));
    mocks.conversation = { id: 'c-2', type: 'acp', extra: { backend: 'claude' } };
    push(reading({ conversation_id: 'c-2', windows: [{ kind: 'five_hour', utilization: 0.3, resets_at: null }] }));
    await waitFor(() => expect(result.current?.windows.five_hour?.utilization).toBe(0.3));

    push(reading({ conversation_id: 'c-1', utilization: 0.5 }));
    expect(result.current).toBeNull();
    const { result: other } = renderHook(() => store.useSubscriptionUsage('claude', 'c-3'));
    expect(other.current?.windows.five_hour?.utilization).toBe(0.3);

    push(reading({ conversation_id: 'c-1', windows: [{ kind: 'five_hour', utilization: 0.35, resets_at: null }] }));
    expect(result.current?.windows.five_hour?.utilization).toBe(0.35);
  });

  it('never lets an earlier reading overwrite a later one whose engine lookup resolved first', async () => {
    const store = await load();
    const lookups: Array<() => void> = [];
    mocks.getConversation = (id: string) =>
      new Promise((resolve) => {
        lookups.push(() => resolve({ id, type: 'acp', extra: { backend: 'claude' } }));
      });
    const { result } = renderHook(() => store.useSubscriptionUsage('claude', 'c-1'));

    vi.mocked(Date.now).mockReturnValue(NOW_MS + 1000);
    push(reading({ conversation_id: 'c-bg', windows: [{ kind: 'five_hour', utilization: 0.1, resets_at: null }] }));
    vi.mocked(Date.now).mockReturnValue(NOW_MS + 2000);
    push(reading({ conversation_id: 'c-bg', windows: [{ kind: 'five_hour', utilization: 0.2, resets_at: null }] }));
    expect(lookups).toHaveLength(1);
    vi.mocked(Date.now).mockReturnValue(NOW_MS + 3000);
    push(reading({ conversation_id: 'c-1', windows: [{ kind: 'five_hour', utilization: 0.3, resets_at: null }] }));
    expect(result.current?.windows.five_hour?.utilization).toBe(0.3);

    await act(async () => {
      lookups[0]();
    });

    expect(result.current?.windows.five_hour?.utilization).toBe(0.3);
    expect(result.current?.updated_at).toBe(NOW_MS + 3000);
  });
});
