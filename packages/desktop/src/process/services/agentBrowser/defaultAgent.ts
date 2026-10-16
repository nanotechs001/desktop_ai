/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { httpRequest, isBackendHttpError } from '@/common/adapter/httpBridge';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import {
  DEFAULT_AGENT_ID,
  DEFAULT_AGENT_NAME,
  DEFAULT_AGENT_SETTING_KEY,
  pickDefaultEngineId,
  type EngineEntry,
} from '@/common/types/agent/defaultAgent';
import { backendAssistantRuleDeps, ensureBrowserRuleForAssistant, type AssistantRuleDeps } from './assistantRules';

const DEFAULT_ENGINE_KEY = 'agent.defaultAgentId';

export type DefaultAgentDeps = {
  getSetting(key: string): Promise<string | undefined>;
  setSetting(key: string, value: string): Promise<void>;
  listAssistants(): Promise<{ id: string; name: string; source: string }[]>;
  listEngines(): Promise<EngineEntry[]>;
  /** Resolves `exists` instead of throwing when the backend answers 409. */
  createAssistant(request: { id: string; name: string; agent_id: string }): Promise<'created' | 'exists'>;
};

/**
 * Make sure the undeletable default Agent exists. Looks it up by the stored id, then by name, and
 * creates it last, bound to the default engine. Returns null (and creates nothing) while there is
 * no engine, so the next start retries.
 */
export async function ensureDefaultAgent(deps: DefaultAgentDeps): Promise<{ id: string; created: boolean } | null> {
  const [storedId, assistants] = await Promise.all([deps.getSetting(DEFAULT_AGENT_SETTING_KEY), deps.listAssistants()]);
  // A name match is adopted only before any id is stored, and only when the user made it.
  const existing = storedId
    ? assistants.find((assistant) => assistant.id === storedId)
    : assistants.find((assistant) => assistant.source === 'user' && assistant.name === DEFAULT_AGENT_NAME);
  if (existing) {
    if (existing.id !== storedId) await deps.setSetting(DEFAULT_AGENT_SETTING_KEY, existing.id);
    return { id: existing.id, created: false };
  }

  const engineId = pickDefaultEngineId(await deps.listEngines(), await deps.getSetting(DEFAULT_ENGINE_KEY));
  if (!engineId) return null;

  const outcome = await deps.createAssistant({ id: DEFAULT_AGENT_ID, name: DEFAULT_AGENT_NAME, agent_id: engineId });
  await deps.setSetting(DEFAULT_AGENT_SETTING_KEY, DEFAULT_AGENT_ID);
  return { id: DEFAULT_AGENT_ID, created: outcome === 'created' };
}

/**
 * Create the default Agent if it is missing, give it the rule block and tell the renderer its id,
 * so its settings cache protects the Agent from deletion at once. Null while there is no engine.
 */
export async function setUpDefaultAgent(options: {
  deps?: DefaultAgentDeps;
  ruleDeps?: AssistantRuleDeps;
  notify: (id: string) => void;
}): Promise<{ id: string; created: boolean } | null> {
  const result = await ensureDefaultAgent(options.deps ?? backendDefaultAgentDeps);
  if (!result) return null;
  if (result.created) await ensureBrowserRuleForAssistant(options.ruleDeps ?? backendAssistantRuleDeps, result.id);
  options.notify(result.id);
  return result;
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
