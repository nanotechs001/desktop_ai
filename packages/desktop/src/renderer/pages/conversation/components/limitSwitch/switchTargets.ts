/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IProvider, TChatConversation } from '@/common/config/storage';
import { isConnectedEngine } from '@/common/types/agent/defaultAgent';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';

/** Continue on another CLI engine. */
export type EngineTarget = { kind: 'engine'; engine: ManagedAgent };
/** Continue on the API-key model engine with one configured provider model. */
export type ModelTarget = { kind: 'model'; engine: ManagedAgent; provider: IProvider; model: string };
export type SwitchTarget = EngineTarget | ModelTarget;

export type SwitchTargets = {
  engines: ManagedAgent[];
  /** The model engine (aionrs) provider models run on; null when it cannot run now. */
  modelEngine: ManagedAgent | null;
  providers: { provider: IProvider; models: string[] }[];
};

type ListSwitchTargetsParams = {
  conversation: TChatConversation;
  engines: readonly ManagedAgent[];
  providers: readonly IProvider[];
  getAvailableModels: (provider: IProvider) => string[];
};

const MODEL_ENGINE_TYPE = 'aionrs';

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
}: ListSwitchTargetsParams): SwitchTargets {
  const extra = conversation.extra as { agent_id?: string; backend?: string } | undefined;
  const isCurrent = (engine: ManagedAgent): boolean =>
    extra?.agent_id ? engine.id === extra.agent_id : Boolean(extra?.backend) && engine.backend === extra?.backend;
  const connected = engines.filter(isConnectedEngine);
  const modelEngine = connected.find((engine) => engine.agent_type === MODEL_ENGINE_TYPE) ?? null;
  const currentModel = conversation.type === MODEL_ENGINE_TYPE ? conversation.model : undefined;
  return {
    engines: connected.filter((engine) => engine.agent_type !== MODEL_ENGINE_TYPE && !isCurrent(engine)),
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
