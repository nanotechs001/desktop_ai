/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared by the relay (write runs) and the standalone aion-browser MCP (read runs): no electron imports here.
import { webOriginOf } from '../confirmGate';

/** How long one run_script may run before it is an error. */
export const SCRIPT_TIMEOUT_MS = 10_000;
/** Extra wait before the caller gives up on a script whose own timers were stopped or replaced by the page. */
const GUARD_GRACE_MS = 2000;
/** Characters of code one run_script may carry. */
export const MAX_SCRIPT_CHARS = 50_000;
/** Characters of a script's JSON result the agent gets; a longer one is cut in the page, with a marker. */
export const MAX_RESULT_CHARS = 20_000;
/** Characters of code the user sees in a script ask. */
const ASK_CODE_CHARS = 4000;
/** Marks a script ask's label, so a WebUI from before script asks still shows it as code. */
const ASK_LABEL_PREFIX = '</> ';
/** The isolated world scripts run in, apart from the one observe and act use, so a script cannot disturb them. */
const SCRIPT_WORLD_NAME = 'aion-browser-script';
/** What a write script throws when the tab no longer shows the origin the user approved. */
export const PAGE_CHANGED = 'run_script: the page changed';

/** `expression`: one expression, e.g. `document.title`. `body`: a function body that `return`s its result. */
export const SCRIPT_FORMS = ['expression', 'body'] as const;
export type ScriptForm = (typeof SCRIPT_FORMS)[number];

/** Where a write script runs: beside the page's DOM without its JS globals, or in the page's own JS world. */
export const SCRIPT_WORLDS = ['isolated', 'page'] as const;
export type ScriptWorld = (typeof SCRIPT_WORLDS)[number];

export const isScriptForm = (value: unknown): value is ScriptForm =>
  typeof value === 'string' && (SCRIPT_FORMS as readonly string[]).includes(value);

export const isScriptWorld = (value: unknown): value is ScriptWorld =>
  typeof value === 'string' && (SCRIPT_WORLDS as readonly string[]).includes(value);

/** Turns a JSON result over {@link MAX_RESULT_CHARS} into `{ __truncated, length }`, in the page, before it is sent. */
const CAP_RESULT = `try { const __s = JSON.stringify(__v); return __s !== undefined && __s.length > ${MAX_RESULT_CHARS} ? { __truncated: __s.slice(0, ${MAX_RESULT_CHARS}), length: __s.length } : __v; } catch { return __v; }`;

/**
 * The agent's code as one expression with its result capped. A write run is awaited and `race`d against an in-page
 * {@link SCRIPT_TIMEOUT_MS} timer. A read-only run is synchronous: V8's side-effect check refuses any `await` (and the
 * timer), so with them every read would fail (measured in Electron 37). Everything before the code sits on the first
 * line, so line n of the code is 0-based line n of the expression (what CDP reports).
 */
const wrapScript = (code: string, form: ScriptForm, mode: 'read' | 'write'): string => {
  const [open, close] = form === 'body' ? ['{', '}'] : ['(', ')'];
  // A trailing semicolon would end the expression early; trailing comments are safe on their own line.
  const source = form === 'body' ? code : code.replace(/[\s;]+$/, '');
  if (mode === 'read') return `(() => { const __v = (() => ${open}\n${source}\n${close})(); ${CAP_RESULT} })()`;
  const run = `(async () => ${open}\n${source}\n${close})()`;
  const timeout = `new Promise((_, reject) => setTimeout(() => reject(new Error('run_script timed out after ${SCRIPT_TIMEOUT_MS} ms')), ${SCRIPT_TIMEOUT_MS}))`;
  return `(async () => { const __v = await Promise.race([${run}, ${timeout}]); ${CAP_RESULT} })()`;
};

const EVALUATE = { awaitPromise: true, returnByValue: true, timeout: SCRIPT_TIMEOUT_MS } as const;

/**
 * `Runtime.evaluate` params for a read-only script, the run that needs no approval: V8 throws "Possible side-effect"
 * at anything that would change the page (DOM writes, fetch, storage, timers). The caller adds its isolated world.
 */
export const readScriptParams = (code: string, form: ScriptForm) => ({
  expression: wrapScript(code, form, 'read'),
  ...EVALUATE,
  throwOnSideEffect: true,
});

/**
 * `Runtime.evaluate` params for a script the user allowed on `expectOrigin`. It first throws {@link PAGE_CHANGED} when
 * the tab shows another origin by the time it starts (a navigation between the answer and the run).
 */
export const writeScriptParams = (code: string, form: ScriptForm, expectOrigin: string) => ({
  expression: `if (location.origin !== ${JSON.stringify(expectOrigin)}) throw ${JSON.stringify(PAGE_CHANGED)}; ${wrapScript(code, form, 'write')}`,
  ...EVALUATE,
});

/**
 * The write run as a function declaration, for `Runtime.callFunctionOn` on a frame's own JS world: the same origin
 * check and wrapper as {@link writeScriptParams}, everything before the code on the first line.
 */
const writeScriptFunction = (code: string, form: ScriptForm, expectOrigin: string): string =>
  `function () { if (location.origin !== ${JSON.stringify(expectOrigin)}) throw ${JSON.stringify(PAGE_CHANGED)}; return ${wrapScript(code, form, 'write')}; }`;

/** Hidden characters (bidi, controls, line separators), but not newlines, tabs or emoji joiners. */
const HIDDEN_IN_CODE = /(?![\n\t\u200C\u200D])[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu;

/**
 * What a script ask shows: the code as text with its lines, without hidden characters, cut to 4000 characters
 * (`…` when cut) and prefixed with `</> `, and the code's full length.
 */
export const scriptAsk = (code: string): { label: string; codeLength: number } => {
  const chars = Array.from(code.replace(HIDDEN_IN_CODE, ' ').trimEnd());
  const shown = chars.length > ASK_CODE_CHARS ? `${chars.slice(0, ASK_CODE_CHARS).join('')}…` : chars.join('');
  return { label: `${ASK_LABEL_PREFIX}${shown}`, codeLength: Array.from(code).length };
};

type Send = (method: string, params: Record<string, unknown>) => Promise<unknown>;

const fieldsOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/** What a run_script that names a frame gets when the frame is no longer in its session. */
export const FRAME_GONE = 'The frame is gone; observe the page again.';

type FrameNode = { frame?: Record<string, unknown>; childFrames?: FrameNode[] };

/** The frame `frameId` in `tree` (the tree's root frame when absent), as CDP describes it; null when not there. */
const findFrame = (tree: FrameNode, frameId?: string): Record<string, unknown> | null => {
  if (frameId === undefined || tree.frame?.id === frameId) return tree.frame ?? null;
  return (tree.childFrames ?? []).reduce<Record<string, unknown> | null>(
    (hit, c) => hit ?? findFrame(c, frameId),
    null
  );
};

/**
 * A fresh isolated world in frame `frameId` of the session `send` talks to (its top frame when absent), and that
 * frame's origin (null for a non-web page). Throws {@link FRAME_GONE} for a frame the session no longer has, and when
 * the page has no readable frame or world.
 */
export async function openScriptWorld(
  send: Send,
  frameId?: string
): Promise<{ contextId: number; origin: string | null }> {
  const frame = findFrame(fieldsOf(fieldsOf(await send('Page.getFrameTree', {})).frameTree), frameId);
  if (typeof frame?.id !== 'string')
    throw new Error(frameId ? FRAME_GONE : 'The page is not readable right now; try again.');
  // shortcut: a new world per run (they live until the document goes), cache one per document if runs pile up.
  const world = fieldsOf(await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: SCRIPT_WORLD_NAME }));
  if (typeof world.executionContextId !== 'number') throw new Error('Could not prepare the page for a script.');
  const origin = typeof frame.securityOrigin === 'string' ? webOriginOf(frame.securityOrigin) : null;
  return { contextId: world.executionContextId, origin };
}

/** A write script and where it runs: `frameId` is a frame of the session (its top frame when absent). */
export type WriteScript = { code: string; form: ScriptForm; world: ScriptWorld; frameId?: string };

/**
 * Runs a write script the user allowed on `expectOrigin` (the origin of the frame it runs in) and resolves with the
 * CDP reply. Without a frame it runs in the session's top frame as always: the page's JS world, or a fresh isolated
 * world. In a named frame the isolated world is that frame's; its own JS world has no context id without
 * Runtime.enable, so the script is called on the frame's document resolved into that world.
 */
export async function evaluateWriteScript(send: Send, script: WriteScript, expectOrigin: string): Promise<unknown> {
  const { code, form, world, frameId } = script;
  const params = writeScriptParams(code, form, expectOrigin);
  if (world === 'page' && frameId === undefined) return send('Runtime.evaluate', params);
  const { contextId } = await openScriptWorld(send, frameId);
  if (world === 'isolated') return send('Runtime.evaluate', { ...params, contextId });
  const doc = fieldsOf(fieldsOf(await send('Runtime.evaluate', { expression: 'document', contextId })).result);
  const node = fieldsOf(fieldsOf(await send('DOM.describeNode', { objectId: doc.objectId })).node);
  const inPage = fieldsOf(fieldsOf(await send('DOM.resolveNode', { backendNodeId: node.backendNodeId })).object);
  if (typeof inPage.objectId !== 'string') throw new Error('Could not prepare the page for a script.');
  return send('Runtime.callFunctionOn', {
    objectId: inPage.objectId,
    functionDeclaration: writeScriptFunction(code, form, expectOrigin),
    awaitPromise: true,
    returnByValue: true,
  });
}

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
