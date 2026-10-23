/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The old one-line notebook (`agent-notes/<agentId>.json`) moving into memory: a one-time copy into each agent's
 * vault at startup, the old `add` tool saving into memory, and the old `# Notebook` rule block retired per agent once
 * its notebook is copied. The JSON files are never changed: they stay as the backup.
 */

import fs from 'node:fs/promises';

import type { ArtifactResult, Note, NoteSource } from '@/common/types/agent/artifacts';
import type { MemoryNoteInput, MemoryNoteType, MemoryVaultRef } from '@/common/types/agent/memory';
import { oneLine } from './memoryNote';
import type { MemoryStore } from './memoryStore';
import { AGENT_ID_RE, readNotes } from '../notes';

const TITLE_CHARS = 60;
const SUMMARY_CHARS = 200;

/** The user's notes were their instructions; the agent's were facts; page notes stay unverified sources. */
const TYPE_OF: Record<NoteSource, MemoryNoteType> = { user: 'instructions', agent: 'fact', page: 'source' };

const clip = (text: string, chars: number): string => Array.from(text).slice(0, chars).join('').trim();

/** A one-line note as a memory note: its start as the title and summary, the whole text as the body. */
export const noteInputFromText = (text: string, source: NoteSource): MemoryNoteInput => {
  const line = typeof text === 'string' ? oneLine(text) : '';
  return {
    type: TYPE_OF[source],
    title: clip(line, TITLE_CHARS),
    summary: clip(line, SUMMARY_CHARS),
    body: typeof text === 'string' ? text.trim() : '',
    source,
  };
};

const agentVault = (agentId: string): MemoryVaultRef => ({ kind: 'agent', agentId });

/** The old `add` tool, saving into the agent's memory; it answers in the old note shape that chat chips read. */
export const createMemoryNotesAdd =
  (store: MemoryStore) =>
  async (agentId: string, text: string, source: NoteSource): Promise<ArtifactResult<Note>> => {
    const saved = await store.create(agentVault(agentId), noteInputFromText(text, source));
    if (!('value' in saved)) {
      const error = saved.error === 'limit-reached' || saved.error === 'io' ? saved.error : 'bad-content';
      return { ok: false, error, message: saved.message };
    }
    return {
      ok: true,
      value: { id: saved.value.id, text: saved.value.body, source, at: Date.parse(saved.value.created) },
    };
  };

/** Copies one agent's notebook; true when every note is in (or can never be), so the vault may be marked. */
const migrateAgent = async (notesDir: string, store: MemoryStore, agentId: string): Promise<boolean> => {
  const vault = agentVault(agentId);
  const notes = await readNotes(notesDir, agentId);
  const listed = await store.list(vault);
  if (!('value' in listed)) throw new Error(listed.message);
  // A run cut short (the app quit) left some notes in already; they are not saved twice.
  const known = new Set(listed.value.map((note) => `${note.type}\n${note.title}\n${note.summary}`));
  let complete = true;
  for (const note of notes) {
    const input = noteInputFromText(note.text, note.source);
    if (known.has(`${input.type}\n${input.title}\n${input.summary}`)) continue;
    // eslint-disable-next-line no-await-in-loop -- one vault, written in order
    const saved = await store.create(vault, input);
    if ('error' in saved) {
      console.warn(`[memory] could not migrate a note of Agent '${agentId}'`, saved.message);
      // A storage error may pass; a note the store refuses never will.
      if (saved.error === 'io') complete = false;
    }
  }
  return complete;
};

/**
 * Copies every old notebook into its agent's vault, once (a marker file in the vault): user notes become instructions,
 * the agent's facts and page notes unverified sources. An unreadable notebook is skipped and retried next start.
 */
export async function migrateNotebooks(notesDir: string, store: MemoryStore): Promise<void> {
  const files = await fs.readdir(notesDir).catch((error: NodeJS.ErrnoException): string[] => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  const agentIds = files.flatMap((file) => {
    if (!file.endsWith('.json')) return [];
    try {
      const agentId = decodeURIComponent(file.slice(0, -'.json'.length));
      return AGENT_ID_RE.test(agentId) ? [agentId] : [];
    } catch {
      return [];
    }
  });
  await Promise.all(
    agentIds.map(async (agentId) => {
      try {
        const done = await store.isMigrated(agentVault(agentId));
        if (!('value' in done) || done.value) return;
        if (await migrateAgent(notesDir, store, agentId)) await store.markMigrated(agentVault(agentId));
      } catch (error) {
        console.warn(`[memory] could not migrate the notebook of Agent '${agentId}'; trying again next start`, error);
      }
    })
  );
}

/** The old notebook as the rule shows it: none once the agent's notes are in its memory, so the block goes. */
export async function notebookForRule(store: MemoryStore, notesDir: string, agentId: string): Promise<Note[]> {
  const done = await store.isMigrated(agentVault(agentId));
  return 'value' in done && done.value ? [] : readNotes(notesDir, agentId);
}
