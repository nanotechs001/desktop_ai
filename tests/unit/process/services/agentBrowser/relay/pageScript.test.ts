/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * run_script's shared pieces: the in-page wrappers (read-only and write), the result cap, the confirm fields and the
 * 10 s guard.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MAX_RESULT_CHARS,
  PAGE_CHANGED,
  SCRIPT_TIMEOUT_MS,
  readScriptParams,
  scriptAsk,
  withScriptTimeout,
  writeScriptParams,
} from '@process/services/agentBrowser/relay/pageScript';
import { decideRelayCommand } from '@process/services/agentBrowser/relay/relayPolicy';

/** Runs a wrapped expression the way Runtime.evaluate with awaitPromise would: its completion value, awaited. */
const evaluate = async (expression: string): Promise<unknown> =>
  // oxlint-disable-next-line no-eval -- the test stands in for the page's JS engine
  (0, eval)(expression);

const ORIGIN = 'https://shop.test';

beforeEach(() => {
  vi.stubGlobal('location', { origin: ORIGIN });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('readScriptParams (no approval)', () => {
  it('is read-only: throwOnSideEffect, awaited, by value, CDP-timed, never the command-line API', () => {
    const params = readScriptParams('document.title', 'expression');
    expect(params).toMatchObject({
      throwOnSideEffect: true,
      awaitPromise: true,
      returnByValue: true,
      timeout: SCRIPT_TIMEOUT_MS,
    });
    expect(params).not.toHaveProperty('includeCommandLineAPI');
    expect(params).not.toHaveProperty('contextId');
    // A timer is a side effect: read-only runs rely on the CDP timeout and the caller's guard instead.
    expect(params.expression).not.toContain('setTimeout');
    expect(SCRIPT_TIMEOUT_MS).toBe(10_000);
  });

  it('runs an expression (a trailing semicolon or comment is fine) and a function body', async () => {
    expect(await evaluate(readScriptParams('1 + 1;', 'expression').expression)).toBe(2);
    expect(await evaluate(readScriptParams('Promise.resolve(3) // three', 'expression').expression)).toBe(3);
    expect(await evaluate(readScriptParams('const a = 2;\nreturn a * 4;', 'body').expression)).toBe(8);
  });

  it('keeps the agent line numbers: line n of the code is line n after the wrapper line', () => {
    const lines = readScriptParams('one\ntwo', 'body').expression.split('\n');
    expect(lines[1]).toBe('one');
    expect(lines[2]).toBe('two');
  });

  it('caps a big result in the page, marking it with its full length', async () => {
    const capped = await evaluate(readScriptParams(`'x'.repeat(30000)`, 'expression').expression);
    expect(capped).toEqual({ __truncated: `"${'x'.repeat(MAX_RESULT_CHARS - 1)}`, length: 30_002 });
    expect(await evaluate(readScriptParams('({ a: 1 })', 'expression').expression)).toEqual({ a: 1 });
    expect(MAX_RESULT_CHARS).toBe(20_000);
  });
});

describe('writeScriptParams (after the ask)', () => {
  it('first checks the page still has the approved origin, on the wrapper line', async () => {
    const { expression } = writeScriptParams('1', 'expression', ORIGIN);
    expect(expression.split('\n')[0]).toContain(
      `if (location.origin !== ${JSON.stringify(ORIGIN)}) throw ${JSON.stringify(PAGE_CHANGED)};`
    );
    expect(await evaluate(expression)).toBe(1);
    vi.stubGlobal('location', { origin: 'https://evil.test' });
    await expect(evaluate(expression)).rejects.toBe(PAGE_CHANGED);
  });

  it('is not read-only and rejects a script that never settles after 10 s, in the page itself', async () => {
    const params = writeScriptParams('new Promise(() => {})', 'expression', ORIGIN);
    expect(params).not.toHaveProperty('throwOnSideEffect');
    expect(params).toMatchObject({ awaitPromise: true, returnByValue: true, timeout: SCRIPT_TIMEOUT_MS });
    vi.useFakeTimers();
    const outcome = evaluate(params.expression).then(
      () => 'resolved',
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS);
    expect(await outcome).toMatch(/timed out after 10000 ms/);
  });

  it('caps a big result too', async () => {
    const capped = await evaluate(writeScriptParams(`return 'y'.repeat(25000);`, 'body', ORIGIN).expression);
    expect(capped).toMatchObject({ length: 25_002 });
  });

  it('is still denied by the relay policy without the relay: main-world evaluate stays closed', () => {
    const decision = decideRelayCommand({
      client: { clientId: 'c1', label: 'claude' },
      method: 'Runtime.evaluate',
      params: writeScriptParams('document.cookie', 'expression', ORIGIN),
      tab: {
        webContentsId: 7,
        owner: { clientId: 'c1', label: 'claude' },
        sharedWith: null,
        profile: { kind: 'personal' },
      },
      ownContexts: new Set([3]),
      blockedPorts: new Set(),
    });
    expect(decision.allow).toBe(false);
  });
});

describe('scriptAsk', () => {
  it('shows the code with its lines, without hidden characters, up to 4000 characters, with its full length', () => {
    expect(scriptAsk('const a = 1;\n\treturn a;‮')).toEqual({
      label: '</> const a = 1;\n\treturn a;',
      codeLength: 24,
    });
    const long = scriptAsk(`fetch('/api')${'x'.repeat(5000)}`);
    expect(Array.from(long.label)).toHaveLength(4 + 4000 + 1);
    expect(long.label.endsWith('…')).toBe(true);
    expect(long.codeLength).toBe(5013);
  });
});

describe('withScriptTimeout', () => {
  it('passes a result through and rejects a hung call after the timeout plus grace', async () => {
    expect(await withScriptTimeout(Promise.resolve(5))).toBe(5);
    vi.useFakeTimers();
    const hung = withScriptTimeout(new Promise(() => {})).catch((error: Error) => error.message);
    await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS * 2);
    expect(await hung).toMatch(/did not finish within 10000 ms/);
  });
});
