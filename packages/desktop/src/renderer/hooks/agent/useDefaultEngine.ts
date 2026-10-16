/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import { isDeprecatedRuntimeAgentType } from '@/renderer/utils/model/agentTypeSupportPolicy';
import {
  ENGINE_CATALOG_SWR_KEY,
  fetchManagedAgentsOrThrow,
  type ManagedAgent,
} from '@/renderer/utils/model/agentTypes';
import { Message } from '@arco-design/web-react';
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR, { mutate as swrMutate } from 'swr';

/**
 * "Agent" is the user-made persona (an assistant record); an "engine" is a
 * connected AI account (a managed agent). The backend ignores per-chat engine
 * overrides, so an Agent runs on whatever `agent_id` its record carries and
 * this module keeps those bindings in step with the default engine.
 */

/** Assistant id -> engine id for Agents pinned to a specific engine. */
export type EnginePins = Readonly<Record<string, string>>;

type EngineRebind = { assistant: Assistant; agentId: string };

const isEligibleEngine = (agent: ManagedAgent): boolean =>
  agent.enabled !== false && !isDeprecatedRuntimeAgentType(agent.agent_type);

/**
 * The stored default if that engine still exists and is enabled; otherwise the
 * first enabled engine (preferring one that is actually installed); else null.
 */
export function resolveDefaultEngine(
  agents: readonly ManagedAgent[],
  storedId: string | undefined
): ManagedAgent | null {
  const eligible = agents.filter(isEligibleEngine);
  return (
    eligible.find((agent) => agent.id === storedId) ??
    eligible.find((agent) => agent.status !== 'missing') ??
    eligible[0] ??
    null
  );
}

/**
 * Agents whose `agent_id` differs from where they should run: their pin, or
 * the default engine when unpinned (or pinned to an engine that is gone).
 * Generated assistants are the engines' own bare CLI entries and never move.
 */
export function planEngineRebinds(
  assistants: readonly Assistant[],
  defaultId: string,
  pins: EnginePins,
  engineIds: ReadonlySet<string>
): EngineRebind[] {
  return assistants
    .filter((assistant) => assistant.source !== 'generated')
    .map((assistant) => {
      const pin = pins[assistant.id];
      return { assistant, agentId: pin && engineIds.has(pin) ? pin : defaultId };
    })
    .filter(({ assistant, agentId }) => assistant.agent_id !== agentId);
}

/** Pin an Agent to an engine, or clear the pin with `null`. */
export async function persistEnginePin(assistantId: string, engineId: string | null): Promise<void> {
  const { [assistantId]: _previous, ...others } = configService.get('agent.enginePins') ?? {};
  await configService.set('agent.enginePins', engineId ? { ...others, [assistantId]: engineId } : others);
}

/**
 * Engine ids differ in models, permission modes and thought levels, so an Agent that
 * changes engine drops its fixed values, exactly as the Agent editor does
 * (resetModelAndPermissionDefaults). Skills and MCPs are engine-independent and untouched.
 */
const ENGINE_CHANGE_DEFAULTS_RESET = {
  model: { mode: 'auto' },
  permission: { mode: 'auto' },
  thought_level: { mode: 'auto' },
};

/**
 * First run only (`agent.enginePins` never written): pin every Agent to the engine it already
 * runs on, so introducing a default engine moves nothing. The record is written even when empty
 * so seeding happens once. `persistDefault` also stores the resolved default, so an engine
 * detected later cannot silently move unpinned Agents.
 */
async function seedEnginePins(
  assistants: readonly Assistant[],
  defaultId: string,
  persistDefault: boolean
): Promise<void> {
  // Before the config is loaded `agent.enginePins` reads as unset; seeding then would overwrite the user's pins.
  if (!configService.isInitialized() || configService.get('agent.enginePins') != null) return;
  const pins = Object.fromEntries(
    assistants
      .filter((assistant) => assistant.source !== 'generated' && assistant.agent_id && assistant.agent_id !== defaultId)
      .map((assistant) => [assistant.id, assistant.agent_id])
  );
  await configService.set('agent.enginePins', pins);
  if (persistDefault && configService.get('agent.defaultAgentId') !== defaultId) {
    await configService.set('agent.defaultAgentId', defaultId);
  }
}

type SyncRequest = {
  defaultId: string;
  engineIds: ReadonlySet<string>;
  /** Engine to seed pins against (the current default when it is about to change). */
  seedFromId?: string;
  /** Store `defaultId` as the default after seeding and before re-binding. */
  commitDefault?: boolean;
};
type SyncOutcome = { failedCount: number; skipped: boolean };

/**
 * Seed pins on a first run, then re-bind drifted Agents to their engine. Failures come back in the
 * outcome; only a failed default write (`commitDefault`) throws. If the Agent list or the pins
 * cannot be handled nothing is re-bound.
 */
async function syncEngineBindings(request: SyncRequest): Promise<SyncOutcome> {
  const { defaultId, engineIds, seedFromId = defaultId, commitDefault = false } = request;
  const commit = () => (commitDefault ? configService.set('agent.defaultAgentId', defaultId) : Promise.resolve());

  // Without loaded settings pins and default are unknown: touch nothing (an explicit default choice is still stored).
  if (!configService.isInitialized()) {
    await commit();
    return { failedCount: 0, skipped: false };
  }

  let assistants: Assistant[];
  try {
    assistants = await ipcBridge.assistants.list.invoke();
  } catch (error) {
    console.error('[engine] Failed to list Agents for re-binding:', error);
    await commit();
    return { failedCount: 0, skipped: true };
  }

  let seeded = true;
  try {
    await seedEnginePins(assistants, seedFromId, !commitDefault);
  } catch (error) {
    console.error('[engine] Failed to seed engine pins:', error);
    seeded = false;
  }
  await commit();
  if (!seeded) return { failedCount: 0, skipped: true };

  const plan = planEngineRebinds(assistants, defaultId, configService.get('agent.enginePins') ?? {}, engineIds);
  const results = await Promise.allSettled(
    plan.map(({ assistant, agentId }) =>
      ipcBridge.assistants.update.invoke({
        id: assistant.id,
        agent_id: agentId,
        defaults: ENGINE_CHANGE_DEFAULTS_RESET,
      })
    )
  );
  const failedCount = results.filter((result, index) => {
    if (result.status === 'fulfilled') return false;
    console.error(`[engine] Failed to re-bind Agent ${plan[index].assistant.id}:`, result.reason);
    return true;
  }).length;
  if (plan.length > 0) await swrMutate('assistants.list');
  return { failedCount, skipped: false };
}

// Re-bind problems are reported once per app session so a persistent fault cannot nag on every change.
let engineSyncWarned = false;

/** @internal Forget that a re-bind warning was shown (tests only). */
export function resetEngineSyncSession(): void {
  engineSyncWarned = false;
}

/** Engine catalog plus its resolved default; shared by the hooks below. */
function useEngineState() {
  const { data, error, isLoading, mutate } = useSWR<ManagedAgent[]>(ENGINE_CATALOG_SWR_KEY, fetchManagedAgentsOrThrow);
  const [storedId] = useConfig('agent.defaultAgentId');
  const agents = useMemo(() => data ?? [], [data]);
  const agent = useMemo(() => resolveDefaultEngine(agents, storedId), [agents, storedId]);
  const engineIds = useMemo(() => new Set(agents.map((item) => item.id)), [agents]);
  // The resolved default can be a fallback that is not installed; "connected" asks for a usable one.
  const hasConnectedEngine = useMemo(
    () => agents.some((item) => isEligibleEngine(item) && item.status !== 'missing'),
    [agents]
  );
  const retry = useCallback(() => mutate(), [mutate]);
  // Only a failure with nothing to show counts: a failed background refresh keeps the last good list.
  return {
    agent,
    engineIds,
    loading: isLoading,
    error: Boolean(error) && data === undefined,
    hasConnectedEngine,
    retry,
  };
}

/**
 * Sync bindings and surface problems as one warning with a count of failed Agents. A background
 * sync (`reportOnce`) warns at most once per session; the user's own action always reports.
 */
function useReportedEngineSync() {
  const { t } = useTranslation();
  return useCallback(
    async (request: SyncRequest, reportOnce = false) => {
      const { failedCount, skipped } = await syncEngineBindings(request);
      if (!skipped && failedCount === 0) return;
      if (reportOnce) {
        if (engineSyncWarned) return;
        engineSyncWarned = true;
      }
      Message.warning(
        skipped ? t('agent.engine.rebindListFailed') : t('agent.engine.rebindFailed', { count: failedCount })
      );
    },
    [t]
  );
}

export type UseDefaultEngineResult = {
  agent: ManagedAgent | null;
  agentId: string | null;
  setDefault: (id: string) => Promise<void>;
  loading: boolean;
  /** The engine list could not be loaded (as opposed to there being no usable engine). */
  error: boolean;
  /** At least one enabled engine is installed; false when all are missing or there are none. */
  hasConnectedEngine: boolean;
  /** Reload the engine list after an error. */
  retry: () => Promise<unknown>;
};

/**
 * The default engine (Settings -> Engine). `setDefault` seeds pins on a first run, stores the
 * choice and then re-binds every unpinned Agent to it; re-bind errors only warn.
 */
export function useDefaultEngine(): UseDefaultEngineResult {
  const { agent, engineIds, loading, error, hasConnectedEngine, retry } = useEngineState();
  const sync = useReportedEngineSync();
  const currentId = agent?.id;

  const setDefault = useCallback(
    async (id: string) => {
      await sync({ defaultId: id, engineIds, seedFromId: currentId ?? id, commitDefault: true });
    },
    [currentId, engineIds, sync]
  );

  return { agent, agentId: currentId ?? null, setDefault, loading, error, hasConnectedEngine, retry };
}

/** Once per app session, re-bind Agents that drifted off their engine. Mount it app-wide. */
export function useEngineDriftSync(): void {
  const { agent, engineIds } = useEngineState();
  const sync = useReportedEngineSync();
  const doneRef = useRef(false);
  const defaultId = agent?.id;

  useEffect(() => {
    if (!defaultId || doneRef.current) return;
    doneRef.current = true;
    void sync({ defaultId, engineIds }, true);
  }, [defaultId, engineIds, sync]);
}
