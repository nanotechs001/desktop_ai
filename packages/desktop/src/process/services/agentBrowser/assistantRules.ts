/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { httpRequest } from '@/common/adapter/httpBridge';
import { upsertBrowserRule } from '@/common/config/browserRule';
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

/** Backend-wired deps. Built-in assistants are skipped: the backend rejects writes to their ids. */
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

/** Make sure every assistant rule carries the browser-rule block. One failure never stops the rest. */
export async function ensureBrowserRuleInAssistants(deps: AssistantRuleDeps): Promise<AssistantRuleSyncSummary> {
  const summary = { updated: 0, skipped: 0, failed: 0 };
  const assistants = await deps.listAssistants();
  for (const { id, locales } of assistants) {
    for (const locale of locales) {
      try {
        const current = await deps.readRule(id, locale);
        const next = upsertBrowserRule(current);
        if (next === current) {
          summary.skipped += 1;
          continue;
        }
        await deps.writeRule(id, locale, next);
        summary.updated += 1;
      } catch (error) {
        summary.failed += 1;
        console.warn(`[AionUi] Browser rule sync failed for assistant '${id}' (${locale || 'default'}):`, error);
      }
    }
  }
  return summary;
}
