/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Long-term agent memory: a markdown vault per agent, plus one shared "about me" vault every agent reads.
 */

export const MEMORY_NOTE_TYPES = [
  'instructions',
  'fact',
  'preference',
  'person',
  'project',
  'decision',
  'procedure',
  'source',
] as const;
export type MemoryNoteType = (typeof MEMORY_NOTE_TYPES)[number];

/** Who wrote it: the agent, the user, or a web page the agent read (unverified). */
export const MEMORY_SOURCES = ['agent', 'user', 'page'] as const;
export type MemorySource = (typeof MEMORY_SOURCES)[number];

export const MEMORY_CONFIDENCES = ['stated', 'high', 'medium', 'speculation'] as const;
export type MemoryConfidence = (typeof MEMORY_CONFIDENCES)[number];

export type MemoryStatus = 'active' | 'superseded';

/** An agent's own vault, or the shared one about the user. */
export type MemoryVaultRef = { kind: 'agent'; agentId: string } | { kind: 'shared' };

export type MemoryNoteMeta = {
  id: string;
  type: MemoryNoteType;
  title: string;
  /** "For future agent": what the note says, in a sentence or two. */
  summary: string;
  tags: string[];
  source: MemorySource;
  confidence: MemoryConfidence;
  status: MemoryStatus;
  /** The note that replaced this one, when superseded. */
  supersededBy?: string;
  /** ISO timestamps. */
  created: string;
  updated: string;
  fromChats: string[];
  /** Hash of the file as read; an update must send it back, so a stale write is refused. */
  version: string;
};

export type MemoryNote = MemoryNoteMeta & { body: string };

export type MemoryNoteInput = {
  type: MemoryNoteType;
  title: string;
  summary: string;
  body?: string;
  tags?: string[];
  source: MemorySource;
  confidence?: MemoryConfidence;
  fromChat?: string;
};

export type MemoryNotePatch = Partial<
  Pick<MemoryNoteInput, 'type' | 'title' | 'summary' | 'body' | 'tags' | 'confidence' | 'fromChat'>
>;

export const MEMORY_LIMITS = {
  /** The whole file, frontmatter included, in UTF-8 bytes. */
  maxNoteBytes: 8 * 1024,
  maxNotesPerVault: 2000,
  maxTitleChars: 120,
  maxSummaryChars: 200,
  maxTags: 10,
  maxTagChars: 40,
} as const;

/** `forbidden`: the caller may not do this (an agent changing the user's note, removing the main agent's memory). */
export type MemoryError = 'not-found' | 'invalid' | 'stale' | 'limit-reached' | 'conflict' | 'io' | 'forbidden';

export type MemoryResult<T> = { ok: true; value: T } | { ok: false; error: MemoryError; message: string };

/** One finding of the memory hygiene check. It only reports; nothing is changed until the user acts. */
export type MemoryHygieneIssue =
  /** Notes that look like the same thing (same title, or mostly the same body); the newest first. */
  | { kind: 'duplicate'; notes: Array<{ id: string; title: string; updated: string }> }
  /** A `[[link]]` in a note's body that points at no note in the vault. */
  | { kind: 'orphan-link'; id: string; title: string; link: string }
  /** An active fact, project or person note not updated for longer than the freshness window. */
  | { kind: 'stale'; id: string; title: string; updated: string };

export type MemoryHygieneReport = {
  notes: number;
  maxNotes: number;
  /** Retired notes kept in the trash. */
  trash: number;
  /** Days after which a fact, project or person note counts as stale. */
  staleAfterDays: number;
  issues: MemoryHygieneIssue[];
};
