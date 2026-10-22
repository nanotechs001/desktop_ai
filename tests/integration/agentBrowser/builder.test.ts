import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
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

const contextFor = (sessionId: string, confirm: ActionContext['confirm'] = async () => true): ActionContext => ({
  conn: chrome.conn,
  sessionId,
  report: async () => undefined,
  confirm,
});

/** Moves the test's pointer to top-viewport (x, y), as the user's own mouse would. */
const pointerTo = (sessionId: string, x: number, y: number): Promise<unknown> =>
  chrome.conn.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }, sessionId);

const centerOf = (r: ActionRow['rect']): [number, number] => [r.x + r.w / 2, r.y + r.h / 2];

/** The Input.* calls (method and type) sent while `run` ran. */
const inputDuring = async (run: () => Promise<unknown>): Promise<string[]> => {
  const send = vi.spyOn(chrome.conn, 'send');
  try {
    await run();
    return send.mock.calls
      .filter(([method]) => method.startsWith('Input.'))
      .map(([method, params]) => `${method} ${String((params as { type?: string } | undefined)?.type ?? '')}`);
  } finally {
    send.mockRestore();
  }
};

const rowIn = (obs: Observation, frameLabel: string, label: string): ActionRow => {
  const found = obs.rows.find((r) => r.frameLabel === frameLabel && r.label === label);
  if (!found) throw new Error(`no row ${label} in ${frameLabel}:\n${formatObservation(obs, { text: false })}`);
  return found;
};

/**
 * Waits until the frame of `sessionId` has seen itself on screen: headless Chrome routes input to a just-loaded OOPIF
 * only once its parent has embedded it (see act.test.ts), and drops a click sent earlier.
 */
const untilEmbedded = (sessionId: string): Promise<unknown> =>
  chrome.conn.send(
    'Runtime.evaluate',
    {
      expression: `new Promise((resolve) => new IntersectionObserver((entries, observer) => {
        if (entries[0].isIntersecting) { observer.disconnect(); requestAnimationFrame(() => requestAnimationFrame(resolve)); }
      }).observe(document.body))`,
      awaitPromise: true,
    },
    sessionId
  );

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
  await untilEmbedded(sessionOf(BUILDER));
  return { session, obs, builder: sessionOf(BUILDER), canvas: sessionOf(CANVAS) };
};

/** Runs `expression` in the canvas document (an iframe of the builder, in the builder's session). */
const inCanvas = (builder: string, expression: string): Promise<unknown> =>
  evaluate(builder, `document.querySelector('iframe').contentWindow.eval(${JSON.stringify(expression)})`);

const rowsLabels = (obs: Observation, frameLabel: string): string[] =>
  obs.rows.filter((r) => r.frameLabel === frameLabel).map((r) => r.label);

/** Opens the GoHighLevel-shaped canvas (funnel-canvas.html?ghl in a cross-origin "funnel-builder" iframe). */
const openGhl = async (): Promise<{ session: string; obs: Observation; canvas: string }> => {
  const session = await chrome.openPage(`${servers.originA}/funnel.html?ghl`);
  const obs = await observeUntil(chrome.conn, session, (o) => o.rows.some((r) => r.frameLabel === BUILDER));
  const key = obs.frames.find((f) => f.label === BUILDER)?.frameKey ?? '';
  const canvas = frameByKey(chrome.conn, session, key)?.sessionId ?? '';
  await untilEmbedded(canvas);
  return { session, obs, canvas };
};

const GHL_TOOLBAR = ['Move Up', 'Move Down', 'Open Settings', 'Save Element', 'Drag', 'Clone', 'Delete'];
const IMAGE_3 = 'image 3 · column 3 · row 1 · section 1 · Our team';

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

  // A VA bot clicked WPBakery's page under its open Add Element panel again and again: "covered by another element"
  // never said what to close. The reason now names a dialog or panel that covers the target.
  it('names the dialog that covers a target, in its own frame and over the frame it sits in', async () => {
    const { session, obs, builder } = await openFunnel();
    const ctx = contextFor(session);
    const footer = rowIn(obs, CANVAS, 'Footer note');
    const box = (await inCanvas(
      builder,
      `(() => { const e = [...document.querySelectorAll('*')].find((x) => !x.children.length && x.textContent.trim() === 'Footer note');
        const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`
    )) as { x: number; y: number; w: number; h: number };
    // The canvas iframe sits at (0, 40) in the builder: put the builder's dialog over the footer.
    await evaluate(
      builder,
      `Object.assign(document.getElementById('settings-dialog'), { hidden: false }).setAttribute('style',
        'position:absolute;z-index:5;background:#fff;left:${box.x - 10}px;top:${box.y + 30}px;width:${box.w + 20}px;height:${box.h + 20}px')`
    );
    expect((await act(ctx, [{ op: 'click', target: footer.id }])).results[0]).toMatchObject({
      result: 'stale',
      reason: 'the target is covered by the dialog "Page settings"; close or move it first',
    });

    const widget = rowIn(obs, BUILDER, 'Widget 12');
    await evaluate(
      builder,
      `(() => { const c = document.getElementById('cover'); c.setAttribute('role', 'dialog'); c.setAttribute('aria-label', 'Add Element'); })()`
    );
    expect((await act(ctx, [{ op: 'click', target: widget.id }])).results[0]).toMatchObject({
      result: 'stale',
      reason: 'the target is covered by the dialog "Add Element"; close or move it first',
    });
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
  it('lists every GoHighLevel section, row, column and element by type and place, once each', async () => {
    const { obs } = await openGhl();

    expect(obs.rows.filter((r) => r.frameLabel === BUILDER).map((r) => `${r.role} ${r.label}`)).toEqual([
      'section section 1',
      'row row 1 · section 1',
      'column column 1 · row 1 · section 1',
      'image image 1 · column 1 · row 1 · section 1',
      'column column 2 · row 1 · section 1',
      'image image 1 · column 2 · row 1 · section 1',
      'column column 3 · row 1 · section 1',
      'image image 1 · column 3 · row 1 · section 1',
      'image image 2 · column 3 · row 1 · section 1',
      `image ${IMAGE_3}`,
      'section section 2',
      'row row 1 · section 2',
      'column column 1 · row 1 · section 2',
      'headline headline 1 · column 1 · row 1 · section 2 · Our story',
      'button button 1 · column 1 · row 1 · section 2 · Buy now',
    ]);
    const image = rowIn(obs, BUILDER, IMAGE_3);
    expect(formatObservation(obs)).toContain(`[${image.id}] image "${IMAGE_3}" · in: "funnel-builder"`);
  });

  it('selects a GoHighLevel image by its id, marks it selected with its toolbar, and deletes it from there', async () => {
    const { session, obs, canvas } = await openGhl();
    const ctx = contextFor(session);
    const image = rowIn(obs, BUILDER, IMAGE_3);

    expect((await act(ctx, [{ op: 'click', target: image.id }])).results[0]).toMatchObject({ result: 'done' });
    const selected = await observePage(chrome.conn, session);
    expect(rowIn(selected, BUILDER, `${IMAGE_3} (selected)`).id).toBe(image.id);
    const toolbar = selected.rows.filter((r) => r.frameLabel === BUILDER && r.role === 'element');
    expect(toolbar.map((r) => r.label)).toEqual(GHL_TOOLBAR);

    const deleted = await act(ctx, [{ op: 'click', target: rowIn(selected, BUILDER, 'Delete').id }]);
    expect(deleted.results[0]).toMatchObject({ result: 'done' });
    expect(await evaluate(canvas, 'window.ghl')).toEqual(['select image-i5', 'delete image-i5']);
    const after = rowsLabels(await observePage(chrome.conn, session), BUILDER);
    expect(after.filter((label) => label.endsWith('· column 3 · row 1 · section 1'))).toHaveLength(2);
    expect(after.some((label) => label.startsWith('image 3 '))).toBe(false);
  });

  it('clicks a GoHighLevel column on its own area, not on an element inside it', async () => {
    const { session, obs, canvas } = await openGhl();

    const ctx = contextFor(session);

    const column = await act(ctx, [{ op: 'click', target: rowIn(obs, BUILDER, 'column 3 · row 1 · section 1').id }]);
    const section = await act(ctx, [{ op: 'click', target: rowIn(obs, BUILDER, 'section 2').id }]);

    expect([column, section].map((a) => a.results[0]?.result)).toEqual(['done', 'done']);
    expect(await evaluate(canvas, 'window.ghl')).toEqual(['select col-Fv3', 'select section-rK2']);
  });

  /** Selects image 3 and observes while the pointer is on it: its hover-only toolbar is listed. */
  const selectImage3 = async () => {
    const { session, obs, canvas } = await openGhl();
    const image = rowIn(obs, BUILDER, IMAGE_3);
    expect((await act(contextFor(session), [{ op: 'click', target: image.id }])).results[0]).toMatchObject({
      result: 'done',
    });
    const selected = await observePage(chrome.conn, session);
    const away = centerOf(rowIn(selected, BUILDER, 'headline 1 · column 1 · row 1 · section 2 · Our story').rect);
    return { session, canvas, image, selected, away, del: rowIn(selected, BUILDER, 'Delete') };
  };

  it("clicks a hover-only toolbar icon after the pointer left its item, hovering the item's own area first", async () => {
    const { session, canvas, image, away, del } = await selectImage3();
    await pointerTo(session, ...away);
    expect(rowsLabels(await observePage(chrome.conn, session), BUILDER)).not.toContain('Delete');

    const started = Date.now();
    const input = await inputDuring(async () => {
      const deleted = await act(contextFor(session), [{ op: 'click', target: del.id }]);
      expect(deleted.results[0]).toMatchObject({ result: 'done' });
    });

    expect(Date.now() - started).toBeLessThan(1500);
    expect(await evaluate(canvas, 'window.ghl')).toEqual(['select image-i5', 'delete image-i5']);
    // A hover of the item, then the click (whose own move goes to the icon from inside the item).
    expect(input).toEqual([
      'Input.dispatchMouseEvent mouseMoved',
      'Input.dispatchMouseEvent mouseMoved',
      'Input.dispatchMouseEvent mousePressed',
      'Input.dispatchMouseEvent mouseReleased',
    ]);
    expect(image.id).not.toBe(del.id);
  });

  it('runs [click image, click Delete] in one act when the Delete id came from an earlier observe', async () => {
    const { session, canvas, image, away, del } = await selectImage3();
    await pointerTo(session, ...away);
    // Observe while the toolbar is hidden: the agent's latest view has no Delete, its id is still known.
    await observePage(chrome.conn, session);

    const { results, stopped } = await act(contextFor(session), [
      { op: 'click', target: image.id },
      { op: 'click', target: del.id },
    ]);

    expect(results.map((r) => `${r.result} ${r.reason ?? ''}`.trim())).toEqual(['done', 'done']);
    expect(stopped).toBeUndefined();
    expect(await evaluate(canvas, 'window.ghl')).toEqual(['select image-i5', 'select image-i5', 'delete image-i5']);
  });

  it('still asks before the hover-revealed Delete, and Deny deletes nothing', async () => {
    const { session, canvas, away, del } = await selectImage3();
    await pointerTo(session, ...away);
    const asked: string[] = [];

    const denied = await act(
      contextFor(session, async (label) => {
        asked.push(label);
        return false;
      }),
      [{ op: 'click', target: del.id }]
    );

    expect(denied.results[0]).toMatchObject({ result: 'denied' });
    expect(asked).toEqual(['Delete']);
    expect(await evaluate(canvas, 'window.ghl')).toEqual(['select image-i5']);
  });

  it('clicks Delete after a single Allow even though the pointer left the item while the user was asked', async () => {
    const { session, canvas, away, del } = await selectImage3();
    // The user's mouse crosses the canvas on its way to the app's Allow button.
    const allowOnce: ActionContext['confirm'] = async () => {
      await pointerTo(session, ...away);
      await pointerTo(session, 5, 5);
      return true;
    };

    const deleted = await act(contextFor(session, allowOnce), [{ op: 'click', target: del.id }]);

    expect(deleted.results[0]).toMatchObject({ result: 'done' });
    expect(await evaluate(canvas, 'window.ghl')).toEqual(['select image-i5', 'delete image-i5']);
  });

  it('refuses the click after Allow when the control at the id became a different one, and says so', async () => {
    const { session, canvas, del } = await selectImage3();
    const relabel = async () => {
      await evaluate(canvas, `document.querySelector('[title="Delete"]').title = 'Archive'`);
      return true;
    };

    const changed = await act(contextFor(session, relabel), [{ op: 'click', target: del.id }]);

    expect(changed.results[0]).toMatchObject({
      result: 'stale',
      reason: expect.stringContaining('the user allowed it, but the control changed'),
    });
    expect(await evaluate(canvas, 'window.ghl')).toEqual(['select image-i5']);
  });

  it('a hidden control outside any builder item stays stale, with no hover', async () => {
    const { session, obs, builder } = await openFunnel();
    const undo = rowIn(obs, BUILDER, 'Undo');
    await evaluate(builder, `document.querySelector('[title="Undo"]').style.visibility = 'hidden'`);

    const input = await inputDuring(async () => {
      const hidden = await act(contextFor(session), [{ op: 'click', target: undo.id }]);
      expect(hidden.results[0]).toMatchObject({ result: 'stale', reason: 'the target changed since observe' });
    });

    expect(input).toEqual([]);
    expect(await evaluate(builder, 'window.clicks')).toEqual([]);
  });
});
