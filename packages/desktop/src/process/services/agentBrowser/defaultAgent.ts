/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { httpRequest, isBackendHttpError } from '@/common/adapter/httpBridge';
import type { Assistant } from '@/common/types/agent/assistantTypes';

/** Name of the Agent that always exists. */
export const DEFAULT_AGENT_NAME = 'Agent';
/** Id the default Agent is created with; a duplicate create answers 409. */
export const DEFAULT_AGENT_ID = 'aion-default-agent';

const BUILTIN_DEFAULT_ID_KEY = 'agent.builtinDefaultId';
const DEFAULT_ENGINE_KEY = 'agent.defaultAgentId';
/** Engine types the app no longer runs (mirrors the renderer's deprecated list). */
const DEPRECATED_ENGINE_TYPES = new Set(['openclaw-gateway', 'nanobot', 'remote', 'gemini']);

/** The fields of a managed agent (engine) this module reads. */
export type EngineEntry = { id: string; enabled?: boolean; status?: string; agent_type?: string };

export type DefaultAgentDeps = {
  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;
  listAssistants(): Promise<{ id: string; name: string; source: string }[]>;
  listEngines(): Promise<EngineEntry[]>;
  /** Resolves `exists` instead of throwing when the backend answers 409. */
  createAssistant(request: { id: string; name: string; agent_id: string }): Promise<'created' | 'exists'>;
};

const isEligible = (engine: EngineEntry): boolean =>
  engine.enabled !== false && !DEPRECATED_ENGINE_TYPES.has(engine.agent_type ?? '');

/**
 * The engine Agents run on by default: the stored choice while it is enabled, else the first
 * installed enabled engine, else the first enabled one. Same order as the renderer's useDefaultEngine.
 */
export function pickDefaultEngineId(engines: readonly EngineEntry[], storedId: string | undefined): string | null {
  const eligible = engines.filter(isEligible);
  return (
    (
      eligible.find((engine) => engine.id === storedId) ??
      eligible.find((engine) => engine.status !== 'missing') ??
      eligible[0]
    )?.id ?? null
  );
}

/**
 * Make sure the undeletable default Agent exists. Looks it up by the stored id, then by name, and
 * creates it last, bound to the default engine. Returns null (and creates nothing) while there is
 * no engine, so the next start retries.
 */
export async function ensureDefaultAgent(deps: DefaultAgentDeps): Promise<{ id: string; created: boolean } | null> {
  const [storedId, assistants] = await Promise.all([deps.getSetting(BUILTIN_DEFAULT_ID_KEY), deps.listAssistants()]);
  const existing =
    assistants.find((assistant) => assistant.id === storedId) ??
    assistants.find((assistant) => assistant.source === 'user' && assistant.name === DEFAULT_AGENT_NAME);
  if (existing) {
    if (existing.id !== storedId) await deps.setSetting(BUILTIN_DEFAULT_ID_KEY, existing.id);
    return { id: existing.id, created: false };
  }

  const engineId = pickDefaultEngineId(await deps.listEngines(), await deps.getSetting(DEFAULT_ENGINE_KEY));
  if (!engineId) return null;

  const outcome = await deps.createAssistant({ id: DEFAULT_AGENT_ID, name: DEFAULT_AGENT_NAME, agent_id: engineId });
  await deps.setSetting(BUILTIN_DEFAULT_ID_KEY, DEFAULT_AGENT_ID);
  return { id: DEFAULT_AGENT_ID, created: outcome === 'created' };
}

/** Backend-wired deps. */
export const backendDefaultAgentDeps: DefaultAgentDeps = {
  async getSetting(key) {
    const data = await httpRequest<Record<string, string | undefined>>(
      'GET',
      `/api/settings/client?keys=${encodeURIComponent(key)}`
    );
    return data?.[key];
  },
  async setSetting(key, value) {
    await httpRequest<void>('PUT', '/api/settings/client', { [key]: value });
  },
  async listAssistants() {
    const all = await httpRequest<Assistant[]>('GET', '/api/assistants');
    return (all ?? []).map(({ id, name, source }) => ({ id, name, source }));
  },
  async listEngines() {
    return (await httpRequest<EngineEntry[]>('GET', '/api/agents/management')) ?? [];
  },
  async createAssistant(request) {
    try {
      await httpRequest<Assistant>('POST', '/api/assistants', request);
      return 'created';
    } catch (error) {
      if (isBackendHttpError(error) && error.status === 409) return 'exists';
      throw error;
    }
  },
};
