/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { httpRequest } from '@/common/adapter/httpBridge';
import { upsertBrowserRule } from './browserRule';
import type { Assistant } from '@/common/types/agent/assistantTypes';

export type AssistantRuleDeps = {
  listAssistants(): Promise<{ id: string; locales: string[] }[]>;
  readRule(id: string, locale: string): Promise<string>;
  writeRule(id: string, locale: string, content: string): Promise<void>;
};

export type AssistantRuleSyncSummary = { updated: number; skipped: number; failed: number };

/** The backend exposes no per-locale rule listing, so only its default locale (sent as no locale) is synced. */
const DEFAULT_LOCALE = '';

const localeBody = (locale: string) => (locale ? { locale } : {});

/**
 * Backend-wired deps. Built-in assistants are skipped: the backend rejects writes to their ids.
 * They are covered by the aionui-browser MCP server instructions instead (Task 6).
 */
export const backendAssistantRuleDeps: AssistantRuleDeps = {
  async listAssistants() {
    const all = await httpRequest<Assistant[]>('GET', '/api/assistants');
    return (all ?? []).filter((a) => a.source !== 'builtin').map((a) => ({ id: a.id, locales: [DEFAULT_LOCALE] }));
  },
  async readRule(id, locale) {
    const text = await httpRequest<string>('POST', '/api/skills/assistant-rule/read', {
      assistant_id: id,
      ...localeBody(locale),
    });
    return text ?? '';
  },
  async writeRule(id, locale, content) {
    await httpRequest<boolean>('POST', '/api/skills/assistant-rule/write', {
      assistant_id: id,
      content,
      ...localeBody(locale),
    });
  },
};

type SyncOutcome = 'updated' | 'skipped' | 'failed' | 'unbalanced';

/** Upsert the block into one assistant's rule for one locale. One failure never throws. */
async function syncRule(deps: AssistantRuleDeps, id: string, locale: string): Promise<SyncOutcome> {
  try {
    const current = await deps.readRule(id, locale);
    const result = upsertBrowserRule(current);
    if (result.ok === false) {
      console.warn(`[AionUi] Browser rule left untouched for assistant '${id}': ${result.reason}`);
      return 'unbalanced';
    }
    if (result.content === current) return 'skipped';
    await deps.writeRule(id, locale, result.content);
    return 'updated';
  } catch (error) {
    console.warn(`[AionUi] Browser rule sync failed for assistant '${id}' (${locale || 'default'}):`, error);
    return 'failed';
  }
}

/** Make sure every assistant rule carries the browser-rule block. One failure never stops the rest. */
export async function ensureBrowserRuleInAssistants(deps: AssistantRuleDeps): Promise<AssistantRuleSyncSummary> {
  const summary = { updated: 0, skipped: 0, failed: 0 };
  let assistants: Awaited<ReturnType<AssistantRuleDeps['listAssistants']>>;
  try {
    assistants = await deps.listAssistants();
  } catch (error) {
    console.error('[AionUi] Browser rule sync could not list assistants:', error);
    return summary;
  }
  for (const { id, locales } of assistants) {
    for (const locale of locales) {
      const outcome = await syncRule(deps, id, locale);
      summary[outcome === 'unbalanced' ? 'failed' : outcome] += 1;
    }
  }
  return summary;
}

/**
 * Put the block into one Agent's rule right after the app created or edited it: the default
 * rule plus the locale rule the editor wrote, so neither can lack the block. `unbalanced` counts
 * rules left untouched because their markers are broken (the user must fix those; a retry cannot).
 */
export async function ensureBrowserRuleForAssistant(
  deps: AssistantRuleDeps,
  id: string,
  locale?: string
): Promise<AssistantRuleSyncSummary & { unbalanced: number }> {
  const summary = { updated: 0, skipped: 0, failed: 0, unbalanced: 0 };
  for (const target of new Set([DEFAULT_LOCALE, locale ?? DEFAULT_LOCALE]))
    summary[await syncRule(deps, id, target)] += 1;
  return summary;
}

const MAX_ASSISTANT_ID_LENGTH = 128;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export type EnsureAgentRuleReply = { success: boolean; data?: { unbalanced: true }; msg?: string };

/**
 * IPC handler for "an Agent was just created or edited": validates the request (it comes from the
 * renderer) and upserts the block. A rule with broken markers is reported as `unbalanced`.
 */
export async function handleEnsureAgentRule(
  request: unknown,
  deps: AssistantRuleDeps = backendAssistantRuleDeps
): Promise<EnsureAgentRuleReply> {
  const { assistantId, locale } = (typeof request === 'object' && request !== null ? request : {}) as Record<
    string,
    unknown
  >;
  if (typeof assistantId !== 'string' || assistantId.length === 0 || assistantId.length > MAX_ASSISTANT_ID_LENGTH) {
    return { success: false, msg: 'Invalid arguments' };
  }
  if (locale !== undefined && (typeof locale !== 'string' || !LOCALE_PATTERN.test(locale))) {
    return { success: false, msg: 'Invalid arguments' };
  }

  const summary = await ensureBrowserRuleForAssistant(
    deps,
    assistantId,
    typeof locale === 'string' ? locale : undefined
  );
  if (summary.unbalanced > 0) {
    return { success: false, data: { unbalanced: true }, msg: 'The AionUi block markers in this Agent are unbalanced' };
  }
  return summary.failed > 0 ? { success: false, msg: 'Could not update the Agent rule' } : { success: true };
}
