import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RelayClient } from '@process/resources/builtinMcp/aionBrowser/relayClient';
import { createBrowserMcpServer } from '@process/resources/builtinMcp/aionBrowser/tools';
import { FakeRelay } from './fakeRelay';

const PANE_SENTENCE = 'Use this AionUi browser pane tool, never an external browser.';
const PAUSED = 'Paused: the user took over this tab. Wait for the user to resume.';

type ToolReply = {
  isError?: boolean;
  content: Array<{ type: string; text?: string; data?: string; mimeType?: string }>;
};

const snapshotValue = {
  actions: [{ node: 3, role: 'button', label: 'Save', value: '', rect: { x: 10, y: 20, w: 80, h: 30 } }],
  text: 'Hello',
  omitted_actions: 0,
  page_key: 'pk',
  guards: { 3: 'g3' },
};

let relay: FakeRelay;
let client: Client;
let relayClient: RelayClient;

const call = async (name: string, args: Record<string, unknown>): Promise<ToolReply> =>
  (await client.callTool({ name, arguments: args })) as ToolReply;
const textOf = (reply: ToolReply): string => reply.content.map((part) => part.text ?? '').join('');
const inputRequests = () => relay.requests.filter((r) => r.method.startsWith('Input.'));

/** Opens wc-7 and observes it; returns the id of its "Save" button. */
const openAndObserve = async (): Promise<string> => {
  await call('tabs', { action: 'open' });
  const id = /\[(f\d+:3)\]/.exec(textOf(await call('observe', {})))?.[1];
  if (!id) throw new Error('no observed id');
  return id;
};

beforeEach(async () => {
  relay = await FakeRelay.start();
  relay.on('Target.createTarget', () => ({ targetId: 'wc-7' }));
  relay.on('Target.attachToTarget', () => ({ sessionId: 's1' }));
  relay.on('Emulation.setFocusEmulationEnabled', () => ({}));
  relay.on('Page.getLayoutMetrics', () => ({
    cssLayoutViewport: { clientWidth: 1200, clientHeight: 900 },
    cssVisualViewport: { pageX: 0, pageY: 0, clientWidth: 1200, clientHeight: 900 },
    visualViewport: { clientWidth: 1200, clientHeight: 900 },
  }));
  relay.on('Page.getFrameTree', () => ({
    frameTree: {
      frame: { id: 'F1', loaderId: 'L1', url: 'https://app.example/', securityOrigin: 'https://app.example' },
    },
  }));
  relay.on('Page.createIsolatedWorld', () => ({ executionContextId: 41 }));
  relay.on('Runtime.evaluate', () => ({ result: { type: 'object', value: snapshotValue } }));
  relay.on('Runtime.callFunctionOn', (params) =>
    String(params.functionDeclaration).includes('elementFromPoint')
      ? { result: { type: 'object', value: { rect: { x: 10, y: 20, w: 80, h: 30 }, label: 'Save', role: 'button' } } }
      : { result: { type: 'undefined' } }
  );
  relay.on('Input.dispatchMouseEvent', () => ({}));
  relay.on('AionRelay.reportAction', () => ({}));
  relayClient = new RelayClient(relay.env, () => 'test-agent');
  const server = createBrowserMcpServer(relayClient);
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: 'test-agent', version: '1.0.0' });
  await Promise.all([server.connect(serverSide), client.connect(clientSide)]);
});

afterEach(async () => {
  await client.close();
  relayClient.close();
  await relay.stop();
});

describe('act tool', () => {
  it('act never accepts a raw selector/coordinate: unknown target id → error, no input', async () => {
    await openAndObserve();
    for (const action of [
      { op: 'click', target: '#publish' },
      { op: 'click', target: 'button.save' },
      { op: 'click', x: 10, y: 20 },
      { op: 'click', target: 'f0:3', selector: '#publish' },
    ]) {
      expect((await call('act', { actions: [action] })).isError, JSON.stringify(action)).toBe(true);
    }
    const unknown = await call('act', { actions: [{ op: 'click', target: 'f99:1' }] });
    expect(textOf(unknown)).toContain('"result":"error"');
    expect(textOf(unknown)).toMatch(/Unknown target f99:1/);
    expect(inputRequests()).toEqual([]);
    expect(relay.callsTo('AionRelay.reportAction')).toEqual([]);
  });

  it('Input on a paused tab surfaces "user took over" and stops the batch', async () => {
    const id = await openAndObserve();
    relay.on('Input.dispatchMouseEvent', () => {
      throw new Error(PAUSED);
    });
    const reply = await call('act', {
      actions: [
        { op: 'click', target: id },
        { op: 'click', target: id },
      ],
    });
    const { results, stopped } = JSON.parse(textOf(reply)) as { results: unknown[]; stopped: string };
    expect(results).toEqual([{ op: 'click', target: id, result: 'paused', reason: PAUSED }]);
    expect(stopped).toMatch(/user took over/);
    expect(inputRequests()).toHaveLength(1);
    expect(relay.callsTo('AionRelay.reportAction')).toEqual([]);
  });

  it('clicks at the absolute center on the page session and reports the action to the relay', async () => {
    const id = await openAndObserve();
    const reply = await call('act', { actions: [{ op: 'click', target: id }] });
    expect(JSON.parse(textOf(reply))).toEqual({ results: [{ op: 'click', target: id, result: 'done' }] });
    const presses = relay.requests.filter((r) => r.method === 'Input.dispatchMouseEvent');
    expect(presses.map((r) => r.params.type)).toEqual(['mouseMoved', 'mousePressed', 'mouseReleased']);
    expect(presses.every((r) => r.sessionId === 's1' && r.params.x === 50 && r.params.y === 35)).toBe(true);
    expect(relay.callsTo('AionRelay.reportAction')).toEqual([
      { webContentsId: 7, op: 'click', label: `[${id}] Save`, rect: { x: 10, y: 20, width: 80, height: 30 } },
    ]);
  });

  it('runs observe and act on one tab one at a time, so concurrent calls never mint two keys', async () => {
    await call('tabs', { action: 'open' });
    const replies = await Promise.all([call('observe', {}), call('observe', {}), call('observe', {})]);
    const keys = replies.map((reply) => /\[(f\d+):3\]/.exec(textOf(reply))?.[1]);
    expect(new Set(keys).size).toBe(1);
    expect(relay.callsTo('Page.createIsolatedWorld')).toHaveLength(1);
  });

  it('switches focus emulation on once per tab', async () => {
    const id = await openAndObserve();
    await call('act', { actions: [{ op: 'click', target: id }] });
    expect(relay.callsTo('Emulation.setFocusEmulationEnabled')).toEqual([{ enabled: true }]);
  });
});

describe('fallback tools', () => {
  it('describes screenshot and click_point as fallbacks and every new tool as a pane tool', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name)).toEqual(['tabs', 'observe', 'act', 'drag', 'screenshot', 'click_point']);
    for (const tool of tools) expect(tool.description?.startsWith(PANE_SENTENCE)).toBe(true);
    for (const name of ['screenshot', 'click_point']) {
      expect(tools.find((tool) => tool.name === name)?.description).toMatch(/fallback/i);
    }
  });

  it('screenshot returns a JPEG image item', async () => {
    relay.on('Page.captureScreenshot', () => ({ data: '/9j/AAAA' }));
    await call('tabs', { action: 'open' });
    const reply = await call('screenshot', {});
    expect(reply.content).toEqual([{ type: 'image', data: '/9j/AAAA', mimeType: 'image/jpeg' }]);
    expect(relay.callsTo('Page.captureScreenshot')[0]).toMatchObject({ format: 'jpeg' });
  });

  it('click_point refuses non-finite and out-of-viewport points without input', async () => {
    await call('tabs', { action: 'open' });
    expect((await call('click_point', { x: Number.NaN, y: 1 })).isError).toBe(true);
    const outside = await call('click_point', { x: 1300, y: 1 });
    expect(outside.isError).toBe(true);
    expect(textOf(outside)).toMatch(/viewport/);
    expect(inputRequests()).toEqual([]);
    expect(JSON.parse(textOf(await call('click_point', { x: 5, y: 6 })))).toEqual({ result: 'done' });
    expect(relay.callsTo('AionRelay.reportAction')[0]).toMatchObject({ webContentsId: 7, op: 'click_point' });
  });
});
