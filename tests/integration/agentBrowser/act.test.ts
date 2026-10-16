import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  act,
  clickPoint,
  drag,
  screenshot,
  type ActionContext,
  type ReportedAction,
} from '@process/resources/builtinMcp/aionBrowser/actions';
import { observePage, type ActionRow, type Observation } from '@process/resources/builtinMcp/aionBrowser/actionSpace';
import { frameByKey, watchFrames } from '@process/resources/builtinMcp/aionBrowser/frames';
import { chromePath, launchTestChrome, type TestChrome } from './helpers/chrome';
import { startFixtureServers, type FixtureServers } from './helpers/fixtureServer';
import { observeUntil, rowsIn } from './helpers/observeUntil';

let chrome: TestChrome;
let servers: FixtureServers;

type EvaluateReply = { result: { value?: unknown } };

/** Runs `expression` in the page's main world of `sessionId` (a test's view of the page, not the agent's). */
const evaluate = async (sessionId: string, expression: string): Promise<unknown> =>
  (await chrome.conn.send<EvaluateReply>('Runtime.evaluate', { expression, returnByValue: true }, sessionId)).result
    .value;

/** An action context on `sessionId` that records what it reports. */
const contextFor = (sessionId: string): { ctx: ActionContext; reported: ReportedAction[] } => {
  const reported: ReportedAction[] = [];
  const report = async (action: ReportedAction): Promise<void> => {
    reported.push(action);
  };
  return { ctx: { conn: chrome.conn, sessionId, report }, reported };
};

/** The Input.* methods sent while `run` ran. */
const inputSentDuring = async (run: () => Promise<unknown>): Promise<string[]> => {
  const send = vi.spyOn(chrome.conn, 'send');
  try {
    await run();
    return send.mock.calls.map(([method]) => method).filter((method) => method.startsWith('Input.'));
  } finally {
    send.mockRestore();
  }
};

/** Width and height from a base64 JPEG's start-of-frame segment. */
const jpegSize = (base64: string): { width: number; height: number } | null => {
  const bytes = Buffer.from(base64, 'base64');
  for (let at = 2; at + 9 < bytes.length; at += 2 + bytes.readUInt16BE(at + 2)) {
    const marker = bytes[at + 1];
    if (marker >= 0xc0 && marker <= 0xc2)
      return { width: bytes.readUInt16BE(at + 7), height: bytes.readUInt16BE(at + 5) };
  }
  return null;
};

const row = (obs: Observation, label: string): ActionRow => {
  const found = obs.rows.find((r) => r.label === label);
  if (!found) throw new Error(`no row ${label}`);
  return found;
};

describe.skipIf(!chromePath)('act on real Chrome', () => {
  beforeAll(async () => {
    servers = await startFixtureServers();
    chrome = await launchTestChrome(chromePath as string);
    watchFrames(chrome.conn);
  });

  afterAll(async () => {
    await chrome?.close();
    await servers?.close();
  });

  it('clicks a button inside the OOPIF and types into its input (value verified via child session)', async () => {
    const session = await chrome.openPage(`${servers.originA}/builder-crossorigin.html`);
    const ready = (o: Observation) => rowsIn(o, servers.originB, 'Page title').length > 0;
    const first = await observeUntil(chrome.conn, session, ready);
    const child = frameByKey(chrome.conn, session, rowsIn(first, servers.originB, 'Publish')[0].frameKey)?.sessionId;
    if (!child) throw new Error('no OOPIF session');
    await evaluate(child, `document.getElementById('title').value = 'old'`);

    const obs = await observePage(chrome.conn, session);
    const [publish] = rowsIn(obs, servers.originB, 'Publish');
    const [title] = rowsIn(obs, servers.originB, 'Page title');
    const { ctx, reported } = contextFor(session);
    const { results, stopped } = await act(ctx, [
      { op: 'click', target: publish.id },
      { op: 'type', target: title.id, text: 'hello' },
    ]);

    expect(results.map((r) => r.result)).toEqual(['done', 'done']);
    expect(stopped).toBeUndefined();
    expect(await evaluate(child, 'window.clicks')).toBe(1);
    expect(await evaluate(child, `document.getElementById('title').value`)).toBe('hello');
    expect(reported.map((r) => r.op)).toEqual(['click', 'type']);
    // The OOPIF sits at (30, 20) and the button at (10, 20) inside it.
    expect(reported[0].rect).toEqual({ x: 40, y: 40, width: 80, height: 30 });
    expect(reported[0].label).toContain('Publish');
  });

  it('drags item A below item B in the HTML5 drag list (order verified)', async () => {
    const session = await chrome.openPage(`${servers.originA}/drag.html`);
    const obs = await observePage(chrome.conn, session);
    const { ctx, reported } = contextFor(session);

    const result = await drag(ctx, row(obs, 'Item 1').id, row(obs, 'Item 2').id, 'after');

    expect(result.result).toBe('done');
    expect(await evaluate(session, `[...document.querySelectorAll('li')].map((li) => li.id)`)).toEqual([
      'd2',
      'd1',
      'd3',
    ]);
    expect(await evaluate(session, 'window.dropLog')).toEqual(['d1->d2']);
    expect(reported.map((r) => r.op)).toEqual(['drag']);
  });

  it('a stale page (DOM replaced between observe and act) returns stale and performs no input', async () => {
    const session = await chrome.openPage(`${servers.originA}/child.html`);
    const obs = await observePage(chrome.conn, session);
    await evaluate(session, 'document.body.replaceWith(document.body.cloneNode(true))');
    const { ctx, reported } = contextFor(session);

    let outcome: Awaited<ReturnType<typeof act>> | undefined;
    const input = await inputSentDuring(async () => {
      outcome = await act(ctx, [
        { op: 'click', target: row(obs, 'Publish').id },
        { op: 'type', target: row(obs, 'Page title').id, text: 'x' },
      ]);
    });

    expect(input).toEqual([]);
    expect(outcome?.results).toEqual([
      { op: 'click', target: row(obs, 'Publish').id, result: 'stale', reason: expect.any(String) },
    ]);
    expect(outcome?.stopped).toMatch(/observe again/);
    expect(reported).toEqual([]);
  });

  it('a covered target returns stale (occluded) and performs no input', async () => {
    const session = await chrome.openPage(`${servers.originA}/child.html`);
    const obs = await observePage(chrome.conn, session);
    await evaluate(
      session,
      `document.body.append(Object.assign(document.createElement('div'), { style: 'position:fixed;inset:0;z-index:9' }))`
    );
    const { ctx } = contextFor(session);

    let outcome: Awaited<ReturnType<typeof act>> | undefined;
    const input = await inputSentDuring(async () => {
      outcome = await act(ctx, [{ op: 'click', target: row(obs, 'Publish').id }]);
    });

    expect(input).toEqual([]);
    expect(outcome?.results[0]).toMatchObject({ result: 'stale', reason: expect.stringMatching(/covered/) });
    expect(await evaluate(session, 'window.clicks')).toBe(0);
  });

  it('refuses a target its frame still shows but the top viewport does not', async () => {
    const session = await chrome.openPage(`${servers.originA}/builder-sameorigin.html`);
    const obs = await observeUntil(chrome.conn, session, (o) => rowsIn(o, 'GHL builder', 'Publish').length > 0);
    // The iframe starts at y 100 and Publish's center at y 35 inside it: 140 px up, that center is at y -5.
    await evaluate(session, 'scrollTo(0, 140)');
    const { ctx } = contextFor(session);

    let outcome: Awaited<ReturnType<typeof act>> | undefined;
    const input = await inputSentDuring(async () => {
      outcome = await act(ctx, [{ op: 'click', target: rowsIn(obs, 'GHL builder', 'Publish')[0].id }]);
    });

    expect(input).toEqual([]);
    expect(outcome?.results[0]).toMatchObject({ result: 'stale', reason: expect.stringMatching(/off-screen/) });
  });

  it('selects a native option by its observed label, presses keys and scrolls', async () => {
    const session = await chrome.openPage(`${servers.originA}/many.html`);
    const obs = await observePage(chrome.conn, session);
    const select = row(obs, 'Big list');
    const { ctx } = contextFor(session);

    const { results } = await act(ctx, [
      { op: 'select', target: select.id, text: select.options?.[1] },
      { op: 'scroll', key: 'down' },
    ]);

    expect(results.map((r) => r.result)).toEqual(['done', 'done']);
    expect(await evaluate(session, `document.getElementById('big').value`)).toBe('2');
    expect(await evaluate(session, 'scrollY')).toBeGreaterThan(0);

    const page = await chrome.openPage(`${servers.originA}/child.html`);
    const form = await observePage(chrome.conn, page);
    const typed = await act(contextFor(page).ctx, [
      { op: 'type', target: row(form, 'Page title').id, text: 'hello' },
      { op: 'press', key: 'Backspace' },
    ]);
    expect(typed.results.map((r) => r.result)).toEqual(['done', 'done']);
    expect(await evaluate(page, `document.getElementById('title').value`)).toBe('hell');
  });

  it('click_point clicks top-viewport CSS px and refuses points outside the viewport', async () => {
    const session = await chrome.openPage(`${servers.originA}/child.html`);
    const { ctx, reported } = contextFor(session);

    expect((await clickPoint(ctx, 50, 35)).result).toBe('done');
    expect(await evaluate(session, 'window.clicks')).toBe(1);
    expect(reported.map((r) => r.op)).toEqual(['click_point']);

    const input = await inputSentDuring(() => expect(clickPoint(ctx, 5000, 5)).rejects.toThrow(/viewport/));
    expect(input).toEqual([]);
  });

  it('screenshot returns a JPEG, clipped to a target when one is given', async () => {
    const session = await chrome.openPage(`${servers.originA}/child.html`);
    const obs = await observePage(chrome.conn, session);
    const { ctx } = contextFor(session);
    const send = vi.spyOn(chrome.conn, 'send');
    try {
      const full = await screenshot(ctx);
      const clipped = await screenshot(ctx, row(obs, 'Publish').id);
      expect(full.startsWith('/9j/')).toBe(true); // base64 of the JPEG SOI marker
      expect(clipped.length).toBeLessThan(full.length);
      const clips = send.mock.calls.filter(([method]) => method === 'Page.captureScreenshot').map(([, p]) => p);
      expect(clips[1]).toMatchObject({ format: 'jpeg', clip: { x: 10, y: 20, width: 80, height: 30 } });
    } finally {
      send.mockRestore();
    }
  });

  it('screenshot pixels are CSS px at device pixel ratio 2, so they match click_point', async () => {
    const session = await chrome.openPage(`${servers.originA}/child.html`);
    const metrics = { width: 800, height: 600, deviceScaleFactor: 2, mobile: false };
    await chrome.conn.send('Emulation.setDeviceMetricsOverride', metrics, session);
    const obs = await observePage(chrome.conn, session);
    const { ctx } = contextFor(session);

    expect(jpegSize(await screenshot(ctx))).toEqual({ width: 800, height: 600 });
    expect(jpegSize(await screenshot(ctx, row(obs, 'Publish').id))).toEqual({ width: 80, height: 30 });
  });
});
