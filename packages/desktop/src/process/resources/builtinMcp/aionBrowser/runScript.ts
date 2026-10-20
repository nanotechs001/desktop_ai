/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { webOriginOf } from '@process/services/agentBrowser/confirmGate';
import {
  scriptEvaluateParams,
  withScriptTimeout,
  type ScriptForm,
} from '@process/services/agentBrowser/relay/pageScript';
import { sanitizePageText } from '@/common/utils/utils';
import type { ActionContext } from './actions';

/** Characters of a script's JSON result the agent gets; the rest is cut with a note. */
export const MAX_RESULT_CHARS = 20_000;
/** Characters of an exception message the agent gets. */
const MAX_ERROR_CHARS = 500;
/** Its own world, apart from the one observe and act run in, so a script cannot disturb them. */
const WORLD_NAME = 'aion-browser-script';

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
  const text = typeof details.text === 'string' ? details.text : 'unknown error';
  const message = sanitizePageText(described ?? value ?? text, MAX_ERROR_CHARS);
  const line = lineOf(details, code);
  return line === null ? `The script threw: ${message}` : `The script threw at line ${line}: ${message}`;
};

/**
 * A `Runtime.evaluate` reply as the agent sees it: the returned value as JSON, cut to {@link MAX_RESULT_CHARS} with a
 * note, or the exception's message and line in `code`. A malformed reply is an error.
 */
export const formatScriptReply = (reply: unknown, code?: string): ScriptOutcome => {
  const fields = asFields(reply);
  if (!fields) return { ok: false, error: 'The browser returned no script result.' };
  const details = asFields(fields.exceptionDetails);
  if (details) return { ok: false, error: exceptionText(details, code) };
  const result = asFields(fields.result);
  if (!result) return { ok: false, error: 'The browser returned no script result.' };
  if (typeof result.unserializableValue === 'string') return { ok: true, text: result.unserializableValue };
  const json = result.type === 'undefined' || !('value' in result) ? undefined : JSON.stringify(result.value);
  if (json === undefined) return { ok: true, text: 'undefined' };
  if (json.length <= MAX_RESULT_CHARS) return { ok: true, text: json };
  const note = `[Truncated: the result has ${json.length} characters; only the first ${MAX_RESULT_CHARS} are shown.]`;
  return { ok: true, text: `${json.slice(0, MAX_RESULT_CHARS)}\n${note}` };
};

type FrameTree = { frameTree?: { frame?: { id?: unknown; securityOrigin?: unknown } } };

/**
 * Runs `code` in a fresh isolated world of the tab's top frame: it sees and changes the page's DOM, but not the
 * page's own JS globals. The relay only lets it into worlds this client created, so no approval is needed.
 */
export async function runIsolatedScript(ctx: ActionContext, code: string, form: ScriptForm): Promise<ScriptOutcome> {
  const { conn, sessionId } = ctx;
  const { frameTree } = await conn.send<FrameTree>('Page.getFrameTree', {}, sessionId);
  const frameId = frameTree?.frame?.id;
  if (typeof frameId !== 'string') return { ok: false, error: 'The page is not readable right now; try again.' };
  // shortcut: a new world per run (they live until the document goes), cache one per document if runs pile up.
  const { executionContextId } = await conn.send<{ executionContextId?: unknown }>(
    'Page.createIsolatedWorld',
    { frameId, worldName: WORLD_NAME },
    sessionId
  );
  if (typeof executionContextId !== 'number') return { ok: false, error: 'Could not prepare the page for a script.' };
  const origin =
    typeof frameTree?.frame?.securityOrigin === 'string' ? webOriginOf(frameTree.frame.securityOrigin) : null;
  // stdout is the MCP protocol channel; only the origin and the world are logged, never the code or the result.
  process.stderr.write(`[builtin-mcp-browser] run_script on ${origin ?? 'a non-web page'} (world: isolated)\n`);
  const params = { ...scriptEvaluateParams(code, form), contextId: executionContextId };
  return formatScriptReply(await withScriptTimeout(conn.send('Runtime.evaluate', params, sessionId)), code);
}
