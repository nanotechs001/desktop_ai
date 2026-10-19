/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { z } from 'zod';

/** Size limits for a skill an agent proposes and the user may save. */
export const SKILL_PROPOSAL_LIMITS = {
  nameMin: 3,
  nameMax: 48,
  descriptionMin: 20,
  descriptionMax: 300,
  stepsMax: 8000,
  savesPerChat: 10,
} as const;

/** A skill name: lowercase words joined by single hyphens. */
export const SKILL_NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** Zod shape shared by the `propose_skill` tool and the main-process saver. */
export const skillProposalInput = {
  name: z
    .string()
    .trim()
    .min(SKILL_PROPOSAL_LIMITS.nameMin)
    .max(SKILL_PROPOSAL_LIMITS.nameMax)
    .regex(SKILL_NAME_RE, 'name must be lowercase kebab-case, e.g. weekly-report'),
  description: z.string().trim().min(SKILL_PROPOSAL_LIMITS.descriptionMin).max(SKILL_PROPOSAL_LIMITS.descriptionMax),
  steps: z.string().trim().min(1).max(SKILL_PROPOSAL_LIMITS.stepsMax),
};

/** A skill draft proposed by an agent, not yet saved. */
export type SkillProposal = { name: string; description: string; steps: string };

/** Returns the proposal when `value` matches the schema exactly (no extra keys), otherwise undefined. */
export function parseSkillProposal(value: unknown): SkillProposal | undefined {
  const parsed = z.object(skillProposalInput).strict().safeParse(value);
  // The cast is needed because this repo's tsconfig lacks strictNullChecks, so zod infers every key as optional.
  return parsed.success ? (parsed.data as SkillProposal) : undefined;
}

/** What the review card sends when the user saves a proposed skill. */
export type SaveSkillRequest = { conversation_id: string } & SkillProposal;

/** The outcome of saving: `library_only` for a built-in bot (it can't be edited), `enable_failed` when only turning it on failed. */
export type SaveSkillResult =
  | {
      ok: true;
      skill_name: string;
      agent_id?: string;
      enabled_for?: string;
      library_only?: boolean;
      enable_failed?: boolean;
    }
  | { ok: false; code: 'invalid' | 'exists' | 'import_failed' | 'rate_limited' | 'no_agent'; message: string };
