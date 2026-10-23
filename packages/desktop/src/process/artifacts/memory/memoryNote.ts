/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * One memory note on disk: markdown with YAML frontmatter (Obsidian-compatible), its validation and its version.
 * Note format ported from obsidian-second-brain's "AI-first" spec (MIT): a summary for a future agent, a source,
 * a confidence, and a superseded status instead of overwriting a fact.
 */

import { createHash } from 'node:crypto';
import yaml from 'js-yaml';

import {
  MEMORY_CONFIDENCES,
  MEMORY_LIMITS,
  MEMORY_NOTE_TYPES,
  MEMORY_SOURCES,
  type MemoryNote,
  type MemoryNoteInput,
  type MemoryNoteMeta,
  type MemoryStatus,
} from '@/common/types/agent/memory';

/** A note id is a plain slug; it is the file name, so nothing else may reach the disk. */
export const NOTE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const CHAT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_SLUG_CHARS = 60;
const MAX_ID_CHARS = 64;
const MAX_REASON_CHARS = 200;
const FRONTMATTER_END = '\n---\n';

export type NoteFields = Omit<MemoryNote, 'id' | 'version'>;
export type CheckedInput = Required<Omit<MemoryNoteInput, 'fromChat'>> & { fromChat?: string };

export const oneLine = (text: string): string => text.replace(/\s+/g, ' ').trim();
export const charCount = (text: string): number => Array.from(text).length;
export const isChatId = (value: unknown): value is string => typeof value === 'string' && CHAT_ID_RE.test(value);
const isOneOf = <T extends string>(list: readonly T[], value: unknown): value is T =>
  typeof value === 'string' && (list as readonly string[]).includes(value);

/** Text an agent wrote, made safe to place in a generated file or a rule: one line, no comment markers. */
export const neutralise = (text: string): string => oneLine(text).replace(/<!--/g, '< !--').replace(/-->/g, '-- >');

// Windows refuses these as file names, whatever the extension.
const RESERVED_NAMES = /^(con|prn|aux|nul|com[0-9]|lpt[0-9])$/;

export const slugify = (title: string): string => {
  const slug =
    title
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+/, '')
      .slice(0, MAX_SLUG_CHARS)
      .replace(/-+$/, '') || 'note';
  return RESERVED_NAMES.test(slug) ? `${slug}-note` : slug;
};

/** `base`, or `base-n`, kept within the id length so the result always passes NOTE_ID_RE. */
export const numberedId = (base: string, n: number): string => {
  const suffix = n === 1 ? '' : `-${n}`;
  return `${base.slice(0, MAX_ID_CHARS - suffix.length).replace(/-+$/, '')}${suffix}`;
};

export const versionOf = (text: string): string => createHash('sha256').update(text).digest('hex').slice(0, 16);

const checkTags = (tags: unknown): string[] | string => {
  if (tags === undefined) return [];
  if (!Array.isArray(tags) || tags.length > MEMORY_LIMITS.maxTags) return `At most ${MEMORY_LIMITS.maxTags} tags`;
  const cleaned = tags.map((tag) => (typeof tag === 'string' ? oneLine(tag) : ''));
  if (cleaned.some((tag) => !tag || charCount(tag) > MEMORY_LIMITS.maxTagChars)) {
    return `Tags must be 1-${MEMORY_LIMITS.maxTagChars} characters`;
  }
  return [...new Set(cleaned)];
};

const checkText = (value: unknown, label: string, max: number): string | { error: string } => {
  const text = typeof value === 'string' ? oneLine(value) : '';
  return text && charCount(text) <= max ? text : { error: `${label} must be 1-${max} characters` };
};

/** The input an agent or the user gave, checked and normalised; a string is the reason it was refused. */
export const checkInput = (input: MemoryNoteInput): CheckedInput | string => {
  if (typeof input !== 'object' || input === null) return 'Input must be an object';
  if (!isOneOf(MEMORY_NOTE_TYPES, input.type)) return `Unknown note type: ${String(input.type)}`;
  if (!isOneOf(MEMORY_SOURCES, input.source)) return `Unknown source: ${String(input.source)}`;
  const confidence = input.confidence ?? 'medium';
  if (!isOneOf(MEMORY_CONFIDENCES, confidence)) return `Unknown confidence: ${String(confidence)}`;
  const title = checkText(input.title, 'Title', MEMORY_LIMITS.maxTitleChars);
  if (typeof title !== 'string') return title.error;
  const summary = checkText(input.summary, 'Summary', MEMORY_LIMITS.maxSummaryChars);
  if (typeof summary !== 'string') return summary.error;
  const tags = checkTags(input.tags);
  if (typeof tags === 'string') return tags;
  if (input.body !== undefined && typeof input.body !== 'string') return 'Body must be text';
  if (input.fromChat !== undefined && (typeof input.fromChat !== 'string' || !CHAT_ID_RE.test(input.fromChat))) {
    return 'Bad chat id';
  }
  const body = (input.body ?? '').trim();
  return { type: input.type, source: input.source, confidence, title, summary, tags, body, fromChat: input.fromChat };
};

export const checkReason = (reason: unknown): string | null => {
  const text = typeof reason === 'string' ? oneLine(reason) : '';
  return text && charCount(text) <= MAX_REASON_CHARS ? text : null;
};

const KNOWN_KEYS = new Set([
  'type',
  'title',
  'summary',
  'tags',
  'source',
  'confidence',
  'status',
  'superseded_by',
  'created',
  'updated',
  'from_chats',
]);

/**
 * The file for a note. `extra` keeps frontmatter keys this app doesn't manage (added in Obsidian, or a retire
 * reason), after the known ones. Key order is fixed so diffs stay small.
 */
export const serialiseNote = (note: NoteFields, extra: Record<string, unknown> = {}): string => {
  const frontmatter: Record<string, unknown> = {
    type: note.type,
    title: note.title,
    summary: note.summary,
    tags: note.tags,
    source: note.source,
    confidence: note.confidence,
    status: note.status,
    ...(note.supersededBy ? { superseded_by: note.supersededBy } : {}),
    created: note.created,
    updated: note.updated,
    from_chats: note.fromChats,
    ...extra,
  };
  const head = yaml.dump(frontmatter, { schema: yaml.JSON_SCHEMA, lineWidth: -1 });
  return `---\n${head}---\n\n${note.body}\n`;
};

const stringList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? value : null;

const readFrontmatter = (text: string): { data: Record<string, unknown>; body: string } | null => {
  if (!text.startsWith('---\n')) return null;
  const end = text.indexOf(FRONTMATTER_END, 3);
  if (end < 0) return null;
  const data: unknown = yaml.load(text.slice(4, end + 1), { schema: yaml.JSON_SCHEMA });
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  return { data: data as Record<string, unknown>, body: text.slice(end + FRONTMATTER_END.length).trim() };
};

/** Frontmatter keys this app doesn't manage, kept so a rewrite never drops them. */
export const extraKeysOf = (text: string): Record<string, unknown> => {
  const parsed = readFrontmatter(text);
  if (!parsed) return {};
  return Object.fromEntries(Object.entries(parsed.data).filter(([key]) => !KNOWN_KEYS.has(key)));
};

/** Reads a note file; null when it is not a valid note (it is then left alone, never rewritten). Throws on bad YAML. */
export const parseNote = (id: string, text: string): MemoryNote | null => {
  const parsed = readFrontmatter(text);
  if (!parsed) return null;
  const { data, body } = parsed;
  const confidence = data.confidence ?? 'medium';
  const status = data.status ?? 'active';
  const tags = stringList(data.tags ?? []);
  const fromChats = stringList(data.from_chats ?? []);
  const texts = [data.title, data.summary, data.created, data.updated];
  if (!isOneOf(MEMORY_NOTE_TYPES, data.type) || !isOneOf(MEMORY_SOURCES, data.source)) return null;
  if (!isOneOf(MEMORY_CONFIDENCES, confidence) || !isOneOf<MemoryStatus>(['active', 'superseded'], status)) return null;
  if (!tags || !fromChats || texts.some((value) => typeof value !== 'string')) return null;
  const supersededBy = typeof data.superseded_by === 'string' ? data.superseded_by : undefined;
  return {
    id,
    type: data.type,
    title: data.title as string,
    summary: data.summary as string,
    tags,
    source: data.source,
    confidence,
    status,
    ...(supersededBy ? { supersededBy } : {}),
    created: data.created as string,
    updated: data.updated as string,
    fromChats,
    body,
    version: versionOf(text),
  };
};

/** The words of a search query, lower-cased and deduplicated (letters and digits in any script). */
export const tokenize = (text: string): string[] => [...new Set(text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [])];

/**
 * How well a note matches the query words: a title hit counts most, then a tag, then the summary.
 * shortcut: bodies are not searched (only what the index shows); search bodies too if agents miss details.
 */
export const scoreNote = (note: MemoryNoteMeta, tokens: readonly string[]): number => {
  const title = note.title.toLowerCase();
  const summary = note.summary.toLowerCase();
  const tags = note.tags.map((tag) => tag.toLowerCase());
  let score = 0;
  for (const token of tokens) {
    if (title.includes(token)) score += 3;
    if (tags.some((tag) => tag.includes(token))) score += 2;
    if (summary.includes(token)) score += 1;
  }
  return score;
};
