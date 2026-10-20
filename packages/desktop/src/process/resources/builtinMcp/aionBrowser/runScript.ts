/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  MAX_RESULT_CHARS,
  PAGE_CHANGED,
  openScriptWorld,
  readScriptParams,
  withScriptTimeout,
  type ScriptForm,
} from '@process/services/agentBrowser/relay/pageScript';
import { sanitizePageText } from '@/common/utils/utils';
import type { ActionContext } from './actions';

/** Characters of an exception message the agent gets. */
const MAX_ERROR_CHARS = 500;
/** V8's refusal of a change during a read-only (throwOnSideEffect) run. */
const SIDE_EFFECT = /^EvalError: Possible side-effect/;
const CHANGES_THE_PAGE = "This script changes the page; rerun with mode 'write' (asks the user).";
const PAGE_CHANGED_TEXT = 'The page changed before the script ran, so it did not run. Observe the page again first.';

/** A script's outcome as the agent sees it: the result text, or an error message. */
export type ScriptOutcome = { ok: true; text: string } | { ok: false; error: string };

type Fields = Record<string, unknown>;
const asFields = (value: unknown): Fields | null => (value && typeof value === 'object' ? (value as Fields) : null);

/** The line of the agent's code CDP reports (0-based in the wrapper, so 1-based in the code), when it is one. */
const lineOf = (details: Fields, code: string | undefined): number | null => {
  const frames = asFields(details.stackTrace)?.callFrames;
  const top = Array.isArray(frames) ? asFields(frames[0])?.lineNumber : undefined;
  const line = typeof top === 'number' ? top : details.lineNumber;
  if (typeof line !== 'number' || line < 1) return null;
  return code === undefined || line <= code.split('\n').length ? line : null;
};

const exceptionText = (details: Fields, code: string | undefined): string => {
  const exception = asFields(details.exception);
  const described = typeof exception?.description === 'string' ? exception.description.split('\n')[0] : undefined;
  const value = exception && 'value' in exception ? String(exception.value) : undefined;
  if (described !== undefined && SIDE_EFFECT.test(described)) return CHANGES_THE_PAGE;
  if (value === PAGE_CHANGED) return PAGE_CHANGED_TEXT;
  const text = typeof details.text === 'string' ? details.text : 'unknown error';
  const message = sanitizePageText(described ?? value ?? text, MAX_ERROR_CHARS);
  const line = lineOf(details, code);
  return line === null ? `The script threw: ${message}` : `The script threw at line ${line}: ${message}`;
};

const truncatedNote = (length: number): string =>
  `[Truncated: the result has ${length} characters; only the first ${MAX_RESULT_CHARS} are shown.]`;

/**
 * A `Runtime.evaluate` reply as the agent sees it: the returned value as JSON, cut to {@link MAX_RESULT_CHARS} with a
 * note (in the page already when it was too long, as `{ __truncated, length }`), or the exception's message and line in `code`. A malformed reply is an error.
 */
export const formatScriptReply = (reply: unknown, code?: string): ScriptOutcome => {
  const fields = asFields(reply);
  if (!fields) return { ok: false, error: 'The browser returned no script result.' };
  const details = asFields(fields.exceptionDetails);
  if (details) return { ok: false, error: exceptionText(details, code) };
  const result = asFields(fields.result);
  if (!result) return { ok: false, error: 'The browser returned no script result.' };
  if (typeof result.unserializableValue === 'string') return { ok: true, text: result.unserializableValue };
  const marker = asFields(result.value);
  if (typeof marker?.__truncated === 'string' && typeof marker.length === 'number') {
    return { ok: true, text: `${marker.__truncated.slice(0, MAX_RESULT_CHARS)}\n${truncatedNote(marker.length)}` };
  }
  const json = result.type === 'undefined' || !('value' in result) ? undefined : JSON.stringify(result.value);
  if (json === undefined) return { ok: true, text: 'undefined' };
  if (json.length <= MAX_RESULT_CHARS) return { ok: true, text: json };
  return { ok: true, text: `${json.slice(0, MAX_RESULT_CHARS)}\n${truncatedNote(json.length)}` };
};

/**
 * Runs `code` read-only in a fresh isolated world of the tab's top frame, the run that needs no approval:
 * `throwOnSideEffect` makes V8 refuse anything that would change the page, and an isolated world is no boundary of
 * its own (it shares the DOM, cookies and storage), so this is what keeps the run harmless.
 */
export async function runReadScript(ctx: ActionContext, code: string, form: ScriptForm): Promise<ScriptOutcome> {
  const { conn, sessionId } = ctx;
  const { contextId, origin } = await openScriptWorld((method, params) => conn.send(method, params, sessionId));
  // stdout is the MCP protocol channel; only the origin and the world are logged, never the code or the result.
  process.stderr.write(
    `[builtin-mcp-browser] run_script on ${origin ?? 'a non-web page'} (world: isolated, mode: read)\n`
  );
  const params = { ...readScriptParams(code, form), contextId };
  return formatScriptReply(await withScriptTimeout(conn.send('Runtime.evaluate', params, sessionId)), code);
}
