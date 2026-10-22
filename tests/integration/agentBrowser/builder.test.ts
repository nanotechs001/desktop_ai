import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act, type ActionContext } from '@process/resources/builtinMcp/aionBrowser/actions';
import {
  formatObservation,
  observePage,
  type ActionRow,
  type Observation,
} from '@process/resources/builtinMcp/aionBrowser/actionSpace';
import { frameByKey, watchFrames } from '@process/resources/builtinMcp/aionBrowser/frames';
import { chromePath, launchTestChrome, type TestChrome } from './helpers/chrome';
import { startFixtureServers, type FixtureServers } from './helpers/fixtureServer';
import { observeUntil } from './helpers/observeUntil';

let chrome: TestChrome;
let servers: FixtureServers;

const BUILDER = 'funnel-builder';
const CANVAS = 'canvas';

type EvaluateReply = { result: { value?: unknown } };

const evaluate = async (sessionId: string, expression: string): Promise<unknown> =>
  (await chrome.conn.send<EvaluateReply>('Runtime.evaluate', { expression, returnByValue: true }, sessionId)).result
    .value;

const contextFor = (sessionId: string): ActionContext => ({
  conn: chrome.conn,
  sessionId,
  report: async () => undefined,
  confirm: async () => true,
});

const rowIn = (obs: Observation, frameLabel: string, label: string): ActionRow => {
  const found = obs.rows.find((r) => r.frameLabel === frameLabel && r.label === label);
  if (!found) throw new Error(`no row ${label} in ${frameLabel}:\n${formatObservation(obs, { text: false })}`);
  return found;
};

/** Opens the funnel builder (top page on A, builder on B, canvas inside the builder) once every frame lists. */
const openFunnel = async (): Promise<{ session: string; obs: Observation; builder: string; canvas: string }> => {
  const session = await chrome.openPage(`${servers.originA}/funnel.html?top`);
  const obs = await observeUntil(chrome.conn, session, (o) =>
    o.rows.some((r) => r.frameLabel === CANVAS && r.label === 'Footer note')
  );
  const sessionOf = (label: string) => {
    const key = obs.frames.find((f) => f.label === label)?.frameKey ?? '';
    return frameByKey(chrome.conn, session, key)?.sessionId ?? '';
  };
  return { session, obs, builder: sessionOf(BUILDER), canvas: sessionOf(CANVAS) };
};

/** Runs `expression` in the canvas document (an iframe of the builder, in the builder's session). */
const inCanvas = (builder: string, expression: string): Promise<unknown> =>
  evaluate(builder, `document.querySelector('iframe').contentWindow.eval(${JSON.stringify(expression)})`);

const rowsLabels = (obs: Observation, frameLabel: string): string[] =>
  obs.rows.filter((r) => r.frameLabel === frameLabel).map((r) => r.label);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe.skipIf(!chromePath)('observe and act in a funnel builder on real Chrome', () => {
  beforeAll(async () => {
    servers = await startFixtureServers();
    chrome = await launchTestChrome(chromePath as string);
    watchFrames(chrome.conn);
  });

  afterAll(async () => {
    await chrome?.close();
    await servers?.close();
  });

  it('names icon-only toolbar buttons from tooltips, ids and icon classes, never "button"', async () => {
    const { obs } = await openFunnel();
    const labels = obs.rows.filter((r) => r.frameLabel === BUILDER).map((r) => r.label);

    expect(labels).toEqual(
      expect.arrayContaining([
        'Desktop preview',
        'Undo',
        'Redo',
        'Page settings',
        'Add element',
        'Mobile preview',
        '(id: history)',
        '(icon: plus)',
        '(icon: content copy)',
        '(icon: layers)',
        '(icon: eye)',
        '(icon: code s slash)',
        '(icon: gear)',
        '(icon button 14 in toolbar)',
      ])
    );
    expect(obs.rows.filter((r) => r.label === r.role)).toEqual([]);
  });

  it('lists the canvas iframe inside the cross-origin builder and its clickable divs as controls', async () => {
    const { obs } = await openFunnel();

    expect(obs.frames.map((f) => f.label)).toEqual([servers.originA, BUILDER, CANVAS]);
    const canvas = obs.rows.filter((r) => r.frameLabel === CANVAS).map((r) => `${r.role} ${r.label}`);
    expect(canvas).toEqual(
      expect.arrayContaining([
        'section Hero',
        'element TEST',
        'element Welcome to TEST',
        'button Buy now',
        'section Footer note',
        'element Footer note',
      ])
    );
    // Rows and columns add nothing over their section; the button's wrapper is the button.
    expect(canvas.filter((line) => /^(row|column) /.test(line))).toEqual([]);
    expect(canvas).toHaveLength(6);
    // The canvas iframe sits at (0, 40) in the builder, itself at (0, 40) in the top page; the section has margin 8.
    expect(rowIn(obs, CANVAS, 'Hero').rect).toMatchObject({ x: 8, y: 88 });
    const headline = rowIn(obs, CANVAS, 'TEST');
    expect(formatObservation(obs)).toContain(`[${headline.id}] element "TEST" · in: "canvas"`);
  });

  it('acts on several controls in a row while the builder mutates on a timer', async () => {
    const { session, obs, builder } = await openFunnel();
    await sleep(200); // the autosave label and the hidden draft field have changed many times since observe
    const ctx = contextFor(session);

    const toolbar = await act(ctx, [
      { op: 'click', target: rowIn(obs, BUILDER, 'Undo').id },
      { op: 'click', target: rowIn(obs, BUILDER, 'Desktop preview').id },
    ]);
    expect(toolbar.results.map((r) => `${r.result} ${r.reason ?? ''}`.trim())).toEqual(['done', 'done']);
    expect(toolbar.stopped).toBeUndefined();

    const { results, stopped } = await act(ctx, [
      { op: 'click', target: rowIn(obs, BUILDER, 'Redo').id },
      { op: 'click', target: rowIn(obs, CANVAS, 'TEST').id },
      { op: 'click', target: rowIn(obs, CANVAS, 'Welcome to TEST').id },
    ]);

    expect(results.map((r) => `${r.result} ${r.reason ?? ''}`.trim())).toEqual(['done', 'done', 'done']);
    expect(stopped).toBeUndefined();
    expect(await evaluate(builder, 'window.clicks')).toEqual(['Undo', '?', 'Redo']);
    expect(await inCanvas(builder, 'window.selected')).toEqual(['headline', 'sub']);
  });

  it('re-finds a control whose node was replaced by an equivalent one, keeps its id, and refuses a different one', async () => {
    const { session, obs, builder } = await openFunnel();
    const headline = rowIn(obs, CANVAS, 'TEST');
    const replace = (html: string) =>
      inCanvas(builder, `document.querySelector('[data-element-id=headline]').outerHTML = ${JSON.stringify(html)}`);
    const ctx = contextFor(session);

    await replace('<div class="c-element" data-element-id="headline"><h1>TEST</h1></div>');
    expect((await act(ctx, [{ op: 'click', target: headline.id }])).results[0]).toMatchObject({ result: 'done' });
    expect(await inCanvas(builder, 'window.selected')).toEqual(['headline']);
    await replace('<div class="c-element" data-element-id="headline"><h1>TEST</h1></div>');
    expect(rowIn(await observePage(chrome.conn, session), CANVAS, 'TEST').id).toBe(headline.id);

    await replace('<div class="c-element" data-element-id="headline"><h1>Other</h1></div>');
    const changed = await act(ctx, [{ op: 'click', target: headline.id }]);
    expect(changed.results[0]).toMatchObject({ result: 'stale', reason: 'the target changed since observe' });
    expect(await inCanvas(builder, 'window.selected')).toEqual(['headline']);
  });

  it('stop_on_change stops when controls appear next to the target, not for timer text elsewhere', async () => {
    const { session, obs, builder } = await openFunnel();
    await inCanvas(
      builder,
      `document.querySelector('[data-element-id=note]').addEventListener('click', (e) =>
        e.currentTarget.insertAdjacentHTML('afterend', '<button type="button">Duplicate</button>'))`
    );
    const ctx = contextFor(session);

    const { results, stopped } = await act(ctx, [
      { op: 'click', target: rowIn(obs, CANVAS, 'TEST').id },
      { op: 'click', target: rowIn(obs, CANVAS, 'Footer note').id },
      { op: 'click', target: rowIn(obs, BUILDER, 'Undo').id },
    ]);

    expect(results.map((r) => r.result)).toEqual(['done', 'done']);
    expect(stopped).toBe('The page changed; observe again. 1 more action not run.');
  });

  it("act lists what its click changed: the dialog it opened, the target's new state and the new controls, with ids act can use", async () => {
    const { session, obs, builder } = await openFunnel();
    const ctx = contextFor(session);

    const opened = await act(ctx, [{ op: 'click', target: rowIn(obs, BUILDER, 'Page settings').id }]);

    expect(opened.results[0]).toMatchObject({ result: 'done' });
    expect(opened.changes).toMatchObject({ opened: 'dialog "Page settings"', target: 'expanded=true' });
    const apply = opened.changes?.added?.find((line) => line.includes('button "Apply"')) ?? '';
    expect(apply).toMatch(/^\[f\d+:\d+\] button "Apply" · in: "funnel-builder"$/);
    expect(opened.changes?.added).toHaveLength(2);
    // The new id works without another observe.
    const id = /^\[(f\d+:\d+)\]/.exec(apply)?.[1] ?? '';
    expect((await act(ctx, [{ op: 'click', target: id }])).results[0]).toMatchObject({ result: 'done' });
    expect(await evaluate(builder, 'window.clicks')).toEqual(['settings', '?']);
  });

  it('act says "No visible change" when only timer text changed, and a lot changed when the frame navigates', async () => {
    const { session, obs } = await openFunnel();
    const ctx = contextFor(session);

    const undo = await act(ctx, [{ op: 'click', target: rowIn(obs, BUILDER, 'Undo').id }]);
    expect(undo.changes).toEqual({ note: 'No visible change' });

    const link = await act(ctx, [{ op: 'click', target: rowIn(obs, BUILDER, 'Open canvas').id }]);
    expect(link.results[0]).toMatchObject({ result: 'done' });
    expect(link.changes?.navigated).toMatch(/\/funnel-canvas\.html$/);
    expect(link.changes?.note).toBe('Page changed a lot; observe for the full view.');
  });

  it('an id that a scroll took out of view is off-screen, not unknown, and works again once scrolled back', async () => {
    const { session, obs, builder } = await openFunnel();
    const ctx = contextFor(session);
    const headline = rowIn(obs, BUILDER, 'Headline');

    const down = await act(ctx, [{ op: 'scroll', key: 'down', target: rowIn(obs, BUILDER, 'Paragraph').id }]);
    expect(down.results[0]).toMatchObject({ result: 'done' });
    // The scroll lists what came into view, so no observe is needed to act on it.
    expect(down.changes?.added?.some((line) => line.includes('clickable "Widget 29"'))).toBe(true);
    const after = await observePage(chrome.conn, session);
    expect(after.rows.map((r) => r.id)).not.toContain(headline.id);

    const hidden = await act(ctx, [{ op: 'click', target: headline.id }]);
    expect(hidden.results[0]).toMatchObject({ result: 'stale', reason: expect.stringContaining('off-screen') });

    const up = await act(ctx, [{ op: 'scroll', key: 'up', target: rowIn(after, BUILDER, 'Widget 29').id }]);
    expect(up.changes?.added?.some((line) => line.startsWith(`[${headline.id}] clickable "Headline"`))).toBe(true);
    expect((await act(ctx, [{ op: 'click', target: headline.id }])).results[0]).toMatchObject({ result: 'done' });
    expect(await evaluate(builder, 'window.clicks')).toEqual(['Headline']);
  });

  it('scrolls the list a covered item sits in, without a hit test', async () => {
    const { session, obs, builder } = await openFunnel();
    const ctx = contextFor(session);
    // #cover lies over these items (y 400 to 460 in the builder).
    const covered = obs.rows.find((r) => r.frameLabel === BUILDER && r.label === 'Widget 12');
    expect(covered).toBeDefined();
    expect((await act(ctx, [{ op: 'click', target: covered?.id ?? '' }])).results[0]).toMatchObject({
      result: 'stale',
      reason: 'the target is covered by another element',
    });

    const scrolled = await act(ctx, [{ op: 'scroll', key: 'down', target: covered?.id ?? '' }]);

    expect(scrolled.results[0]).toMatchObject({ result: 'done' });
    expect(await evaluate(builder, "document.getElementById('elements').scrollTop")).toBeGreaterThan(0);
    expect(await evaluate(builder, 'scrollY')).toBe(0);
  });

  it('observe waits for a frame that fills in its controls after 1 s, then returns them in one call', async () => {
    const session = await chrome.openPage(`${servers.originA}/funnel.html?lazy`);
    const started = Date.now();

    const obs = await observePage(chrome.conn, session);

    expect(rowsLabels(obs, 'lazy-builder')).toEqual(['Add section', 'Add row']);
    expect(Date.now() - started).toBeLessThan(4000);
    expect(formatObservation(obs)).not.toContain('Still loading');
  });
});
