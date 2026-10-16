/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Teams, Pet, Butler and Feedback are removed from this fork, so visible copy
 * must not point users at them (send diagnostics, send feedback, ask the butler,
 * use teams). Checked in every locale: English wording everywhere (catches text
 * left untranslated) plus the matching words of each language.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const localesDir = path.resolve(__dirname, '../../../packages/desktop/src/renderer/services/i18n/locales');

/** [module file, key path] of every string that used to mention a removed feature. */
const KEYS: Array<[string, string]> = [
  ['common', 'backendStartup.exited.description'],
  ['common', 'backendStartup.portReportTimeout.description'],
  ['common', 'backendStartup.startupFailed.description'],
  ['common', 'backendStartup.dataMigration.description'],
  ['common', 'backendStartup.localDataRepair.description'],
  ['update', 'installerLastFailure.description'],
  ['conversation', 'agentError.codes.AIONUI_INTERNAL_ERROR.body'],
  ['conversation', 'agentError.codes.AIONUI_STREAM_BROKEN.body'],
  ['conversation', 'agentError.resolution.send_feedback'],
  ['settings', 'customEmptyBody'],
  ['settings', 'assistantHomeLeadShort'],
  ['settings', 'assistantReorderHint'],
];

const ENGLISH = /diagnos|feedback|butler|\bteams?\b/i;

/** Words for diagnostics, feedback, the butler and teams, per locale. */
const LOCAL_WORDS: Record<string, RegExp> = {
  'de-DE': /Diagnose|Feedback|Butler|\bTeams?\b/i,
  'en-US': ENGLISH,
  'es-ES': /diagnóstic|comentarios|mayordomo|equipos/i,
  'fa-IR': /تشخیصی|بازخورد|پیشخدمت|تیم/,
  'fr-FR': /diagnostic|commentaires|majordome|équipes/i,
  'ja-JP': /診断|フィードバック|バトラー|チーム/,
  'ko-KR': /진단|피드백|버틀러|팀/,
  'pt-BR': /diagnóstic|feedback|mordomo|equipes/i,
  'ru-RU': /диагностик|отзыв|дворецк|команд/i,
  'tr-TR': /tanılama|geri bildirim|uşak|ekip/i,
  'uk-UA': /діагностик|відгук|дворецьк|команд/i,
  'zh-CN': /诊断|反馈|管家|开团|团队/,
  'zh-TW': /診斷|回饋|管家|開團|團隊/,
};

const read = (locale: string, file: string, keyPath: string): unknown =>
  keyPath
    .split('.')
    .reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      JSON.parse(fs.readFileSync(path.join(localesDir, locale, `${file}.json`), 'utf-8'))
    );

describe('copy for removed features', () => {
  it('covers all 13 locales', () => {
    expect(
      fs
        .readdirSync(localesDir)
        .filter((d) => fs.statSync(path.join(localesDir, d)).isDirectory())
        .toSorted()
    ).toEqual(Object.keys(LOCAL_WORDS).toSorted());
  });

  describe.each(Object.entries(LOCAL_WORDS))('%s', (locale, localWords) => {
    it.each(KEYS)('%s: %s does not point at a removed feature', (file, keyPath) => {
      const value = read(locale, file, keyPath);

      expect(typeof value).toBe('string');
      expect(value as string).not.toMatch(localWords);
      expect(value as string).not.toMatch(ENGLISH);
    });
  });
});
