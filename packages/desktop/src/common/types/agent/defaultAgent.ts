/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Name of the Agent that always exists. */
export const DEFAULT_AGENT_NAME = 'Agent';
/** Id the default Agent is created with; a duplicate create answers 409. */
export const DEFAULT_AGENT_ID = 'aion-default-agent';
/** Client setting that remembers which assistant is the default Agent. */
export const DEFAULT_AGENT_SETTING_KEY = 'agent.builtinDefaultId';

/** Engine types the app no longer runs. */
export const DEPRECATED_ENGINE_TYPES: ReadonlySet<string> = new Set([
  'openclaw-gateway',
  'nanobot',
  'remote',
  'gemini',
]);

/** The fields of a managed agent (engine) the default-engine choice reads. */
export type EngineEntry = { id: string; enabled?: boolean; status?: string; agent_type?: string };

/** An engine that may run Agents: enabled and not a deprecated type. */
export const isEligibleEngine = (engine: EngineEntry): boolean =>
  engine.enabled !== false && !DEPRECATED_ENGINE_TYPES.has(engine.agent_type ?? '');

/**
 * The engine Agents run on by default: the stored choice while it is enabled, else the first
 * installed enabled engine, else the first enabled one.
 */
export function pickDefaultEngineId(engines: readonly EngineEntry[], storedId: string | undefined): string | null {
  const eligible = engines.filter(isEligibleEngine);
  return (
    (
      eligible.find((engine) => engine.id === storedId) ??
      eligible.find((engine) => engine.status !== 'missing') ??
      eligible[0]
    )?.id ?? null
  );
}

/**
 * The default Agent can never be deleted. Its id is fixed, so it is protected even before the
 * stored id reaches the renderer's settings cache; an adopted Agent is protected by the stored id.
 */
export const isUndeletableAgent = (assistantId: string, storedDefaultId: string | undefined): boolean =>
  assistantId === DEFAULT_AGENT_ID || assistantId === storedDefaultId;

/**
 * A VA Bot is an Agent the user created: not the built-in default Agent, not a built-in preset.
 * VA Bot conversations get the persistent browser profile, the browser-on-top layout and the
 * taskbar robot; every other conversation is a regular chat with a temporary browser.
 */
export const isVaBotAgent = (
  assistant: { id?: string; source?: string } | null | undefined,
  storedDefaultId: string | undefined
): boolean => {
  const id = assistant?.id;
  return Boolean(id) && assistant?.source !== 'builtin' && !isUndeletableAgent(id as string, storedDefaultId);
};
