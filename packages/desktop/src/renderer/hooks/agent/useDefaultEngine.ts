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
import { fetchManagedAgents, MANAGED_AGENTS_SWR_KEY, type ManagedAgent } from '@/renderer/utils/model/agentTypes';
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

type SyncOutcome = { failed: Assistant[]; listFailed: boolean };

/** Re-bind drifted Agents to their engine. Never throws: failures are returned per Agent. */
async function syncEngineBindings(defaultId: string, engineIds: ReadonlySet<string>): Promise<SyncOutcome> {
  let assistants: Assistant[];
  try {
    assistants = await ipcBridge.assistants.list.invoke();
  } catch (error) {
    console.error('[engine] Failed to list Agents for re-binding:', error);
    return { failed: [], listFailed: true };
  }

  const plan = planEngineRebinds(assistants, defaultId, configService.get('agent.enginePins') ?? {}, engineIds);
  const results = await Promise.allSettled(
    plan.map(({ assistant, agentId }) => ipcBridge.assistants.update.invoke({ id: assistant.id, agent_id: agentId }))
  );
  const failed = plan.flatMap(({ assistant }, index) => {
    const result = results[index];
    if (result.status === 'fulfilled') return [];
    console.error(`[engine] Failed to re-bind Agent ${assistant.id}:`, result.reason);
    return [assistant];
  });
  if (plan.length > 0) await swrMutate('assistants.list');
  return { failed, listFailed: false };
}

/** Engine catalog plus its resolved default; shared by the hooks below. */
function useEngineState() {
  const { data, isLoading } = useSWR<ManagedAgent[]>(MANAGED_AGENTS_SWR_KEY, fetchManagedAgents);
  const [storedId] = useConfig('agent.defaultAgentId');
  const agents = useMemo(() => data ?? [], [data]);
  const agent = useMemo(() => resolveDefaultEngine(agents, storedId), [agents, storedId]);
  const engineIds = useMemo(() => new Set(agents.map((item) => item.id)), [agents]);
  return { agent, engineIds, loading: isLoading };
}

/** Sync bindings and surface failures as one warning per Agent (a failed list is one warning). */
function useReportedEngineSync() {
  const { t } = useTranslation();
  return useCallback(
    async (defaultId: string, engineIds: ReadonlySet<string>) => {
      const { failed, listFailed } = await syncEngineBindings(defaultId, engineIds);
      if (listFailed) Message.warning(t('agent.engine.rebindListFailed'));
      failed.forEach((assistant) => Message.warning(t('agent.engine.rebindFailed', { name: assistant.name })));
    },
    [t]
  );
}

export type UseDefaultEngineResult = {
  agent: ManagedAgent | null;
  agentId: string | null;
  setDefault: (id: string) => Promise<void>;
  loading: boolean;
};

/**
 * The default engine (Settings -> Engine). `setDefault` stores the choice and
 * then re-binds every unpinned Agent to it; re-bind errors only warn.
 */
export function useDefaultEngine(): UseDefaultEngineResult {
  const { agent, engineIds, loading } = useEngineState();
  const sync = useReportedEngineSync();

  const setDefault = useCallback(
    async (id: string) => {
      await configService.set('agent.defaultAgentId', id);
      await sync(id, engineIds);
    },
    [engineIds, sync]
  );

  return { agent, agentId: agent?.id ?? null, setDefault, loading };
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
    void sync(defaultId, engineIds);
  }, [defaultId, engineIds, sync]);
}
