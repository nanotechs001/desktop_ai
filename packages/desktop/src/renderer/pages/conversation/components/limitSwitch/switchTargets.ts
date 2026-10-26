/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IProvider, TChatConversation } from '@/common/config/storage';
import { isConnectedEngine } from '@/common/types/agent/defaultAgent';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';
import {
  type BackendUsage,
  currentWindows,
  MAX_READING_AGE_MS,
  type SubscriptionUsageState,
  usageOfEngine,
} from './subscriptionUsage';

/** Continue on another CLI engine, on the picked model and thinking level (unset: the engine's own default). */
export type EngineTarget = { kind: 'engine'; engine: ManagedAgent; model?: string; thoughtLevel?: string };
/** Continue on the API-key model engine with one configured provider model. */
export type ModelTarget = { kind: 'model'; engine: ManagedAgent; provider: IProvider; model: string };
export type SwitchTarget = EngineTarget | ModelTarget;

export type SwitchTargets = {
  engines: ManagedAgent[];
  /** The model engine (aionrs) provider models run on; null when it cannot run now. */
  modelEngine: ManagedAgent | null;
  providers: { provider: IProvider; models: string[] }[];
  /** Engines (by id) still at their plan limit by the stored usage: when it resets (epoch seconds), null if unknown. */
  limitedUntil: Record<string, number | null>;
};

type ListSwitchTargetsParams = {
  conversation: TChatConversation;
  engines: readonly ManagedAgent[];
  providers: readonly IProvider[];
  getAvailableModels: (provider: IProvider) => string[];
  /** The stored plan usage, by engine backend (the subscription usage store). */
  usage?: SubscriptionUsageState;
  now?: number;
};

const MODEL_ENGINE_TYPE = 'aionrs';
/** A window at this fraction or more is used up until it resets. */
const LIMIT_REACHED = 1;

/**
 * When a recent reading's used-up windows all reset (epoch seconds; null when one gives no reset time); undefined
 * when no window is used up.
 */
function limitReachedUntil(usage: BackendUsage | undefined, now: number): number | null | undefined {
  if (!usage || now - usage.updated_at > MAX_READING_AGE_MS) return undefined;
  const resets = Object.values(currentWindows(usage, now))
    .filter((w) => w.utilization >= LIMIT_REACHED)
    .map((w) => w.resets_at);
  if (resets.length === 0) return undefined;
  return resets.includes(null) ? null : Math.max(...(resets as number[]));
}

/**
 * What a chat that hit a limit can switch to: other connected CLI engines, and the configured provider models the
 * model engine can run, both without the chat's current choice. The model engine is offered only through its models,
 * since a chat on it always needs one.
 */
export function listSwitchTargets({
  conversation,
  engines,
  providers,
  getAvailableModels,
  usage = {},
  now = Date.now(),
}: ListSwitchTargetsParams): SwitchTargets {
  const extra = conversation.extra as { agent_id?: string; backend?: string } | undefined;
  const isCurrent = (engine: ManagedAgent): boolean =>
    extra?.agent_id ? engine.id === extra.agent_id : Boolean(extra?.backend) && engine.backend === extra?.backend;
  const connected = engines.filter(isConnectedEngine);
  const modelEngine = connected.find((engine) => engine.agent_type === MODEL_ENGINE_TYPE) ?? null;
  const currentModel = conversation.type === MODEL_ENGINE_TYPE ? conversation.model : undefined;
  const targetEngines = connected.filter((engine) => engine.agent_type !== MODEL_ENGINE_TYPE && !isCurrent(engine));
  const limitedUntil: Record<string, number | null> = {};
  for (const engine of targetEngines) {
    const until = limitReachedUntil(usageOfEngine(usage, engine), now);
    if (until !== undefined) limitedUntil[engine.id] = until;
  }
  return {
    engines: targetEngines,
    limitedUntil,
    modelEngine,
    providers: modelEngine
      ? providers
          // The model engine does not support Google Auth (as in useAionrsModelSelection).
          .filter((provider) => !provider.platform?.toLowerCase().includes('gemini-with-google-auth'))
          .map((provider) => ({
            provider,
            models: getAvailableModels(provider).filter(
              (model) => !(currentModel?.id === provider.id && currentModel.use_model === model)
            ),
          }))
          .filter(({ models }) => models.length > 0)
      : [],
  };
}
