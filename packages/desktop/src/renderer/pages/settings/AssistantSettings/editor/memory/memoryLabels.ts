/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MemoryNoteMeta, MemoryNoteType, MemoryVaultRef } from '@/common/types/agent/memory';

/** The pinned facts (CORE.md) that are always in the agent's rule. */
export const MEMORY_CORE_MAX_CHARS = 1500;

export const SHARED_VAULT: MemoryVaultRef = { kind: 'shared' };

/** i18n key of a note type's label (`instructions` reads as an instruction to the agent). */
export const memoryTypeKey = (type: MemoryNoteType): string => `agent.memory.types.${type}`;

/** i18n key of who wrote a note; in the shared memory an agent's note is labelled as written by an agent. */
export const memorySourceKey = (note: Pick<MemoryNoteMeta, 'source'>, shared: boolean): string =>
  shared && note.source === 'agent' ? 'agent.memory.source.sharedAgent' : `agent.memory.source.${note.source}`;

export const MEMORY_SOURCE_COLORS: Record<MemoryNoteMeta['source'], string> = {
  user: 'green',
  agent: 'arcoblue',
  page: 'orange',
};

/** Notes whose title, summary or tags contain `query` (case-insensitive), of `type` unless it is 'all'. */
export const filterMemoryNotes = (
  notes: readonly MemoryNoteMeta[],
  query: string,
  type: MemoryNoteType | 'all'
): MemoryNoteMeta[] => {
  const needle = query.trim().toLowerCase();
  return notes.filter(
    (note) =>
      (type === 'all' || note.type === type) &&
      (!needle || [note.title, note.summary, ...note.tags].some((text) => text.toLowerCase().includes(needle)))
  );
};

/** The core with a pinned "- title: summary" line added at the end. */
export const pinToCore = (core: string, note: Pick<MemoryNoteMeta, 'title' | 'summary'>): string => {
  const line = note.summary ? `- ${note.title}: ${note.summary}` : `- ${note.title}`;
  return core.trim() ? `${core.trimEnd()}\n${line}` : line;
};

/** The bare codes a failed agentMemory reply carries in `msg`, and the i18n key of each. */
const MEMORY_ERROR_KEYS = new Map<string | undefined, string>([
  ['invalid', 'agent.memory.errors.invalid'],
  ['not-found', 'agent.memory.errors.notFound'],
  ['stale', 'agent.memory.errors.stale'],
  ['limit-reached', 'agent.memory.errors.limitReached'],
  ['conflict', 'agent.memory.errors.conflict'],
  ['io', 'agent.memory.errors.io'],
  ['forbidden', 'agent.memory.errors.forbidden'],
]);

/** The i18n key for a failed reply's code, or `fallback` for an unknown one (or a rejected call). */
export const memoryErrorKey = (code: string | undefined, fallback: string): string =>
  MEMORY_ERROR_KEYS.get(code) ?? fallback;
