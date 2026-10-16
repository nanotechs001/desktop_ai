/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';

const mocks = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const subscribers = new Map<string, Set<(value: unknown) => void>>();
  const notify = (key: string, value: unknown) => subscribers.get(key)?.forEach((callback) => callback(value));
  return {
    store,
    subscribers,
    configService: {
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
    getManagedAgents: vi.fn(),
    listAssistants: vi.fn(),
    updateAssistant: vi.fn(),
    messageWarning: vi.fn(),
  };
});

vi.mock('@/common/config/configService', () => ({ configService: mocks.configService }));

vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: { getManagedAgents: { invoke: mocks.getManagedAgents } },
    assistants: { list: { invoke: mocks.listAssistants }, update: { invoke: mocks.updateAssistant } },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options?.name ? `${key}:${String(options.name)}` : key),
  }),
}));

vi.mock('@arco-design/web-react', () => ({
  Message: { warning: mocks.messageWarning },
}));

import {
  persistEnginePin,
  planEngineRebinds,
  resolveDefaultEngine,
  useDefaultEngine,
  useEngineDriftSync,
} from '@/renderer/hooks/agent/useDefaultEngine';

const agent = (id: string, overrides: Partial<ManagedAgent> = {}): ManagedAgent =>
  ({
    id,
    name: id,
    agent_type: 'acp',
    agent_source: 'builtin',
    enabled: true,
    installed: true,
    status: 'online',
    ...overrides,
  }) as ManagedAgent;

const assistant = (id: string, agentId: string, overrides: Partial<Assistant> = {}): Assistant =>
  ({ id, name: `Agent ${id}`, source: 'user', agent_id: agentId, enabled: true, ...overrides }) as Assistant;

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{children}</SWRConfig>
);

describe('resolveDefaultEngine', () => {
  const agents = [agent('a'), agent('b'), agent('c', { enabled: false })];

  it('returns the stored default when it exists and is enabled', () => {
    expect(resolveDefaultEngine(agents, 'b')?.id).toBe('b');
  });

  it('falls back to the first enabled agent when nothing is stored', () => {
    expect(resolveDefaultEngine(agents, undefined)?.id).toBe('a');
  });

  it('falls back when the stored agent was removed or disabled', () => {
    expect(resolveDefaultEngine(agents, 'gone')?.id).toBe('a');
    expect(resolveDefaultEngine(agents, 'c')?.id).toBe('a');
  });

  it('returns null when no agent is enabled', () => {
    expect(resolveDefaultEngine([agent('a', { enabled: false })], undefined)).toBeNull();
    expect(resolveDefaultEngine([], 'a')).toBeNull();
  });

  it('prefers an installed engine over an uninstalled one for the fallback', () => {
    const list = [agent('missing', { status: 'missing' }), agent('ok')];
    expect(resolveDefaultEngine(list, undefined)?.id).toBe('ok');
    expect(resolveDefaultEngine([list[0]], undefined)?.id).toBe('missing');
  });

  it('never picks a deprecated runtime as the default', () => {
    expect(resolveDefaultEngine([agent('old', { agent_type: 'nanobot' })], undefined)).toBeNull();
  });
});

describe('planEngineRebinds', () => {
  const engines = new Set(['a', 'b']);

  it('re-binds unpinned Agents that are not on the default engine', () => {
    const plan = planEngineRebinds([assistant('x', 'a'), assistant('y', 'b')], 'a', {}, engines);
    expect(plan.map((item) => [item.assistant.id, item.agentId])).toEqual([['y', 'a']]);
  });

  it('keeps pinned Agents on their pinned engine', () => {
    const plan = planEngineRebinds([assistant('x', 'a'), assistant('y', 'a')], 'a', { x: 'b' }, engines);
    expect(plan.map((item) => [item.assistant.id, item.agentId])).toEqual([['x', 'b']]);
  });

  it('ignores a pin that points at an engine that no longer exists', () => {
    const plan = planEngineRebinds([assistant('x', 'b')], 'a', { x: 'gone' }, engines);
    expect(plan.map((item) => [item.assistant.id, item.agentId])).toEqual([['x', 'a']]);
  });

  it('never re-binds generated (bare CLI) assistants', () => {
    expect(planEngineRebinds([assistant('bare:b', 'b', { source: 'generated' })], 'a', {}, engines)).toEqual([]);
  });
});

describe('persistEnginePin', () => {
  beforeEach(() => mocks.store.clear());

  it('adds and removes a pin without mutating the stored record', async () => {
    const original = { x: 'a' };
    mocks.store.set('agent.enginePins', original);

    await persistEnginePin('y', 'b');
    expect(mocks.store.get('agent.enginePins')).toEqual({ x: 'a', y: 'b' });

    await persistEnginePin('x', null);
    expect(mocks.store.get('agent.enginePins')).toEqual({ y: 'b' });
    expect(original).toEqual({ x: 'a' });
  });
});

describe('useDefaultEngine', () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.configService.set.mockClear();
    mocks.messageWarning.mockReset();
    mocks.getManagedAgents.mockResolvedValue([agent('a'), agent('b')]);
    mocks.listAssistants.mockResolvedValue([]);
    mocks.updateAssistant.mockReset().mockResolvedValue({});
  });

  it('resolves the stored default engine', async () => {
    mocks.store.set('agent.defaultAgentId', 'b');
    const { result } = renderHook(() => useDefaultEngine(), { wrapper });

    await waitFor(() => expect(result.current.agentId).toBe('b'));
    expect(result.current.agent?.id).toBe('b');
    expect(result.current.loading).toBe(false);
  });

  it('reports loading and a null engine until agents arrive', async () => {
    const { result } = renderHook(() => useDefaultEngine(), { wrapper });

    expect(result.current.loading).toBe(true);
    expect(result.current.agentId).toBeNull();
    await waitFor(() => expect(result.current.loading).toBe(false));
  });

  it('setDefault persists agent.defaultAgentId', async () => {
    const { result } = renderHook(() => useDefaultEngine(), { wrapper });
    await waitFor(() => expect(result.current.agentId).toBe('a'));

    await act(async () => {
      await result.current.setDefault('b');
    });

    expect(mocks.configService.set).toHaveBeenCalledWith('agent.defaultAgentId', 'b');
    await waitFor(() => expect(result.current.agentId).toBe('b'));
  });

  it('setDefault re-binds unpinned Agents to the new default and leaves pinned ones', async () => {
    mocks.store.set('agent.enginePins', { pinned: 'a' });
    mocks.listAssistants.mockResolvedValue([
      assistant('free', 'a'),
      assistant('pinned', 'a'),
      assistant('already', 'b'),
      assistant('bare:a', 'a', { source: 'generated' }),
    ]);
    const { result } = renderHook(() => useDefaultEngine(), { wrapper });
    await waitFor(() => expect(result.current.agentId).toBe('a'));

    await act(async () => {
      await result.current.setDefault('b');
    });

    expect(mocks.updateAssistant).toHaveBeenCalledTimes(1);
    expect(mocks.updateAssistant).toHaveBeenCalledWith({ id: 'free', agent_id: 'b' });
  });

  it('reports a failed re-bind per Agent and still changes the default', async () => {
    mocks.listAssistants.mockResolvedValue([assistant('one', 'a'), assistant('two', 'a')]);
    mocks.updateAssistant.mockImplementation(async ({ id }: { id: string }) => {
      if (id === 'one') throw new Error('boom');
      return {};
    });
    const { result } = renderHook(() => useDefaultEngine(), { wrapper });
    await waitFor(() => expect(result.current.agentId).toBe('a'));

    await act(async () => {
      await result.current.setDefault('b');
    });

    expect(mocks.store.get('agent.defaultAgentId')).toBe('b');
    expect(mocks.updateAssistant).toHaveBeenCalledTimes(2);
    expect(mocks.messageWarning).toHaveBeenCalledTimes(1);
    expect(mocks.messageWarning).toHaveBeenCalledWith('agent.engine.rebindFailed:Agent one');
  });

  it('setDefault still changes the default when the Agent list cannot be loaded', async () => {
    mocks.listAssistants.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useDefaultEngine(), { wrapper });
    await waitFor(() => expect(result.current.agentId).toBe('a'));

    await act(async () => {
      await result.current.setDefault('b');
    });

    expect(mocks.store.get('agent.defaultAgentId')).toBe('b');
    expect(mocks.messageWarning).toHaveBeenCalledTimes(1);
  });
});

describe('useEngineDriftSync', () => {
  beforeEach(() => {
    mocks.store.clear();
    mocks.messageWarning.mockReset();
    mocks.getManagedAgents.mockResolvedValue([agent('a'), agent('b')]);
    mocks.updateAssistant.mockReset().mockResolvedValue({});
  });

  it('re-binds an Agent that drifted off the default engine once at startup', async () => {
    mocks.listAssistants.mockResolvedValue([assistant('drifted', 'b'), assistant('ok', 'a')]);
    const { rerender } = renderHook(() => useEngineDriftSync(), { wrapper });

    await waitFor(() => expect(mocks.updateAssistant).toHaveBeenCalledWith({ id: 'drifted', agent_id: 'a' }));
    rerender();
    expect(mocks.updateAssistant).toHaveBeenCalledTimes(1);
  });

  it('does nothing when there is no engine to bind to', async () => {
    mocks.getManagedAgents.mockResolvedValue([]);
    mocks.listAssistants.mockResolvedValue([assistant('drifted', 'b')]);
    renderHook(() => useEngineDriftSync(), { wrapper });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mocks.updateAssistant).not.toHaveBeenCalled();
  });
});
