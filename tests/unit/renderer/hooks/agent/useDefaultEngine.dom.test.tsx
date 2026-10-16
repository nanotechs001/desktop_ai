/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import React from 'react';
import i18next from 'i18next';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';
import enAgent from '@/renderer/services/i18n/locales/en-US/agent.json';
import ruAgent from '@/renderer/services/i18n/locales/ru-RU/agent.json';

const mocks = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  const subscribers = new Map<string, Set<(value: unknown) => void>>();
  const notify = (key: string, value: unknown) => subscribers.get(key)?.forEach((callback) => callback(value));
  const state = { initialized: true };
  return {
    store,
    subscribers,
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
    t: (key: string, options?: Record<string, unknown>) =>
      options?.count !== undefined ? `${key}:${String(options.count)}` : key,
  }),
}));

vi.mock('@arco-design/web-react', () => ({
  Message: { warning: mocks.messageWarning },
}));

import {
  persistEnginePin,
  planEngineRebinds,
  resetEngineSyncSession,
  resolveDefaultEngine,
  useDefaultEngine,
  useEngineDriftSync,
} from '@/renderer/hooks/agent/useDefaultEngine';

/** What the editor applies when an Agent's engine changes (resetModelAndPermissionDefaults). */
const DEFAULTS_RESET = {
  model: { mode: 'auto' },
  permission: { mode: 'auto' },
  thought_level: { mode: 'auto' },
};

// Hooks stay mounted otherwise and keep reacting to the shared config store in later tests.
afterEach(cleanup);

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
    resetEngineSyncSession();
    mocks.state.initialized = true;
    mocks.store.clear();
    mocks.store.set('agent.enginePins', {});
    mocks.configService.set.mockClear();
    mocks.messageWarning.mockReset();
    mocks.getManagedAgents.mockResolvedValue([agent('a'), agent('b')]);
    mocks.listAssistants.mockReset().mockResolvedValue([]);
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
    expect(mocks.updateAssistant).toHaveBeenCalledWith({ id: 'free', agent_id: 'b', defaults: DEFAULTS_RESET });
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
    expect(mocks.messageWarning).toHaveBeenCalledWith('agent.engine.rebindFailed:1');
  });

  it('collapses several failed re-binds into one toast with a count', async () => {
    mocks.listAssistants.mockResolvedValue([assistant('one', 'a'), assistant('two', 'a'), assistant('three', 'a')]);
    mocks.updateAssistant.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useDefaultEngine(), { wrapper });
    await waitFor(() => expect(result.current.agentId).toBe('a'));

    await act(async () => {
      await result.current.setDefault('b');
    });

    expect(mocks.messageWarning).toHaveBeenCalledTimes(1);
    expect(mocks.messageWarning).toHaveBeenCalledWith('agent.engine.rebindFailed:3');
  });

  it("always reports a failure of the user's own setDefault, even after an earlier warning", async () => {
    mocks.listAssistants.mockResolvedValue([assistant('one', 'a')]);
    mocks.updateAssistant.mockRejectedValue(new Error('boom'));
    const { result } = renderHook(() => useDefaultEngine(), { wrapper });
    await waitFor(() => expect(result.current.agentId).toBe('a'));

    await act(async () => {
      await result.current.setDefault('b');
    });
    mocks.listAssistants.mockResolvedValue([assistant('one', 'b')]);
    await act(async () => {
      await result.current.setDefault('a');
    });

    expect(mocks.updateAssistant).toHaveBeenCalledTimes(2);
    expect(mocks.messageWarning).toHaveBeenCalledTimes(2);
  });

  it('sends the same model/permission/thought-level reset the editor applies when the engine changes', async () => {
    mocks.listAssistants.mockResolvedValue([assistant('free', 'a')]);
    const { result } = renderHook(() => useDefaultEngine(), { wrapper });
    await waitFor(() => expect(result.current.agentId).toBe('a'));

    await act(async () => {
      await result.current.setDefault('b');
    });

    const [request] = mocks.updateAssistant.mock.calls[0];
    expect(request.defaults).toEqual(DEFAULTS_RESET);
    expect(Object.keys(request.defaults)).not.toContain('skills');
    expect(Object.keys(request.defaults)).not.toContain('mcps');
  });

  it('reports a catalog fetch error explicitly, and retry loads the engines', async () => {
    mocks.getManagedAgents.mockRejectedValue(new Error('backend down'));
    const { result } = renderHook(() => useDefaultEngine(), { wrapper });

    await waitFor(() => expect(result.current.error).toBe(true));
    expect(result.current.agentId).toBeNull();

    mocks.getManagedAgents.mockResolvedValue([agent('a')]);
    await act(async () => {
      await result.current.retry();
    });

    await waitFor(() => expect(result.current.agentId).toBe('a'));
    expect(result.current.error).toBe(false);
  });

  it('does not treat an empty catalog as an error', async () => {
    mocks.getManagedAgents.mockResolvedValue([]);
    const { result } = renderHook(() => useDefaultEngine(), { wrapper });

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.error).toBe(false);
    expect(result.current.hasConnectedEngine).toBe(false);
  });

  it('has no connected engine when every enabled engine is missing, though a fallback id still resolves', async () => {
    mocks.getManagedAgents.mockResolvedValue([agent('a', { status: 'missing' }), agent('b', { status: 'missing' })]);
    const { result } = renderHook(() => useDefaultEngine(), { wrapper });

    await waitFor(() => expect(result.current.agentId).toBe('a'));
    expect(result.current.hasConnectedEngine).toBe(false);
  });

  it('has a connected engine as soon as one enabled engine is not missing', async () => {
    mocks.getManagedAgents.mockResolvedValue([agent('a', { status: 'missing' }), agent('b', { status: 'unchecked' })]);
    const { result } = renderHook(() => useDefaultEngine(), { wrapper });

    await waitFor(() => expect(result.current.hasConnectedEngine).toBe(true));
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
    resetEngineSyncSession();
    mocks.state.initialized = true;
    mocks.store.clear();
    mocks.configService.set.mockClear();
    mocks.store.set('agent.enginePins', {});
    mocks.messageWarning.mockReset();
    mocks.getManagedAgents.mockResolvedValue([agent('a'), agent('b')]);
    mocks.listAssistants.mockReset();
    mocks.updateAssistant.mockReset().mockResolvedValue({});
  });

  it('re-binds an Agent that drifted off the default engine once at startup', async () => {
    mocks.listAssistants.mockResolvedValue([assistant('drifted', 'b'), assistant('ok', 'a')]);
    const { rerender } = renderHook(() => useEngineDriftSync(), { wrapper });

    await waitFor(() =>
      expect(mocks.updateAssistant).toHaveBeenCalledWith({ id: 'drifted', agent_id: 'a', defaults: DEFAULTS_RESET })
    );
    rerender();
    expect(mocks.updateAssistant).toHaveBeenCalledTimes(1);
  });

  it('warns about background re-bind failures only once per session', async () => {
    mocks.listAssistants.mockResolvedValue([assistant('drifted', 'b')]);
    mocks.updateAssistant.mockRejectedValue(new Error('boom'));

    const first = renderHook(() => useEngineDriftSync(), { wrapper });
    await waitFor(() => expect(mocks.messageWarning).toHaveBeenCalledTimes(1));
    first.unmount();

    renderHook(() => useEngineDriftSync(), { wrapper });
    await waitFor(() => expect(mocks.updateAssistant).toHaveBeenCalledTimes(2));
    expect(mocks.messageWarning).toHaveBeenCalledTimes(1);
  });

  it('does nothing while the config service is not initialized (a failed init would read pins as unset)', async () => {
    mocks.state.initialized = false;
    mocks.store.clear();
    mocks.listAssistants.mockResolvedValue([assistant('drifted', 'b')]);
    const { result } = renderHook(
      () => {
        useEngineDriftSync();
        return useDefaultEngine();
      },
      { wrapper }
    );

    await waitFor(() => expect(result.current.agentId).toBe('a'));
    expect(mocks.configService.set).not.toHaveBeenCalled();
    expect(mocks.updateAssistant).not.toHaveBeenCalled();
    expect(mocks.messageWarning).not.toHaveBeenCalled();
  });

  it('does nothing when there is no engine to bind to', async () => {
    mocks.getManagedAgents.mockResolvedValue([]);
    mocks.listAssistants.mockResolvedValue([assistant('drifted', 'b')]);
    const { result } = renderHook(
      () => {
        useEngineDriftSync();
        return useDefaultEngine();
      },
      { wrapper }
    );

    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mocks.listAssistants).not.toHaveBeenCalled();
    expect(mocks.updateAssistant).not.toHaveBeenCalled();
  });

  it('does not sync a second time when setDefault changes the default with the drift hook mounted', async () => {
    mocks.listAssistants.mockResolvedValue([assistant('x', 'a')]);
    const { result } = renderHook(
      () => {
        useEngineDriftSync();
        return useDefaultEngine();
      },
      { wrapper }
    );
    await waitFor(() => expect(mocks.listAssistants).toHaveBeenCalledTimes(1));

    await act(async () => {
      await result.current.setDefault('b');
    });
    await waitFor(() => expect(result.current.agentId).toBe('b'));

    // one sync from startup drift + exactly one from setDefault; the new default did not re-trigger drift
    expect(mocks.listAssistants).toHaveBeenCalledTimes(2);
    expect(mocks.updateAssistant).toHaveBeenCalledTimes(1);
  });
});

describe('first-run pin seeding (Ruling N-9)', () => {
  const pinWrites = () => mocks.configService.set.mock.calls.filter(([key]) => key === 'agent.enginePins');
  const writeOrder = () => mocks.configService.set.mock.calls.map(([key]) => key);

  beforeEach(() => {
    resetEngineSyncSession();
    mocks.state.initialized = true;
    mocks.store.clear();
    mocks.configService.set.mockClear();
    mocks.messageWarning.mockReset();
    mocks.getManagedAgents.mockResolvedValue([agent('a'), agent('b'), agent('c')]);
    mocks.listAssistants.mockReset();
    mocks.updateAssistant.mockReset().mockResolvedValue({});
  });

  it('seeds a pin for every Agent off the default engine and re-binds nothing on a first run', async () => {
    mocks.listAssistants.mockResolvedValue([
      assistant('on-default', 'a'),
      assistant('elsewhere', 'b'),
      assistant('bare:c', 'c', { source: 'generated' }),
    ]);
    renderHook(() => useEngineDriftSync(), { wrapper });

    await waitFor(() => expect(mocks.store.get('agent.defaultAgentId')).toBe('a'));
    expect(mocks.store.get('agent.enginePins')).toEqual({ elsewhere: 'b' });
    expect(mocks.updateAssistant).not.toHaveBeenCalled();
    // pins land before the default is persisted
    expect(writeOrder()).toEqual(['agent.enginePins', 'agent.defaultAgentId']);
  });

  it('writes the record even when nothing needs pinning, so seeding runs once', async () => {
    mocks.listAssistants.mockResolvedValue([assistant('on-default', 'a')]);
    renderHook(() => useEngineDriftSync(), { wrapper });

    await waitFor(() => expect(mocks.store.get('agent.enginePins')).toEqual({}));
    expect(mocks.store.get('agent.defaultAgentId')).toBe('a');
  });

  it('on a later run re-binds only the unpinned Agents', async () => {
    mocks.store.set('agent.enginePins', { elsewhere: 'b' });
    mocks.store.set('agent.defaultAgentId', 'a');
    mocks.listAssistants.mockResolvedValue([assistant('elsewhere', 'b'), assistant('unpinned', 'c')]);
    renderHook(() => useEngineDriftSync(), { wrapper });

    await waitFor(() => expect(mocks.updateAssistant).toHaveBeenCalledTimes(1));
    expect(mocks.updateAssistant).toHaveBeenCalledWith({ id: 'unpinned', agent_id: 'a', defaults: DEFAULTS_RESET });
    expect(pinWrites()).toEqual([]);
  });

  it('setDefault on a first run seeds against the current default before re-binding', async () => {
    mocks.listAssistants.mockResolvedValue([assistant('x', 'a'), assistant('y', 'b')]);
    const { result } = renderHook(() => useDefaultEngine(), { wrapper });
    await waitFor(() => expect(result.current.agentId).toBe('a'));

    await act(async () => {
      await result.current.setDefault('c');
    });

    // y was on b, not the old default a, so it stays; x follows the default to c
    expect(mocks.store.get('agent.enginePins')).toEqual({ y: 'b' });
    expect(mocks.store.get('agent.defaultAgentId')).toBe('c');
    expect(writeOrder()).toEqual(['agent.enginePins', 'agent.defaultAgentId']);
    expect(mocks.updateAssistant).toHaveBeenCalledTimes(1);
    expect(mocks.updateAssistant).toHaveBeenCalledWith({ id: 'x', agent_id: 'c', defaults: DEFAULTS_RESET });
  });

  it('seeds nothing and writes nothing when the Agent list fails to load', async () => {
    mocks.listAssistants.mockRejectedValue(new Error('offline'));
    renderHook(() => useEngineDriftSync(), { wrapper });

    await waitFor(() => expect(mocks.messageWarning).toHaveBeenCalledTimes(1));
    expect(mocks.configService.set).not.toHaveBeenCalled();
    expect(mocks.updateAssistant).not.toHaveBeenCalled();
  });

  it('re-binds nothing when the pins cannot be written', async () => {
    mocks.listAssistants.mockResolvedValue([assistant('elsewhere', 'b')]);
    mocks.configService.set.mockRejectedValueOnce(new Error('disk'));
    renderHook(() => useEngineDriftSync(), { wrapper });

    await waitFor(() => expect(mocks.messageWarning).toHaveBeenCalledTimes(1));
    expect(mocks.updateAssistant).not.toHaveBeenCalled();
  });

  it('setDefault while the config service is not initialized stores only the default: no seeding, no re-bind', async () => {
    mocks.state.initialized = false;
    mocks.listAssistants.mockResolvedValue([assistant('x', 'a'), assistant('y', 'b')]);
    const { result } = renderHook(() => useDefaultEngine(), { wrapper });
    await waitFor(() => expect(result.current.agentId).toBe('a'));

    await act(async () => {
      await result.current.setDefault('c');
    });

    expect(writeOrder()).toEqual(['agent.defaultAgentId']);
    expect(mocks.store.has('agent.enginePins')).toBe(false);
    expect(mocks.updateAssistant).not.toHaveBeenCalled();
  });
});

describe('rebind failure wording', () => {
  const translate = async (lng: string, resource: object, count: number) => {
    const instance = i18next.createInstance();
    await instance.init({ lng, fallbackLng: lng, resources: { [lng]: { translation: resource } } });
    return instance.t('engine.rebindFailed', { count });
  };

  it('reads "1 Agent" for a count of one and "N Agents" otherwise', async () => {
    expect(await translate('en-US', enAgent, 1)).toBe('Could not update the engine for 1 Agent.');
    expect(await translate('en-US', enAgent, 3)).toBe('Could not update the engine for 3 Agents.');
  });

  it('uses the Russian plural categories', async () => {
    expect(await translate('ru-RU', ruAgent, 1)).toContain('1 агента');
    expect(await translate('ru-RU', ruAgent, 3)).toContain('3 агентов');
  });
});
