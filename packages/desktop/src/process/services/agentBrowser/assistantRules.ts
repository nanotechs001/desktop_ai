/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { httpRequest } from '@/common/adapter/httpBridge';
import { notesRoot, readNotes, upsertNotesBlock } from '@process/artifacts/notes';
import { createSerialiser } from '@process/artifacts/store';
import type { UpsertManagedBlockResult } from '@/common/types/agent/managedRuleBlock';
import { upsertBrowserRule } from './browserRule';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { Note } from '@/common/types/agent/artifacts';

export type AssistantRuleDeps = {
  listAssistants(): Promise<{ id: string; locales: string[] }[]>;
  readRule(id: string, locale: string): Promise<string>;
  writeRule(id: string, locale: string, content: string): Promise<void>;
  /** The Agent's notebook; without it the notes block is left as it is. */
  listNotes?(id: string): Promise<Note[]>;
  /** The app's UI locale, the other rule the editor writes besides the default; none means the default only. */
  currentLocale?(): Promise<string | undefined>;
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
  listNotes: (id) => readNotes(notesRoot(), id),
  async currentLocale() {
    // Loaded on use: initStorage pulls in the whole storage layer, which unit tests of these rules don't need.
    const [{ ProcessConfig }, { normalizeLanguageCode }] = await Promise.all([
      import('@process/utils/initStorage'),
      import('@/common/config/i18n'),
    ]);
    const language = await ProcessConfig.get('language');
    return language ? normalizeLanguageCode(language) : undefined;
  },
};

type SyncOutcome = 'updated' | 'skipped' | 'failed' | 'unbalanced';

/**
 * Every rule write in main runs in this per-Agent queue: the editor's save, note syncs and the startup sync. So no
 * read-modify-write of one Agent's rule ever interleaves with another.
 */
const ruleQueue = createSerialiser();

/** The user's text plus the browser block plus the notes block. A notebook that can't be read is left as it is. */
async function composeRule(deps: AssistantRuleDeps, id: string, text: string): Promise<UpsertManagedBlockResult> {
  const browser = upsertBrowserRule(text);
  if (!browser.ok || !deps.listNotes) return browser;
  try {
    return upsertNotesBlock(browser.content, await deps.listNotes(id));
  } catch (error) {
    console.warn(`[AionUi] Notebook of assistant '${id}' unreadable; only the browser block was updated:`, error);
    return browser;
  }
}

/**
 * Upsert the managed blocks into one assistant's rule for one locale; with `content` (the editor's save) the user's
 * text is `content` instead of what is stored. Broken markers leave a stored rule untouched, but a saved text is still
 * written as the user typed it. Never throws. Call only inside `ruleQueue`.
 */
async function syncRule(deps: AssistantRuleDeps, id: string, locale: string, content?: string): Promise<SyncOutcome> {
  try {
    const current = await deps.readRule(id, locale);
    const result = await composeRule(deps, id, content ?? current);
    if (result.ok === false) {
      console.warn(`[AionUi] Browser rule left untouched for assistant '${id}': ${result.reason}`);
      if (content !== undefined && content !== current) await deps.writeRule(id, locale, content);
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

/** The app's UI locale, when known; a failure to read it only narrows the sync to the default rule. */
const currentLocaleOf = (deps: AssistantRuleDeps): Promise<string | undefined> =>
  deps.currentLocale?.().catch((): undefined => undefined) ?? Promise.resolve(undefined);

/** The default rule plus the given locale, else the app's current UI locale: the two rules the editor writes. */
async function targetLocales(deps: AssistantRuleDeps, locale?: string): Promise<string[]> {
  const current = locale ?? (await currentLocaleOf(deps));
  return [...new Set([DEFAULT_LOCALE, current ?? DEFAULT_LOCALE])];
}

/** Make sure every assistant rule carries the managed blocks. One failure never stops the rest. */
export async function ensureBrowserRuleInAssistants(deps: AssistantRuleDeps): Promise<AssistantRuleSyncSummary> {
  const summary = { updated: 0, skipped: 0, failed: 0 };
  let assistants: Awaited<ReturnType<AssistantRuleDeps['listAssistants']>>;
  try {
    assistants = await deps.listAssistants();
  } catch (error) {
    console.error('[AionUi] Browser rule sync could not list assistants:', error);
    return summary;
  }
  const current = await currentLocaleOf(deps);
  const extra = current ? [current] : [];
  for (const { id, locales } of assistants) {
    // eslint-disable-next-line no-await-in-loop -- one Agent at a time keeps the startup load on the backend low
    const outcomes = await ruleQueue(id, async () => {
      const done: SyncOutcome[] = [];
      // eslint-disable-next-line no-await-in-loop -- one locale after another, inside this Agent's queue slot
      for (const locale of new Set([...locales, ...extra])) done.push(await syncRule(deps, id, locale));
      return done;
    });
    for (const outcome of outcomes) summary[outcome === 'unbalanced' ? 'failed' : outcome] += 1;
  }
  return summary;
}

/**
 * Put the blocks into one Agent's rule right after the app created or edited it, or a note changed: the default rule
 * plus the editor's locale (else the current UI locale). With `content`, that is the user's text to save. `unbalanced`
 * counts rules whose markers are broken (the user must fix those; a retry cannot).
 */
export async function ensureBrowserRuleForAssistant(
  deps: AssistantRuleDeps,
  id: string,
  locale?: string,
  content?: string
): Promise<AssistantRuleSyncSummary & { unbalanced: number }> {
  return ruleQueue(id, async () => {
    const summary = { updated: 0, skipped: 0, failed: 0, unbalanced: 0 };
    // eslint-disable-next-line no-await-in-loop -- one locale after another, inside this Agent's queue slot
    for (const target of await targetLocales(deps, locale)) summary[await syncRule(deps, id, target, content)] += 1;
    return summary;
  });
}

/** Write an Agent's notebook into its rules after a note changed; the browser block is kept current too. */
export const syncNotesToRule = async (
  agentId: string,
  deps: AssistantRuleDeps = backendAssistantRuleDeps
): Promise<void> => {
  const summary = await ensureBrowserRuleForAssistant(deps, agentId);
  if (summary.failed + summary.unbalanced > 0) throw new Error(`Rule sync failed for Agent '${agentId}'`);
};

const MAX_ASSISTANT_ID_LENGTH = 128;
/** The user's own rule text from the editor; far above any real rule. */
const MAX_RULE_CHARS = 1_000_000;
const LOCALE_PATTERN = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

export type EnsureAgentRuleReply = { success: boolean; data?: { unbalanced: true }; msg?: string };

/**
 * IPC handler for "an Agent was just created or edited": validates the request (it comes from the
 * renderer) and writes the rule: `content` (the user's text, managed blocks stripped; empty for none) plus the
 * browser and notes blocks. Without `content` the stored text is kept. A rule with broken markers is reported as `unbalanced`.
 */
export async function handleEnsureAgentRule(
  request: unknown,
  deps: AssistantRuleDeps = backendAssistantRuleDeps
): Promise<EnsureAgentRuleReply> {
  const { assistantId, locale, content } = (typeof request === 'object' && request !== null ? request : {}) as Record<
    string,
    unknown
  >;
  if (typeof assistantId !== 'string' || assistantId.length === 0 || assistantId.length > MAX_ASSISTANT_ID_LENGTH) {
    return { success: false, msg: 'Invalid arguments' };
  }
  if (locale !== undefined && (typeof locale !== 'string' || !LOCALE_PATTERN.test(locale))) {
    return { success: false, msg: 'Invalid arguments' };
  }
  if (content !== undefined && (typeof content !== 'string' || content.length > MAX_RULE_CHARS)) {
    return { success: false, msg: 'Invalid arguments' };
  }

  const summary = await ensureBrowserRuleForAssistant(
    deps,
    assistantId,
    typeof locale === 'string' ? locale : undefined,
    typeof content === 'string' ? content : undefined
  );
  if (summary.unbalanced > 0) {
    return { success: false, data: { unbalanced: true }, msg: 'The AionUi block markers in this Agent are unbalanced' };
  }
  return summary.failed > 0 ? { success: false, msg: 'Could not update the Agent rule' } : { success: true };
}
