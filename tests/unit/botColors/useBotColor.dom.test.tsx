/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import { BOT_COLOR_PALETTE, fallbackBotColor } from '@/common/types/agent/botColors';

const mocks = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const subscribers = new Map<string, Set<(value: unknown) => void>>();
  const state = { initialized: true };
  const notify = (key: string, value: unknown) => subscribers.get(key)?.forEach((callback) => callback(value));
  return {
    store,
    state,
    configService: {
      isInitialized: () => state.initialized,
      get: (key: string) => store.get(key),
      set: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
        notify(key, value);
      }),
      subscribe: (key: string, callback: (value: unknown) => void) => {
        if (!subscribers.has(key)) subscribers.set(key, new Set());
        subscribers.get(key)!.add(callback);
        return () => subscribers.get(key)?.delete(callback);
      },
    },
    listAssistants: vi.fn(),
  };
});

vi.mock('@/common/config/configService', () => ({ configService: mocks.configService }));
vi.mock('@/common', () => ({ ipcBridge: { assistants: { list: { invoke: mocks.listAssistants } } } }));

import {
  afterBotColorsChanged,
  forgetBotColor,
  newBotColor,
  rememberBotColor,
  seedBotColors,
  useBotColor,
  useBotColorSeed,
  writeBotColors,
} from '@/renderer/hooks/agent/useBotColor';

const bot = (id: string, sortOrder: number, source: Assistant['source'] = 'user') =>
  ({ id, source, sort_order: sortOrder }) as unknown as Assistant;

beforeEach(() => {
  mocks.store.clear();
  mocks.state.initialized = true;
  mocks.configService.set.mockClear();
  mocks.listAssistants.mockReset();
});
afterEach(cleanup);

describe('useBotColor', () => {
  it('returns the stored color', () => {
    mocks.store.set('agent.colors', { a: '#112233' });
    const { result } = renderHook(() => useBotColor('a'));
    expect(result.current).toBe('#112233');
  });

  it('falls back to the id-derived palette color when none is stored', () => {
    const { result } = renderHook(() => useBotColor('a'));
    expect(result.current).toBe(fallbackBotColor('a'));
  });

  it('ignores a stored value that is not a color', () => {
    mocks.store.set('agent.colors', { a: 'oops' });
    const { result } = renderHook(() => useBotColor('a'));
    expect(result.current).toBe(fallbackBotColor('a'));
  });

  it('is undefined without an id', () => {
    expect(renderHook(() => useBotColor()).result.current).toBeUndefined();
    expect(renderHook(() => useBotColor('')).result.current).toBeUndefined();
  });

  it('follows changes to the stored colors', async () => {
    const { result } = renderHook(() => useBotColor('a'));
    await act(async () => {
      await writeBotColors({ a: '#abcdef' });
    });
    expect(result.current).toBe('#abcdef');
  });
});

describe('writing colors', () => {
  it('writeBotColors stores the map and the broadcast hook is a harmless no-op', async () => {
    expect(() => afterBotColorsChanged({ a: '#112233' })).not.toThrow();
    await writeBotColors({ a: '#112233' });
    expect(mocks.store.get('agent.colors')).toEqual({ a: '#112233' });
  });

  it('rememberBotColor adds or replaces one entry without touching the others', async () => {
    mocks.store.set('agent.colors', { a: '#111111', b: '#222222' });
    await rememberBotColor('b', '#333333');
    expect(mocks.store.get('agent.colors')).toEqual({ a: '#111111', b: '#333333' });
  });

  it('rememberBotColor refuses a value that is not a color', async () => {
    await rememberBotColor('a', 'red');
    expect(mocks.configService.set).not.toHaveBeenCalled();
  });

  it('forgetBotColor removes the entry', async () => {
    mocks.store.set('agent.colors', { a: '#111111', b: '#222222' });
    await forgetBotColor('a');
    expect(mocks.store.get('agent.colors')).toEqual({ b: '#222222' });
  });

  it('forgetBotColor writes nothing when the bot had no color', async () => {
    mocks.store.set('agent.colors', { b: '#222222' });
    await forgetBotColor('a');
    expect(mocks.configService.set).not.toHaveBeenCalled();
  });

  it('newBotColor avoids colors that other bots use', () => {
    mocks.store.set('agent.colors', Object.fromEntries(BOT_COLOR_PALETTE.slice(0, 11).map((c, i) => [`b${i}`, c])));
    expect(newBotColor()).toBe(BOT_COLOR_PALETTE[11]);
  });
});

describe('seedBotColors', () => {
  it('gives every VA bot without a color one, in sort order, and skips built-in and default Agents', async () => {
    const assistants = [
      bot('late', 5),
      bot('early', 1),
      bot('preset', 0, 'builtin'),
      bot('the-default', 2),
      bot('aion-default-agent', 3),
    ];
    await seedBotColors(assistants, 'the-default', () => 0);
    expect(mocks.store.get('agent.colors')).toEqual({
      early: BOT_COLOR_PALETTE[0],
      late: BOT_COLOR_PALETTE[1],
    });
  });

  it('never overwrites an existing color and is idempotent', async () => {
    mocks.store.set('agent.colors', { early: '#123456' });
    const assistants = [bot('early', 1), bot('late', 2)];
    await seedBotColors(assistants, 'x', () => 0);
    const first = mocks.store.get('agent.colors');
    expect(first).toEqual({ early: '#123456', late: BOT_COLOR_PALETTE[0] });

    mocks.configService.set.mockClear();
    await seedBotColors(assistants, 'x', () => 0.9);
    expect(mocks.configService.set).not.toHaveBeenCalled();
    expect(mocks.store.get('agent.colors')).toBe(first);
  });

  it('does nothing before the settings are loaded', async () => {
    mocks.state.initialized = false;
    await seedBotColors([bot('a', 1)], 'x');
    expect(mocks.configService.set).not.toHaveBeenCalled();
  });
});

describe('useBotColorSeed', () => {
  it('lists the Agents once the default Agent is known and seeds them', async () => {
    mocks.store.set('agent.builtinDefaultId', 'the-default');
    mocks.listAssistants.mockResolvedValue([bot('a', 1), bot('the-default', 2)]);
    renderHook(() => useBotColorSeed());
    await waitFor(() => expect(mocks.store.get('agent.colors')).toBeDefined());
    expect(Object.keys(mocks.store.get('agent.colors') as object)).toEqual(['a']);
  });

  it('waits while the default Agent is unknown', async () => {
    mocks.listAssistants.mockResolvedValue([bot('a', 1)]);
    renderHook(() => useBotColorSeed());
    await Promise.resolve();
    expect(mocks.listAssistants).not.toHaveBeenCalled();
    expect(mocks.store.get('agent.colors')).toBeUndefined();
  });

  it('logs and carries on when the Agent list cannot be loaded', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.store.set('agent.builtinDefaultId', 'the-default');
    mocks.listAssistants.mockRejectedValue(new Error('offline'));
    renderHook(() => useBotColorSeed());
    await waitFor(() => expect(warn).toHaveBeenCalled());
    expect(mocks.store.get('agent.colors')).toBeUndefined();
    warn.mockRestore();
  });
});
