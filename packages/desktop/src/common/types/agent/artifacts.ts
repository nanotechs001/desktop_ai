/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** Kinds of artifact an Agent can create. */
export type ArtifactKind = 'html' | 'react' | 'markdown' | 'mermaid' | 'svg';

export const ARTIFACT_KINDS: readonly ArtifactKind[] = ['html', 'react', 'markdown', 'mermaid', 'svg'];

export const ARTIFACT_LIMITS = {
  maxContentBytes: 2 * 1024 * 1024,
  maxTitleChars: 120,
  maxPerConversation: 200,
} as const;

export type ArtifactMeta = {
  id: string;
  conversationId: string;
  title: string;
  kind: ArtifactKind;
  createdAt: number;
  updatedAt: number;
  /** Highest stored version number. */
  latest: number;
};

export type ArtifactVersion = ArtifactMeta & { version: number; content: string };

export type ArtifactError =
  | 'not-found'
  | 'too-large'
  | 'bad-title'
  | 'bad-kind'
  | 'bad-content'
  | 'limit-reached'
  | 'io';

export type ArtifactResult<T> = { ok: true; value: T } | { ok: false; error: ArtifactError; message: string };

/** Where a notebook note came from: the agent itself, the user, or a web page the agent read (unverified). */
export type NoteSource = 'agent' | 'user' | 'page';

/** One line in an Agent's notebook. */
export type Note = { id: string; text: string; source: NoteSource; at: number };

export const NOTE_SOURCES: readonly NoteSource[] = ['agent', 'user', 'page'];

export const NOTE_LIMITS = {
  maxChars: 300,
  maxPerAgent: 200,
  /** The agent's own notes plus page notes, within `maxPerAgent`: the rest is kept for the user's instructions. */
  maxLearnedPerAgent: 100,
  /** Notes one chat may add per app run. */
  maxAddsPerConversation: 10,
  /** The notebook block in an Agent's rule; past it the oldest agent and page notes are left out, never the user's. */
  maxBlockChars: 8000,
} as const;
