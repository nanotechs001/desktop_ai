/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ICronJob } from '@/common/adapter/ipcBridge';
import { resolveAssistantAvatar } from '@renderer/utils/model/assistantAvatar';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { TFunction } from 'i18next';

/**
 * Resolve the display name and avatar for a cron job's Agent.
 *
 * Assistant-backed jobs display from the assistant catalog. Every other job (legacy rows, or an
 * assistant that no longer exists) shows the neutral "Agent" with the robot icon: the engine
 * behind a job (`agent_type`, `agent_config.name`) is never shown.
 */
export function getJobAgentMeta(
  job: ICronJob,
  presetAssistants: Assistant[],
  t: TFunction
): { name: string; logo?: string; emoji?: string; assistantFallback?: boolean } {
  const neutral = { name: t('agent.displayName'), assistantFallback: true };
  const assistantId = job.metadata.agent_config?.assistant_id;
  const assistant = assistantId ? presetAssistants.find((item) => item.id === assistantId) : undefined;
  if (!assistant) return neutral;

  const name = assistant.name || neutral.name;
  const avatar = resolveAssistantAvatar(assistant.avatar);
  if (avatar.kind === 'image') return { name, logo: avatar.value };
  if (avatar.kind === 'emoji') return { name, emoji: avatar.value };
  return { name, assistantFallback: true };
}
