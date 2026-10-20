/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared by the relay (page world) and the standalone aion-browser MCP (isolated world): no electron imports here.
import { sanitizePageText } from '@/common/utils/utils';

/** How long one run_script may run before it is an error. */
export const SCRIPT_TIMEOUT_MS = 10_000;
/** Extra wait before the caller gives up on a script whose own timers were stopped or replaced by the page. */
const GUARD_GRACE_MS = 2000;
/** Characters of code one run_script may carry. */
export const MAX_SCRIPT_CHARS = 50_000;
/** Characters of code the user sees in the page-script ask. */
const PREVIEW_CHARS = 120;

/** `expression`: one expression, e.g. `document.title`. `body`: a function body that `return`s its result. */
export const SCRIPT_FORMS = ['expression', 'body'] as const;
export type ScriptForm = (typeof SCRIPT_FORMS)[number];

export const isScriptForm = (value: unknown): value is ScriptForm =>
  typeof value === 'string' && (SCRIPT_FORMS as readonly string[]).includes(value);

/**
 * The agent's code as one awaited expression that rejects after {@link SCRIPT_TIMEOUT_MS}. The code starts on the
 * second line, so line n of the code is 0-based line n of the expression (what CDP reports).
 */
const wrapScript = (code: string, form: ScriptForm): string => {
  const [open, close] = form === 'body' ? ['{', '}'] : ['(', ')'];
  // A trailing semicolon would end the expression early; trailing comments are safe on their own line.
  const source = form === 'body' ? code : code.replace(/[\s;]+$/, '');
  const timeout = `new Promise((_, reject) => setTimeout(() => reject(new Error('run_script timed out after ${SCRIPT_TIMEOUT_MS} ms')), ${SCRIPT_TIMEOUT_MS}))`;
  return `Promise.race([(async () => ${open}\n${source}\n${close})(), ${timeout}])`;
};

/** `Runtime.evaluate` params for a script: awaited, by value, CDP-timed; the caller adds a contextId for a world. */
export const scriptEvaluateParams = (code: string, form: ScriptForm) => ({
  expression: wrapScript(code, form),
  awaitPromise: true,
  returnByValue: true,
  timeout: SCRIPT_TIMEOUT_MS,
});

/** The code as the page-script ask shows it: one line, no hidden characters, the first 120 characters, `…` when cut. */
export const scriptPreview = (code: string): string => {
  const chars = Array.from(sanitizePageText(code, MAX_SCRIPT_CHARS));
  return chars.length > PREVIEW_CHARS ? `${chars.slice(0, PREVIEW_CHARS).join('')}…` : chars.join('');
};

/** `call`, or a rejection once the script had its time plus a grace; the late result is ignored. */
export const withScriptTimeout = <T>(call: Promise<T>): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`The script did not finish within ${SCRIPT_TIMEOUT_MS} ms`)),
      SCRIPT_TIMEOUT_MS + GUARD_GRACE_MS
    );
  });
  return Promise.race([call, timeout]).finally(() => clearTimeout(timer));
};
