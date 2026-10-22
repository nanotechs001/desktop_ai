/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The run_script tool: read-only scripts without approval (isolated world, throwOnSideEffect), scripts that write only
 * through the relay's ask, in the isolated or the page world.
 */

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RelayClient } from '@process/resources/builtinMcp/aionBrowser/relayClient';
import { formatScriptReply } from '@process/resources/builtinMcp/aionBrowser/runScript';
import { MAX_RESULT_CHARS, PAGE_CHANGED } from '@process/services/agentBrowser/relay/pageScript';
import { createBrowserMcpServer } from '@process/resources/builtinMcp/aionBrowser/tools';
import { FakeRelay } from './fakeRelay';

/** Frames as the latest observe of the tab left them: f3 is a canvas frame inside a cross-origin builder session. */
vi.mock('@process/resources/builtinMcp/aionBrowser/frames', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@process/resources/builtinMcp/aionBrowser/frames')>()),
  frameByKey: (_conn: unknown, pageSessionId: string, key: string) =>
    pageSessionId === 's1' && key === 'f3' ? { frameKey: 'f3', sessionId: 'oopif-1', frameId: 'CANVAS' } : undefined,
}));

type ToolReply = { isError?: boolean; content: Array<{ type: string; text?: string }> };

let relay: FakeRelay;
let relayClient: RelayClient;
let client: Client;

const TREE = { frameTree: { frame: { id: 'TOP', url: 'https://shop.test/', securityOrigin: 'https://shop.test' } } };
const BUILDER_TREE = {
  frameTree: {
    frame: { id: 'BUILDER', url: 'https://builder.test/', securityOrigin: 'https://builder.test' },
    childFrames: [{ frame: { id: 'CANVAS', url: 'https://builder.test/c', securityOrigin: 'https://builder.test' } }],
  },
};

beforeEach(async () => {
  relay = await FakeRelay.start();
  relay.on('Target.createTarget', () => ({ targetId: 'wc-7' }));
  relay.on('Target.attachToTarget', () => ({ sessionId: 's1' }));
  relay.on('Emulation.setFocusEmulationEnabled', () => ({}));
  relay.on('Page.getFrameTree', (_params, sessionId) => (sessionId === 'oopif-1' ? BUILDER_TREE : TREE));
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

const SIDE_EFFECT = {
  result: { type: 'object', subtype: 'error' },
  exceptionDetails: {
    text: 'Uncaught',
    lineNumber: 1,
    exception: {
      type: 'object',
      description: 'EvalError: Possible side-effect in debug-evaluate\n    at <anonymous>:2:16',
    },
  },
};

describe('run_script description', () => {
  it('never presents the isolated world as a boundary, and warns that a busy loop freezes the tab', async () => {
    const { tools } = await client.listTools();
    const description = tools.find((tool) => tool.name === 'run_script')?.description ?? '';
    expect(description).not.toMatch(/sandbox/i);
    expect(description).toContain('mode read (default): read-only, no approval.');
    expect(description).toContain('Either can change anything on the site.');
    expect(description).toContain('a busy loop freezes its tab');
    expect(description).toContain('frame: run inside an iframe from observe (e.g. f2)');
  });
});

describe('run_script, read mode (the default)', () => {
  it('reports its tab first, so the pane shows the tab the script runs on', async () => {
    relay.on('AionRelay.reportAction', () => ({}));
    await runScript({ code: 'document.title' });
    const reports = relay.callsTo('AionRelay.reportAction').filter((r) => r.op !== 'open');
    expect(reports).toEqual([{ webContentsId: expect.any(Number), op: 'script', label: '', rect: null }]);
  });

  it('returns the value as JSON from its own isolated world, read-only, without asking the user', async () => {
    const reply = await runScript({ code: '({ title: document.title })' });
    expect(reply.isError).toBeFalsy();
    expect(JSON.parse(textOf(reply))).toEqual({ title: 'Shop' });

    expect(relay.callsTo('Page.createIsolatedWorld')).toEqual([{ frameId: 'TOP', worldName: 'aion-browser-script' }]);
    const [evaluate] = relay.callsTo('Runtime.evaluate');
    expect(evaluate).toMatchObject({
      contextId: 41,
      throwOnSideEffect: true,
      awaitPromise: true,
      returnByValue: true,
      timeout: 10_000,
    });
    expect(evaluate).not.toHaveProperty('includeCommandLineAPI');
    expect(relay.callsTo('AionRelay.requestConfirm')).toEqual([]);
    expect(relay.callsTo('AionRelay.runScript')).toEqual([]);
  });

  it('refuses a script that changes the page (e.g. appends a <script>) and points to mode write', async () => {
    relay.on('Runtime.evaluate', () => SIDE_EFFECT);
    const reply = await runScript({ code: "document.body.append(document.createElement('script'))" });
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toBe("This script changes the page; rerun with mode 'write' (asks the user).");
    expect(relay.callsTo('Runtime.evaluate')[0]).toMatchObject({ throwOnSideEffect: true });
  });

  it('refuses world page without mode write, before touching the page', async () => {
    const reply = await runScript({ code: 'window.app', world: 'page' });
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toMatch(/mode 'write'/);
    expect(relay.callsTo('Runtime.evaluate')).toEqual([]);
    expect(relay.callsTo('AionRelay.runScript')).toEqual([]);
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
        lineNumber: 0,
        exception: { type: 'object', description: 'Error: Execution was terminated' },
      },
    }));
    const reply = await runScript({ code: 'while (true) {}' });
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toBe('The script threw: Error: Execution was terminated');
  });

  it('logs only the origin and the world to stderr, never the code or the result', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    await runScript({ code: 'secretCode()' });
    const logged = stderr.mock.calls.map(([line]) => String(line)).join('');
    stderr.mockRestore();
    expect(logged).toBe('[builtin-mcp-browser] run_script on https://shop.test (world: isolated, mode: read)\n');
  });
});

describe('run_script, write mode', () => {
  it.each(['isolated', 'page'] as const)('world %s goes through the relay ask and returns the value', async (world) => {
    relay.on('AionRelay.runScript', () => ({ allow: true, reply: { result: { type: 'number', value: 3 } } }));
    const reply = await runScript({ code: 'window.app.count', mode: 'write', world });
    expect(reply.isError).toBeFalsy();
    expect(textOf(reply)).toBe('3');
    expect(relay.callsTo('AionRelay.runScript')).toEqual([
      { webContentsId: 7, sessionId: 's1', code: 'window.app.count', form: 'expression', world },
    ]);
    // A write never runs through a raw evaluate of the MCP's own.
    expect(relay.callsTo('Runtime.evaluate')).toEqual([]);
    expect(relay.callsTo('Page.createIsolatedWorld')).toEqual([]);
  });

  it('defaults to the isolated world', async () => {
    relay.on('AionRelay.runScript', () => ({ allow: true, reply: { result: { type: 'undefined' } } }));
    await runScript({ code: 'document.title = "x"', mode: 'write' });
    expect(relay.callsTo('AionRelay.runScript')[0]).toMatchObject({ world: 'isolated' });
  });

  it('a denied or unanswered ask is a clear tool error', async () => {
    relay.on('AionRelay.runScript', () => ({ allow: false }));
    const reply = await runScript({ code: 'window.app', mode: 'write', world: 'page' });
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toMatch(/^The user did not allow this script/);
  });

  it('a page that changed before the run is a clear tool error', async () => {
    relay.on('AionRelay.runScript', () => ({
      allow: true,
      reply: {
        exceptionDetails: { text: 'Uncaught', lineNumber: 0, exception: { type: 'string', value: PAGE_CHANGED } },
      },
    }));
    const reply = await runScript({ code: 'window.app', mode: 'write' });
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toBe(
      'The page changed before the script ran, so it did not run. Observe the page again first.'
    );
  });

  it('a refused tab is a tool error', async () => {
    relay.on('AionRelay.runScript', () => {
      throw new Error('This tab is not shared with agents');
    });
    const reply = await runScript({ code: 'window.app', mode: 'write', world: 'page' });
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toBe('This tab is not shared with agents');
  });
});

describe('run_script, frame', () => {
  it('reads in the frame from the latest observe, in its own session and frame', async () => {
    const reply = await runScript({ code: 'document.title', frame: 'f3' });
    expect(reply.isError).toBeFalsy();
    const worlds = relay.requests.filter((r) => r.method === 'Page.createIsolatedWorld');
    expect(worlds).toEqual([
      {
        method: 'Page.createIsolatedWorld',
        params: { frameId: 'CANVAS', worldName: 'aion-browser-script' },
        sessionId: 'oopif-1',
      },
    ]);
    const [evaluate] = relay.requests.filter((r) => r.method === 'Runtime.evaluate');
    expect(evaluate).toMatchObject({ sessionId: 'oopif-1', params: { contextId: 41, throwOnSideEffect: true } });
  });

  it('asks through the relay for that frame, on its session', async () => {
    relay.on('AionRelay.runScript', () => ({ allow: true, reply: { result: { type: 'number', value: 3 } } }));
    expect(textOf(await runScript({ code: 'window.app.count', mode: 'write', world: 'page', frame: 'f3' }))).toBe('3');
    expect(relay.callsTo('AionRelay.runScript')).toEqual([
      {
        webContentsId: 7,
        sessionId: 'oopif-1',
        frameId: 'CANVAS',
        code: 'window.app.count',
        form: 'expression',
        world: 'page',
      },
    ]);
  });

  it.each(['read', 'write'])('refuses an unknown frame id in mode %s, before touching the page', async (mode) => {
    const reply = await runScript({ code: 'document.title', mode, frame: 'f9' });
    expect(reply.isError).toBe(true);
    expect(textOf(reply)).toBe('Unknown frame f9; use a frame id from the latest observe.');
    expect(relay.callsTo('Runtime.evaluate')).toEqual([]);
    expect(relay.callsTo('AionRelay.runScript')).toEqual([]);
  });
});

describe('formatScriptReply', () => {
  it('reads the in-page truncation marker and says how long the result was', () => {
    const cut = `"${'x'.repeat(MAX_RESULT_CHARS - 1)}`;
    const out = formatScriptReply({ result: { type: 'object', value: { __truncated: cut, length: 30_002 } } });
    expect(out).toEqual({
      ok: true,
      text: `${cut}\n[Truncated: the result has 30002 characters; only the first 20000 are shown.]`,
    });
  });

  it('still cuts a result over 20 000 characters that came back whole', () => {
    const out = formatScriptReply({ result: { type: 'string', value: 'x'.repeat(30_000) } });
    if (!out.ok) throw new Error('expected a result');
    const [json, note] = out.text.split('\n');
    expect(json).toHaveLength(MAX_RESULT_CHARS);
    expect(note).toBe('[Truncated: the result has 30002 characters; only the first 20000 are shown.]');
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
