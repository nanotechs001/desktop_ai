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
