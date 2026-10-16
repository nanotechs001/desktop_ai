/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Built-in assistants that exist in the catalog but are never offered as Agents: the AionUi
 * Butler (`aionui-assistant`, also seen with the `builtin-` prefix). Filtered out of every
 * Agent list and picker; a chat opened for one is redirected to /guid.
 */
export const HIDDEN_AGENT_IDS: ReadonlySet<string> = new Set(['aionui-assistant', 'builtin-aionui-assistant']);

/** Whether an assistant id is one of the hidden Agents. */
export const isHiddenAgentId = (id: string | null | undefined): boolean => (id ? HIDDEN_AGENT_IDS.has(id) : false);

/** The list without the hidden Agents (returns a new array). */
export const withoutHiddenAgents = <T extends { id: string }>(items: readonly T[]): T[] =>
  items.filter((item) => !isHiddenAgentId(item.id));
