/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * run_script's shared pieces: the in-page wrapper, the confirm preview and the 10 s guard.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  SCRIPT_TIMEOUT_MS,
  scriptEvaluateParams,
  scriptPreview,
  withScriptTimeout,
} from '@process/services/agentBrowser/relay/pageScript';
import { decideRelayCommand } from '@process/services/agentBrowser/relay/relayPolicy';

/** Runs the wrapped expression the way Runtime.evaluate with awaitPromise would. */
const run = (code: string, form: 'expression' | 'body'): Promise<unknown> =>
  // oxlint-disable-next-line no-new-func -- the test stands in for the page's JS engine
  Promise.resolve(new Function(`return ${scriptEvaluateParams(code, form).expression};`)());

afterEach(() => {
  vi.useRealTimers();
});

describe('scriptEvaluateParams', () => {
  it('awaits the promise, returns by value, sets the CDP timeout and never asks for the command-line API', () => {
    const params = scriptEvaluateParams('1 + 1', 'expression');
    expect(params).toMatchObject({ awaitPromise: true, returnByValue: true, timeout: SCRIPT_TIMEOUT_MS });
    expect(params).not.toHaveProperty('includeCommandLineAPI');
    expect(params).not.toHaveProperty('contextId');
    expect(SCRIPT_TIMEOUT_MS).toBe(10_000);
  });

  it('runs an expression (a trailing semicolon or comment is fine) and a function body', async () => {
    expect(await run('1 + 1;', 'expression')).toBe(2);
    expect(await run('Promise.resolve(3) // three', 'expression')).toBe(3);
    expect(await run('const a = 2;\nreturn a * 4;', 'body')).toBe(8);
  });

  it('keeps the agent line numbers: line n of the code is line n after the wrapper line', () => {
    const lines = scriptEvaluateParams('one\ntwo', 'body').expression.split('\n');
    expect(lines[1]).toBe('one');
    expect(lines[2]).toBe('two');
  });

  it('rejects a script that never settles after 10 s, in the page itself', async () => {
    vi.useFakeTimers();
    const pending = run('new Promise(() => {})', 'expression');
    const outcome = pending.then(
      () => 'resolved',
      (error: Error) => error.message
    );
    await vi.advanceTimersByTimeAsync(SCRIPT_TIMEOUT_MS);
    expect(await outcome).toMatch(/timed out after 10000 ms/);
  });

  it('is still denied by the relay policy without a permit: main-world evaluate stays closed', () => {
    const decision = decideRelayCommand({
      client: { clientId: 'c1', label: 'claude' },
      method: 'Runtime.evaluate',
      params: scriptEvaluateParams('document.cookie', 'expression'),
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

describe('scriptPreview', () => {
  it('is the first 120 characters on one line, without hidden characters, marked when cut', () => {
    expect(scriptPreview('  document.title\n')).toBe('document.title');
    expect(scriptPreview('a‮\nb')).toBe('a b');
    const long = scriptPreview(`fetch('/api')${'x'.repeat(300)}`);
    expect(Array.from(long)).toHaveLength(121);
    expect(long.endsWith('…')).toBe(true);
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
