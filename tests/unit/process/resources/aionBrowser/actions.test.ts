import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ENTER_LABELS, POINT_LABELS } from '@process/resources/builtinMcp/aionBrowser/inPage';
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

/** What ENTER_LABELS reports: the labels, and whether focus is on an iframe element / in this document. */
/** What POINT_LABELS reports: the labels under the point, and whether the hit is an iframe element. */
const pointReport = (labels: string[], framed = false) => ({ labels, framed });
const focusReport = (labels: string[], framed = false, focused = true) => ({ labels, framed, focused });

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
  relay.on('Runtime.callFunctionOn', (params) => {
    const fn = String(params.functionDeclaration);
    if (fn === ENTER_LABELS) return { result: { type: 'object', value: focusReport([]) } };
    if (fn === POINT_LABELS) return { result: { type: 'object', value: pointReport([]) } };
    return fn.includes('elementFromPoint')
      ? { result: { type: 'object', value: { rect: { x: 10, y: 20, w: 80, h: 30 }, label: 'Save', role: 'button' } } }
      : { result: { type: 'undefined' } };
  });
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

  it('surfaces "user took over" when the relay refuses the freshness check, with no input', async () => {
    const id = await openAndObserve();
    relay.on('Runtime.callFunctionOn', () => {
      throw new Error(PAUSED);
    });
    const reply = JSON.parse(textOf(await call('act', { actions: [{ op: 'click', target: id }] }))) as {
      results: unknown[];
    };
    expect(reply.results).toEqual([{ op: 'click', target: id, result: 'paused', reason: PAUSED }]);
    expect(inputRequests()).toEqual([]);
  });

  it('a page that never answers input gives "did not respond" and the tab stays usable', async () => {
    const id = await openAndObserve();
    relay.on('Input.dispatchMouseEvent', () => new Promise(() => {}));
    const reply = JSON.parse(textOf(await call('act', { actions: [{ op: 'click', target: id }] }))) as {
      results: unknown[];
    };
    expect(reply.results).toEqual([
      { op: 'click', target: id, result: 'error', reason: 'the page did not respond (a dialog may be open)' },
    ]);
    expect(inputRequests()).toHaveLength(1); // never retried
    expect((await call('observe', {})).isError).toBeFalsy();
  }, 15_000);

  it('re-reads the top frame after a press without target', async () => {
    const id = await openAndObserve();
    relay.on('Input.dispatchKeyEvent', () => ({}));
    const snapshotsBefore = relay.callsTo('Runtime.evaluate').length;
    await call('act', {
      actions: [
        { op: 'press', key: 'Enter' },
        { op: 'click', target: id },
      ],
    });
    expect(relay.callsTo('Runtime.evaluate')).toHaveLength(snapshotsBefore + 1);
  });

  it('caps typed text at 10,000 characters', async () => {
    const id = await openAndObserve();
    const reply = await call('act', { actions: [{ op: 'type', target: id, text: 'x'.repeat(10_001) }] });
    expect(reply.isError).toBe(true);
    expect(inputRequests()).toEqual([]);
  });

  it('switches focus emulation on once per tab', async () => {
    const id = await openAndObserve();
    await call('act', { actions: [{ op: 'click', target: id }] });
    expect(relay.callsTo('Emulation.setFocusEmulationEnabled')).toEqual([{ enabled: true }]);
  });
});

describe('confirm gate', () => {
  type Reply = { result: { type: string; value?: unknown } };
  /**
   * What the in-page checks report: `label` for the resolve of an observed target; `enter` for ENTER_LABELS (one
   * report, or a function of the call number); `point` for POINT_LABELS.
   */
  const page = (
    label: string,
    enter: string[] | ((call: number, node: unknown) => unknown) = [],
    point: string[] | (() => unknown) = []
  ) => {
    let calls = 0;
    relay.on('Runtime.callFunctionOn', (params): Reply => {
      const fn = String(params.functionDeclaration);
      if (fn === ENTER_LABELS) {
        const node = (params.arguments as Array<{ value: unknown }>)[0].value;
        const value = typeof enter === 'function' ? enter(calls++, node) : focusReport(enter);
        return { result: { type: 'object', value } };
      }
      if (fn === POINT_LABELS) {
        return { result: { type: 'object', value: typeof point === 'function' ? point() : pointReport(point) } };
      }
      return fn.includes('elementFromPoint')
        ? { result: { type: 'object', value: { rect: { x: 10, y: 20, w: 80, h: 30 }, label, role: 'button' } } }
        : { result: { type: 'undefined' } };
    });
  };
  const answerWith = (allow: boolean) => relay.on('AionRelay.requestConfirm', () => ({ allow }));
  const asked = () => relay.callsTo('AionRelay.requestConfirm');
  const resolves = () =>
    relay.callsTo('Runtime.callFunctionOn').filter((p) => String(p.functionDeclaration).includes('elementFromPoint'));
  const results = async (actions: Array<Record<string, unknown>>) =>
    JSON.parse(textOf(await call('act', { actions }))) as {
      results: Array<{ result: string; reason?: string }>;
      stopped?: string;
    };
  const FRAME = { sessionId: 's1', frameId: 'F1' };

  beforeEach(() => {
    relay.on('Input.dispatchKeyEvent', () => ({}));
  });

  it('a risky click waits for the answer, asks with the observed label and frame, and re-checks the target after Allow', async () => {
    const id = await openAndObserve();
    page('Publish');
    const answer = Promise.withResolvers<{ allow: boolean }>();
    relay.on('AionRelay.requestConfirm', () => answer.promise);

    const acting = results([{ op: 'click', target: id }]);
    await vi.waitFor(() => expect(asked()).toHaveLength(1));
    expect(asked()[0]).toEqual({ webContentsId: 7, label: 'Publish', ...FRAME });
    expect(inputRequests()).toEqual([]);

    answer.resolve({ allow: true });
    expect((await acting).results).toEqual([{ op: 'click', target: id, result: 'done' }]);
    expect(inputRequests()).toHaveLength(3);
    expect(resolves()).toHaveLength(2);
  });

  it('Deny returns denied, performs no input, reports nothing and stops the batch', async () => {
    const id = await openAndObserve();
    page('Send message');
    answerWith(false);
    const reply = await results([
      { op: 'click', target: id },
      { op: 'click', target: id },
    ]);
    expect(reply.results).toMatchObject([{ op: 'click', target: id, result: 'denied' }]);
    expect(reply.stopped).toMatch(/denied/);
    expect(reply.stopped).toMatch(/1 more action not run/);
    expect(inputRequests()).toEqual([]);
    expect(relay.callsTo('AionRelay.reportAction')).toEqual([]);
  });

  it('fails closed when the relay cannot ask', async () => {
    const id = await openAndObserve();
    page('Delete');
    relay.on('AionRelay.requestConfirm', () => {
      throw new Error('relay gone');
    });
    expect((await results([{ op: 'click', target: id }])).results[0].result).toBe('denied');
    expect(inputRequests()).toEqual([]);
  });

  it('never asks for a click on a harmless control, or for hover, type or select', async () => {
    const id = await openAndObserve();
    page('Save draft');
    await results([{ op: 'click', target: id }]);
    page('Publish');
    await results([
      { op: 'hover', target: id },
      { op: 'type', target: id, text: 'x' },
    ]);
    expect(asked()).toEqual([]);
  });

  it('Enter on a target asks when the target or its form submit button is risky, and sends nothing on Deny', async () => {
    const id = await openAndObserve();
    answerWith(false);
    page('Search', ['Search', 'Pay now']);
    expect((await results([{ op: 'press', key: 'Enter', target: id }])).results[0].result).toBe('denied');
    expect(asked()[0]).toMatchObject({ label: 'Pay now' });
    page('Remove item', []);
    expect((await results([{ op: 'press', key: 'Escape', target: id }])).results[0].result).toBe('denied');
    expect(inputRequests()).toEqual([]);
  });

  it.each(['Enter', 'Space'])(
    '%s without a target asks about the focused control, and only for a risky one',
    async (key) => {
      await openAndObserve();
      page('Save', ['Delete account']);
      answerWith(false);
      expect((await results([{ op: 'press', key }])).results[0].result).toBe('denied');
      expect(asked()).toEqual([{ webContentsId: 7, label: 'Delete account', ...FRAME }]);
      expect(inputRequests()).toEqual([]);

      page('Save', ['Search']);
      expect((await results([{ op: 'press', key }])).results[0].result).toBe('done');
      page('Save', ['Delete account']);
      expect((await results([{ op: 'press', key: 'Tab' }])).results[0].result).toBe('done');
      expect(asked()).toHaveLength(1);
    }
  );

  it('tells the page which key is pressed, so a Space can skip the form submit', async () => {
    await openAndObserve();
    await results([{ op: 'press', key: 'Space' }]);
    const call = relay.requests.find((r) => r.params.functionDeclaration === ENTER_LABELS);
    expect(call?.params.arguments).toEqual([{ value: null }, { value: 'Space' }]);
  });

  it.each([
    [
      'fails',
      () => {
        throw new Error('Execution context was destroyed');
      },
    ],
    ['returns nothing usable', () => ({ labels: 'Delete', framed: false, focused: true })],
  ])('a focus check that %s ends the press as stale, with no input', async (_name, enter) => {
    await openAndObserve();
    page('Save', enter);
    const reply = await results([{ op: 'press', key: 'Enter' }]);
    expect(reply.results[0].result).toBe('stale');
    expect(inputRequests()).toEqual([]);
  });

  it('a focus check that never answers ends the press as stale', async () => {
    await openAndObserve();
    relay.on('Runtime.callFunctionOn', (params) =>
      params.functionDeclaration === ENTER_LABELS
        ? new Promise(() => {})
        : { result: { type: 'object', value: focusReport([]) } }
    );
    expect((await results([{ op: 'press', key: 'Enter' }])).results[0].result).toBe('stale');
    expect(inputRequests()).toEqual([]);
  }, 10_000);

  it('with the focus on an iframe no reported frame sees into, an untargeted press is stale', async () => {
    await openAndObserve();
    page('Save', () => focusReport([], true, true));
    const hidden = await results([{ op: 'press', key: 'Enter' }]);
    expect(hidden.results[0].result).toBe('stale');
    expect(inputRequests()).toEqual([]);
  });

  it('asks again about what the press would activate after Allow, and goes stale when it changed', async () => {
    await openAndObserve();
    answerWith(true);
    // The focus moves from a Delete button to a harmless one while the user decides.
    page('Save', (call) => focusReport([call === 0 ? 'Delete account' : 'Cancel']));
    const reply = await results([{ op: 'press', key: 'Space' }]);
    expect(reply.results[0].result).toBe('stale');
    expect(reply.results[0].reason).toMatch(/changed while/);
    expect(inputRequests()).toEqual([]);

    page('Save', () => focusReport(['Delete account']));
    expect((await results([{ op: 'press', key: 'Space' }])).results[0].result).toBe('done');
  });

  it('asks with a sanitized label, not the page text verbatim', async () => {
    const id = await openAndObserve();
    page(`Pay\u202e\n now ${'x'.repeat(300)}`);
    answerWith(true);
    await results([{ op: 'click', target: id }]);
    const { label } = asked()[0] as { label: string };
    expect(label.startsWith('Pay now ')).toBe(true);
    expect(label.length).toBeLessThanOrEqual(120);
  });

  it('a targeted Enter also reads the real focus, which a target that cancels mousedown leaves alone', async () => {
    const id = await openAndObserve();
    page('Bold', (_call, node) => focusReport(node === null ? ['Delete repo'] : ['Bold']));
    answerWith(false);
    expect((await results([{ op: 'press', key: 'Enter', target: id }])).results[0].result).toBe('denied');
    expect(asked()).toEqual([{ webContentsId: 7, label: 'Delete repo', ...FRAME }]);
    expect(inputRequests()).toEqual([]);
  });

  describe('drag', () => {
    const dragOnto = async () =>
      JSON.parse(textOf(await call('drag', { from: 'f0:3', to: 'f0:3', position: 'after' }))) as Record<string, string>;
    beforeEach(async () => {
      await openAndObserve();
      relay.on('Input.setInterceptDrags', () => ({}));
    });

    it('refuses a drag shorter than 4 px as a click, without input', async () => {
      const reply = JSON.parse(textOf(await call('drag', { from: 'f0:3', to: 'f0:3' }))) as Record<string, string>;
      expect(reply).toMatchObject({ result: 'error', reason: expect.stringMatching(/use act click/) });
      expect(inputRequests()).toEqual([]);
    });

    it('asks about a risky control under the release point, and sends nothing on Deny', async () => {
      page('Save', [], ['Publish']);
      answerWith(false);
      expect(await dragOnto()).toMatchObject({ result: 'denied' });
      expect(asked()).toEqual([{ webContentsId: 7, label: 'Publish', ...FRAME }]);
      expect(inputRequests()).toEqual([]);
      expect(relay.requests.some((r) => r.method === 'Input.setInterceptDrags')).toBe(false);
    });

    it('drags after Allow, and goes stale when the release point changed meanwhile', async () => {
      answerWith(true);
      page('Save', [], ['Publish']);
      expect(await dragOnto()).toEqual({ result: 'done' });
      let calls = 0;
      page('Save', [], () => pointReport(calls++ === 0 ? ['Publish'] : ['Cancel']));
      const before = inputRequests().length;
      expect(await dragOnto()).toMatchObject({ result: 'stale' });
      expect(inputRequests()).toHaveLength(before);
    });

    it('does not ask about a harmless release point', async () => {
      page('Save', [], ['Cancel']);
      expect(await dragOnto()).toEqual({ result: 'done' });
      expect(asked()).toEqual([]);
    });
  });

  describe('click_point', () => {
    const clickAt = async () => JSON.parse(textOf(await call('click_point', { x: 5, y: 6 }))) as Record<string, string>;
    beforeEach(async () => {
      await call('tabs', { action: 'open' });
    });

    it('asks about a risky control under the point, sends nothing on Deny, and clicks after Allow', async () => {
      page('Save', [], ['Delete account']);
      answerWith(false);
      expect(await clickAt()).toMatchObject({ result: 'denied' });
      expect(asked()).toEqual([{ webContentsId: 7, label: 'Delete account', ...FRAME }]);
      expect(inputRequests()).toEqual([]);
      expect(relay.callsTo('AionRelay.reportAction')).toEqual([]);

      answerWith(true);
      expect(await clickAt()).toEqual({ result: 'done' });
      expect(inputRequests()).toHaveLength(3);
    });

    it('goes stale when the point is on an iframe element no reported frame covers', async () => {
      page('Save', [], () => pointReport([], true));
      expect(await clickAt()).toMatchObject({ result: 'stale', reason: expect.stringMatching(/cannot see/) });
      expect(inputRequests()).toEqual([]);
    });

    it('probes the frame-local point, and does not ask about a harmless control', async () => {
      page('Save', [], ['Search']);
      expect(await clickAt()).toEqual({ result: 'done' });
      expect(asked()).toEqual([]);
      const probe = relay.requests.find((r) => r.params.functionDeclaration === POINT_LABELS);
      expect(probe?.params.arguments).toEqual([{ value: 5 }, { value: 6 }]);
    });

    it('goes stale, with no input, when the control under the point changed after Allow or the probe fails', async () => {
      answerWith(true);
      let calls = 0;
      page('Save', [], () => pointReport(calls++ === 0 ? ['Delete account'] : ['Cancel']));
      expect(await clickAt()).toMatchObject({ result: 'stale' });
      expect(inputRequests()).toEqual([]);

      page('Save', [], () => {
        throw new Error('Execution context was destroyed');
      });
      expect(await clickAt()).toMatchObject({ result: 'stale' });
      page('Save', [], () => ({ labels: 'not a list', framed: false }));
      expect(await clickAt()).toMatchObject({ result: 'stale' });
      expect(inputRequests()).toEqual([]);
    });
  });
});

describe('drag tool', () => {
  it('releases the mouse and switches interception off when a drop fails, and reports the first error', async () => {
    const id = await openAndObserve();
    relay.on('Input.setInterceptDrags', () => ({}));
    relay.on('Input.dispatchMouseEvent', (params, sessionId) => {
      if (params.buttons === 1)
        relay.emit('Input.dragIntercepted', { data: { items: [], dragOperationsMask: 1 } }, sessionId);
      if (params.type === 'mouseReleased') throw new Error('release failed too');
      return {};
    });
    relay.on('Input.dispatchDragEvent', () => {
      throw new Error('drop failed');
    });

    const reply = JSON.parse(textOf(await call('drag', { from: id, to: id, position: 'after' }))) as Record<
      string,
      unknown
    >;

    expect(reply).toEqual({ result: 'error', reason: 'drop failed' });
    const cleanup = relay.requests
      .filter((r) => r.method === 'Input.setInterceptDrags' || r.params.type === 'mouseReleased')
      .map((r) => `${r.method} ${String(r.params.type ?? r.params.enabled)}`);
    expect(cleanup).toEqual([
      'Input.setInterceptDrags true',
      'Input.dispatchMouseEvent mouseReleased',
      'Input.setInterceptDrags false',
    ]);
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
