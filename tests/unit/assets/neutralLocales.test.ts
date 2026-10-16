/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const LOCALES_DIR = join(__dirname, '../../../packages/desktop/src/renderer/services/i18n/locales');
const LOCALES = readdirSync(LOCALES_DIR).filter((name) => /^[a-z]{2}-[A-Z]{2}$/.test(name));
const VENDOR_NAMES = /Claude|Codex|Gemini|OpenAI|ChatGPT/i;
const ENGINE_PLACEHOLDERS = /\{\{\s*(backend|agent)\s*\}\}/;

type Json = { [key: string]: string | Json };

const load = (locale: string, file: string): Json =>
  JSON.parse(readFileSync(join(LOCALES_DIR, locale, `${file}.json`), 'utf-8')) as Json;

/** Every string under `node`, with its dotted path. */
const strings = (node: Json, prefix: string): Array<[string, string]> =>
  Object.entries(node).flatMap(([key, value]) =>
    typeof value === 'string' ? [[`${prefix}.${key}`, value] as [string, string]] : strings(value, `${prefix}.${key}`)
  );

describe('neutral locale strings', () => {
  it('covers all 13 locales', () => {
    expect(LOCALES).toHaveLength(13);
  });

  it.each(LOCALES)('%s: chat strings name no engine and no vendor', (locale) => {
    const acp = load(locale, 'acp');
    const chatStrings = [
      ...strings({ placeholder: (acp.sendbox as Json).placeholder }, 'acp.sendbox'),
      ...strings(acp.status as Json, 'acp.status'),
      ...strings(acp.auth as Json, 'acp.auth'),
    ];

    expect(chatStrings.length).toBeGreaterThan(0);
    for (const [path, text] of chatStrings) {
      expect(text, path).not.toMatch(ENGINE_PLACEHOLDERS);
      expect(text, path).not.toMatch(VENDOR_NAMES);
    }
  });

  it.each(LOCALES)('%s: the task detail heading is the Agent name', (locale) => {
    const heading = ((load(locale, 'cron').detail as Json).assistant as string) ?? '';

    expect(heading).toBe(load(locale, 'agent').displayName);
  });
});
