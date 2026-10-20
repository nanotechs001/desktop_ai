/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The run_script tool: isolated-world scripts without approval, page-world scripts through the relay's ask.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RelayClient } from '@process/resources/builtinMcp/aionBrowser/relayClient';
import { MAX_RESULT_CHARS, formatScriptReply } from '@process/resources/builtinMcp/aionBrowser/runScript';
import { createBrowserMcpServer } from '@process/resources/builtinMcp/aionBrowser/tools';
import { FakeRelay } from './fakeRelay';

type ToolReply = { isError?: boolean; content: Array<{ type: string; text?: string }> };

let relay: FakeRelay;
let relayClient: RelayClient;
let client: Client;

const TREE = { frameTree: { frame: { id: 'TOP', url: 'https://shop.test/', securityOrigin: 'https://shop.test' } } };

beforeEach(async () => {
  relay = await FakeRelay.start();
  relay.on('Target.createTarget', () => ({ targetId: 'wc-7' }));
  relay.on('Target.attachToTarget', () => ({ sessionId: 's1' }));
  relay.on('Emulation.setFocusEmulationEnabled', () => ({}));
  relay.on('Page.getFrameTree', () => TREE);
  relay.on('Page.createIsolatedWorld', () => ({ executionContextId: 41 }));
  relay.on('Runtime.evaluate', () => ({ result: { type: 'object', value: { title: 'Shop' } } }));
  relayClient = new RelayClient(relay.env, () => 'test-agent');
  const server = createBrowserMcpServer(relayClient);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
  await client.callTool({ name: 'tabs', arguments: { action: 'open', url: 'https://shop.test/' } });
});

afterEach(async () => {
  await client.close();
  relayClient.close();
  await relay.stop();
});

const runScript = async (args: Record<string, unknown>): Promise<ToolReply> =>
  (await client.callTool({ name: 'run_script', arguments: args })) as ToolReply;
const textOf = (reply: ToolReply): string => reply.content.map((part) => part.text ?? '').join('');

describe('run_script, isolated world', () => {
  it('returns the value as JSON from its own isolated world, without asking the user', async () => {
    const reply = await runScript({ code: '({ title: document.title })' });
    expect(reply.isError).toBeFalsy();
    expect(JSON.parse(textOf(reply))).toEqual({ title: 'Shop' });

    expect(relay.callsTo('Page.createIsolatedWorld')).toEqual([{ frameId: 'TOP', worldName: 'aion-browser-script' }]);
    const [evaluate] = relay.callsTo('Runtime.evaluate');
    expect(evaluate).toMatchObject({ contextId: 41, awaitPromise: true, returnByValue: true, timeout: 10_000 });
    expect(evaluate).not.toHaveProperty('includeCommandLineAPI');
    expect(relay.callsTo('AionRelay.requestConfirm')).toEqual([]);
    expect(relay.callsTo('AionRelay.runPageScript')).toEqual([]);
  });

  it('reports a thrown exception with its message and line', async () => {
    relay.on('Runtime.evaluate', () => ({
      result: { type: 'object', subtype: 'error' },
      exceptionDetails: {
        text: 'Uncaught',
        lineNumber: 2,
        columnNumber: 6,
        exception: { type: 'object', description: 'TypeError: x is null\n    at <anonymous>:3:7' },
      },
    }));
    const reply = await runScript({ code: 'const x = null;\nx.y;', form: 'body' });
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toBe('The script threw at line 2: TypeError: x is null');
  });

  it('gives the script timeout as an error', async () => {
    relay.on('Runtime.evaluate', () => ({
      result: { type: 'object', subtype: 'error' },
      exceptionDetails: {
        text: 'Uncaught',
        lineNumber: 9,
        exception: { type: 'object', description: 'Error: run_script timed out after 10000 ms' },
      },
    }));
    const reply = await runScript({ code: 'new Promise(() => {})' });
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toBe('The script threw: Error: run_script timed out after 10000 ms');
  });
});

describe('run_script, page world', () => {
  it('runs through the relay ask on the tab session and returns the value', async () => {
    relay.on('AionRelay.runPageScript', () => ({ allow: true, reply: { result: { type: 'number', value: 3 } } }));
    const reply = await runScript({ code: 'window.app.count', world: 'page' });
    expect(reply.isError).toBeFalsy();
    expect(textOf(reply)).toBe('3');
    expect(relay.callsTo('AionRelay.runPageScript')).toEqual([
      { webContentsId: 7, sessionId: 's1', code: 'window.app.count', form: 'expression' },
    ]);
    // The page world is never reached through a raw evaluate.
    expect(relay.callsTo('Runtime.evaluate')).toEqual([]);
  });

  it('a denied or unanswered ask is a clear tool error', async () => {
    relay.on('AionRelay.runPageScript', () => ({ allow: false }));
    const reply = await runScript({ code: 'window.app', world: 'page' });
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toMatch(/^The user did not allow this page script/);
  });

  it('a refused tab is a tool error', async () => {
    relay.on('AionRelay.runPageScript', () => {
      throw new Error('This tab is not shared with agents');
    });
    const reply = await runScript({ code: 'window.app', world: 'page' });
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toBe('This tab is not shared with agents');
  });
});

describe('formatScriptReply', () => {
  it('cuts results over 20 000 characters and says so', () => {
    const out = formatScriptReply({ result: { type: 'string', value: 'x'.repeat(30_000) } });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const [json, note] = out.text.split('\n');
    expect(json).toHaveLength(MAX_RESULT_CHARS);
    expect(note).toBe('[Truncated: the result has 30002 characters; only the first 20000 are shown.]');
    expect(MAX_RESULT_CHARS).toBe(20_000);
  });

  it('shows undefined and unserializable values, and a thrown non-error value', () => {
    expect(formatScriptReply({ result: { type: 'undefined' } })).toEqual({ ok: true, text: 'undefined' });
    expect(formatScriptReply({ result: { type: 'number', unserializableValue: 'NaN' } })).toEqual({
      ok: true,
      text: 'NaN',
    });
    expect(
      formatScriptReply({
        exceptionDetails: { text: 'Uncaught', lineNumber: 0, exception: { type: 'string', value: 'nope' } },
      })
    ).toEqual({ ok: false, error: 'The script threw: nope' });
  });

  it('treats a malformed reply as an error, never a result', () => {
    expect(formatScriptReply(null).ok).toBe(false);
    expect(formatScriptReply('x').ok).toBe(false);
  });
});
