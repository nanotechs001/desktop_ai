/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The memory hygiene report (ported from obsidian-second-brain's ideas, MIT): notes that look like duplicates, links
 * to notes that don't exist, and facts nobody has checked for a long time. Deterministic, no LLM, and it only reports:
 * nothing changes until the user acts on it.
 */

import type { MemoryHygieneIssue, MemoryHygieneReport, MemoryNote, MemoryNoteType } from '@/common/types/agent/memory';

/** Days after which a fact, project or person note counts as stale. */
export const MEMORY_STALE_AFTER_DAYS = 180;
const DAY_MS = 24 * 60 * 60 * 1000;
const STALE_TYPES: ReadonlySet<MemoryNoteType> = new Set(['fact', 'project', 'person']);
/** Two bodies with at least this share of their words in common say the same thing. */
const SIMILAR_BODY = 0.6;
/** Shorter bodies share words by chance too often to count as duplicates. */
const MIN_BODY_WORDS = 20;
const LINK_RE = /\[\[([^\]\n]+)\]\]/g;

export type HygieneInput = { notes: MemoryNote[]; trash: number; maxNotes: number; now: Date };

/** Case, spacing and punctuation don't make a different title. */
const titleKey = (title: string): string => title.toLowerCase().replace(/[\p{P}\p{S}\s]+/gu, '');

const wordsOf = (body: string): string[] => body.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];

const jaccard = (a: ReadonlySet<string>, b: ReadonlySet<string>): number => {
  // Never above small/large: skips most pairs of a full vault without counting words.
  if (Math.min(a.size, b.size) < SIMILAR_BODY * Math.max(a.size, b.size)) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
};

const byRecency = (a: MemoryNote, b: MemoryNote): number =>
  b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);

/** Groups of notes that look like the same thing; a note that matches two groups joins them, so it is in only one. */
const duplicates = (active: MemoryNote[]): MemoryHygieneIssue[] => {
  const parent = active.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const keys = active.map((note) => titleKey(note.title));
  const bodies = active.map((note) => {
    const words = wordsOf(note.body);
    return words.length >= MIN_BODY_WORDS ? new Set(words) : null;
  });
  for (let i = 0; i < active.length; i += 1) {
    for (let j = i + 1; j < active.length; j += 1) {
      const [a, b] = [bodies[i], bodies[j]];
      const same =
        (keys[i] !== '' && keys[i] === keys[j]) || (a !== null && b !== null && jaccard(a, b) >= SIMILAR_BODY);
      if (same) parent[find(j)] = find(i);
    }
  }
  const groups = new Map<number, MemoryNote[]>();
  active.forEach((note, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), note]));
  // `active` is newest first, so each group is too.
  return [...groups.values()]
    .filter((group) => group.length > 1)
    .map((group) => ({
      kind: 'duplicate',
      notes: group.map(({ id, title, updated }) => ({ id, title, updated })),
    }));
};

/** Links in active notes that point at no note; `[[target|alias]]` and `[[target#heading]]` link to `target`. */
const orphanLinks = (all: MemoryNote[], active: MemoryNote[]): MemoryHygieneIssue[] => {
  const known = new Set(all.flatMap((note) => [note.id.toLowerCase(), note.title.toLowerCase()]));
  return active.flatMap((note) => {
    const targets = [...note.body.matchAll(LINK_RE)].map((match) => match[1].split('|')[0].split('#')[0].trim());
    const missing = new Set(targets.filter((target) => target && !known.has(target.toLowerCase())));
    return [...missing].map((link) => ({ kind: 'orphan-link' as const, id: note.id, title: note.title, link }));
  });
};

const stale = (active: MemoryNote[], now: Date): MemoryHygieneIssue[] => {
  const cutoff = now.getTime() - MEMORY_STALE_AFTER_DAYS * DAY_MS;
  return active
    .filter((note) => STALE_TYPES.has(note.type) && Date.parse(note.updated) < cutoff)
    .map(({ id, title, updated }) => ({ kind: 'stale', id, title, updated }));
};

/** What in a vault needs tidying: duplicates, then links to missing notes, then stale notes, each newest first. */
export function hygieneReport({ notes, trash, maxNotes, now }: HygieneInput): MemoryHygieneReport {
  const active = notes.filter((note) => note.status === 'active').toSorted(byRecency);
  return {
    notes: notes.length,
    maxNotes,
    trash,
    staleAfterDays: MEMORY_STALE_AFTER_DAYS,
    issues: [...duplicates(active), ...orphanLinks(notes, active), ...stale(active, now)],
  };
}
