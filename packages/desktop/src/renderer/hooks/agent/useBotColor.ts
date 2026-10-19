/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import { assignMissingBotColors, fallbackBotColor, isBotColor, pickNewBotColor } from '@/common/types/agent/botColors';
import { DEFAULT_AGENT_SETTING_KEY, isVaBotAgent } from '@/common/types/agent/defaultAgent';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import { useEffect } from 'react';

export type BotColors = Readonly<Record<string, string>>;

/**
 * The color of a VA Bot's dot: the stored one, else a stable color derived from its id so a dot never disappears.
 * Undefined when there is no id.
 */
export function useBotColor(agentId?: string): string | undefined {
  const [colors] = useConfig('agent.colors');
  if (!agentId) return undefined;
  const stored = colors?.[agentId];
  return isBotColor(stored) ? stored : fallbackBotColor(agentId);
}

type BotIdentity = { id?: string; source?: string };

/**
 * The color a dot shows for this Agent: a user-made VA Bot's color, nothing for built-in, engine-generated and
 * default Agents or a regular chat (the same rule the editor's Color row follows).
 */
export function useVaBotColor(assistant: BotIdentity | null | undefined): string | undefined {
  const [defaultAgentId] = useConfig(DEFAULT_AGENT_SETTING_KEY);
  const color = useBotColor(assistant?.id);
  return assistant?.source === 'user' && isVaBotAgent(assistant, defaultAgentId) ? color : undefined;
}

/**
 * Called after every write to `agent.colors` (create, delete, seed, editor save): tells main, which re-emits the colors
 * to every window so the widget windows (own renderers, own config cache) follow. Never throws: the colors are saved.
 */
export function afterBotColorsChanged(colors: BotColors): void {
  const warn = (error: unknown) => console.warn('[botColor] could not tell the other windows:', error);
  try {
    ipcBridge.agentWidget.broadcastBotColors.invoke({ ...colors }).catch(warn);
  } catch (error) {
    warn(error);
  }
}

/**
 * Widget windows: follow the colors the main window broadcasts. Only the local cache is updated, the backend was
 * already written by the window that changed them.
 */
export function useBotColorsSync(): void {
  useEffect(
    () => ipcBridge.agentWidget.botColorsChanged.on((colors) => configService.setLocal('agent.colors', colors)),
    []
  );
}

/** Store the whole color map, then tell the other surfaces. */
export async function writeBotColors(colors: BotColors): Promise<void> {
  await configService.set('agent.colors', { ...colors });
  afterBotColorsChanged(colors);
}

const storedColors = (): BotColors => configService.get('agent.colors') ?? {};

/** Set one bot's color; a value that is not `#rrggbb` is refused. */
export async function rememberBotColor(agentId: string, color: string): Promise<void> {
  if (!isBotColor(color)) return;
  await writeBotColors({ ...storedColors(), [agentId]: color });
}

/** Drop a deleted bot's entry; nothing is written when it had none. */
export async function forgetBotColor(agentId: string): Promise<void> {
  const { [agentId]: previous, ...others } = storedColors();
  if (previous === undefined) return;
  await writeBotColors(others);
}

/** A random palette color no stored bot color uses yet. */
export function newBotColor(random?: () => number): string {
  return pickNewBotColor(Object.values(storedColors()), random);
}

/**
 * Give every VA Bot that has no color one, in Agents-list order. Idempotent: it never overwrites a color and
 * writes nothing when none is missing. Before the settings are loaded the stored colors read as unset, so it waits.
 */
export async function seedBotColors(
  assistants: readonly Assistant[],
  storedDefaultId: string | undefined,
  random?: () => number
): Promise<void> {
  if (!configService.isInitialized()) return;
  const botIds = assistants
    .filter((assistant) => assistant.source === 'user' && isVaBotAgent(assistant, storedDefaultId))
    .toSorted((a, b) => a.sort_order - b.sort_order)
    .map((assistant) => assistant.id);
  const current = storedColors();
  if (botIds.every((id) => isBotColor(current[id]))) return;
  await writeBotColors(assignMissingBotColors(current, botIds, random));
}

/**
 * App-wide, main window only. Once the default Agent is known (otherwise it would look like a VA Bot), seeds the
 * colors of the bots that were made before colors existed.
 */
export function useBotColorSeed(): void {
  const [defaultAgentId] = useConfig(DEFAULT_AGENT_SETTING_KEY);
  useEffect(() => {
    if (!defaultAgentId) return;
    ipcBridge.assistants.list
      .invoke()
      .then((assistants) => seedBotColors(assistants, defaultAgentId))
      .catch((error: unknown) => console.warn('[botColor] could not seed the Agent colors:', error));
  }, [defaultAgentId]);
}
