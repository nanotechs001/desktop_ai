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

/** Upsert the block into one assistant's rule for one locale, counting the outcome. One failure never throws. */
async function syncRule(
  deps: AssistantRuleDeps,
  id: string,
  locale: string,
  summary: { updated: number; skipped: number; failed: number }
): Promise<void> {
  try {
    const current = await deps.readRule(id, locale);
    const result = upsertBrowserRule(current);
    if (result.ok === false) {
      summary.failed += 1;
      console.warn(`[AionUi] Browser rule left untouched for assistant '${id}': ${result.reason}`);
      return;
    }
    if (result.content === current) {
      summary.skipped += 1;
      return;
    }
    await deps.writeRule(id, locale, result.content);
    summary.updated += 1;
  } catch (error) {
    summary.failed += 1;
    console.warn(`[AionUi] Browser rule sync failed for assistant '${id}' (${locale || 'default'}):`, error);
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
    for (const locale of locales) await syncRule(deps, id, locale, summary);
  }
  return summary;
}

/**
 * Put the block into one Agent's rule right after the app created or edited it: the default
 * rule plus the locale rule the editor wrote, so neither can lack the block.
 */
export async function ensureBrowserRuleForAssistant(
  deps: AssistantRuleDeps,
  id: string,
  locale?: string
): Promise<AssistantRuleSyncSummary> {
  const summary = { updated: 0, skipped: 0, failed: 0 };
  for (const target of new Set([DEFAULT_LOCALE, locale ?? DEFAULT_LOCALE])) await syncRule(deps, id, target, summary);
  return summary;
}
