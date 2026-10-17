/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import ThemedLogo from '@/renderer/components/agent/ThemedLogo';
import type { PresetAssistantInfo } from '@/renderer/hooks/agent/usePresetAssistantInfo';
import { iconColors } from '@/renderer/styles/colors';
import { resolveAssistantAvatar } from '@/renderer/utils/model/assistantAvatar';
import { Robot } from '@icon-park/react';
import type { TFunction } from 'i18next';
import React from 'react';

/** The user-made Agent a chat belongs to. */
export type AgentIdentity = { name?: string; avatar?: string };

export type AgentPresentation = { name: string; avatar: React.ReactNode };

const DEFAULT_AVATAR_SIZE_PX = 16;
/** Emoji glyphs fill less of their box than icons do. */
const EMOJI_SIZE_RATIO = 0.875;

/**
 * Name and avatar a chat shows for its Agent. Never a vendor or engine name: with no Agent, or an
 * Agent without a name or avatar, it falls back to "Agent" and the robot icon. `size` is the avatar
 * edge in pixels.
 */
export function getAgentPresentation(
  agent: AgentIdentity | null | undefined,
  t: TFunction,
  size: number = DEFAULT_AVATAR_SIZE_PX
): AgentPresentation {
  const name = agent?.name?.trim() || t('agent.displayName');
  const avatar = resolveAssistantAvatar(agent?.avatar);

  if (avatar.kind === 'image') {
    return {
      name,
      avatar: React.createElement(ThemedLogo, {
        src: avatar.value,
        alt: `${name} logo`,
        className: 'block object-contain',
        style: { width: size, height: size },
      }),
    };
  }
  if (avatar.kind === 'emoji') {
    return {
      name,
      avatar: React.createElement(
        'span',
        { className: 'leading-none', style: { fontSize: Math.round(size * EMOJI_SIZE_RATIO) } },
        avatar.value
      ),
    };
  }
  return {
    name,
    avatar: React.createElement(Robot, { theme: 'outline', size, fill: iconColors.primary }),
  };
}

/** True for an engine's own entry (a bare CLI record named and drawn after its vendor), which is not an Agent. */
export const isEngineEntry = (record: { source?: string } | null | undefined): boolean =>
  record?.source === 'generated';

/**
 * The records an Agent picker may offer: every Agent, without the engines' own entries. Built-in presets
 * (`source: 'builtin'`) are Agents and stay in (ruling N-21).
 */
export const pickableAgents = <T extends { source?: string }>(records: readonly T[]): T[] =>
  records.filter((record) => !isEngineEntry(record));

/**
 * The Agent a resolved conversation identity names. Only assistant records are Agents, and not every one: identities
 * usePresetAssistantInfo derives from `extra.agent_name` / `extra.backend`, and an engine's own generated entry,
 * carry the engine's vendor name and logo, so they yield null.
 */
export function agentFromPresetInfo(info: PresetAssistantInfo | null | undefined): AgentIdentity | null {
  if (!info?.assistantId || isEngineEntry(info)) return null;
  return { name: info.name, avatar: info.logo };
}
