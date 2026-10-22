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
const contextFor = (
  sessionId: string,
  confirm: ActionContext['confirm'] = async () => true
): { ctx: ActionContext; reported: ReportedAction[] } => {
  const reported: ReportedAction[] = [];
  const report = async (action: ReportedAction): Promise<void> => {
    reported.push(action);
  };
  return { ctx: { conn: chrome.conn, sessionId, report, confirm }, reported };
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

  it('asks before Enter submits a risky form or activates a risky focused control, and Deny sends no input', async () => {
    const session = await chrome.openPage(`${servers.originA}/confirm.html`);
    const obs = await observePage(chrome.conn, session);
    const asked: string[] = [];
    const ask = (allow: boolean) => async (label: string) => {
      asked.push(label);
      return allow;
    };

    // Enter in a text field submits its form, whose button says Send.
    const denied = await act(contextFor(session, ask(false)).ctx, [
      { op: 'press', key: 'Enter', target: row(obs, 'To').id },
    ]);
    expect(denied.results[0].result).toBe('denied');
    expect(await evaluate(session, 'window.submits')).toEqual([]);
    const allowed = await act(contextFor(session, ask(true)).ctx, [
      { op: 'press', key: 'Enter', target: row(obs, 'To').id },
    ]);
    expect(allowed.results[0].result).toBe('done');
    expect(await evaluate(session, 'window.submits')).toEqual(['mail']);
    expect(asked).toEqual(['Send message', 'Send message']);

    // A harmless form is not asked about (once nothing risky keeps the focus: a targeted key reads it too).
    await evaluate(session, 'document.activeElement.blur()');
    await act(contextFor(session, ask(false)).ctx, [{ op: 'press', key: 'Enter', target: row(obs, 'Query').id }]);
    expect(await evaluate(session, 'window.submits')).toEqual(['mail', 'find']);
    expect(asked).toHaveLength(2);

    // Enter with no target goes to the focused control.
    await evaluate(session, `document.getElementById('del').focus()`);
    const input = await inputSentDuring(() =>
      act(contextFor(session, ask(false)).ctx, [{ op: 'press', key: 'Enter' }])
    );
    expect(input).toEqual([]);
    expect(asked.at(-1)).toBe('Delete account');
    expect(await evaluate(session, 'window.deleted')).toBe(0);
    await act(contextFor(session, ask(true)).ctx, [{ op: 'press', key: 'Enter' }]);
    expect(await evaluate(session, 'window.deleted')).toBe(1);
  });

  it('gates Space on a Tab-focused risky button, and not Space typed into a text field', async () => {
    const session = await chrome.openPage(`${servers.originA}/confirm.html`);
    const obs = await observePage(chrome.conn, session);
    const asked: string[] = [];
    const ask = (allow: boolean) => async (label: string) => {
      asked.push(label);
      return allow;
    };
    // To, Send message, Query, Search, Delete account.
    const tabs = Array.from({ length: 5 }, () => ({ op: 'press' as const, key: 'Tab' }));
    await act(contextFor(session, ask(false)).ctx, tabs, { stopOnChange: false });
    expect(await evaluate(session, 'document.activeElement.id')).toBe('del');

    const input = await inputSentDuring(() =>
      act(contextFor(session, ask(false)).ctx, [{ op: 'press', key: 'Space' }])
    );
    expect(input).toEqual([]);
    expect(asked).toEqual(['Delete account']);
    expect(await evaluate(session, 'window.deleted')).toBe(0);
    await act(contextFor(session, ask(true)).ctx, [{ op: 'press', key: 'Space' }]);
    expect(await evaluate(session, 'window.deleted')).toBe(1);

    // A space typed into a text field activates nothing, so it is not asked about.
    await evaluate(session, 'document.activeElement.blur()');
    const typed = await act(contextFor(session, ask(false)).ctx, [
      { op: 'press', key: 'Space', target: row(obs, 'To').id },
    ]);
    expect(typed.results[0].result).toBe('done');
    expect(asked).toHaveLength(2);
  });

  it('asks for a composer labelled Send and for a dialog-footer submit button outside its form', async () => {
    const session = await chrome.openPage(`${servers.originA}/confirm.html`);
    const obs = await observePage(chrome.conn, session);
    const asked: string[] = [];
    const ctx = contextFor(session, async (label) => {
      asked.push(label);
      return false;
    }).ctx;
    await act(ctx, [{ op: 'press', key: 'Enter', target: row(obs, 'Send a message').id }]);
    await act(ctx, [{ op: 'press', key: 'Enter', target: row(obs, 'Dialog title').id }]);
    expect(asked).toEqual(['Send a message', 'Publish']);
    expect(await evaluate(session, 'window.submits')).toEqual([]);
  });

  it('presses Enter with the focus inside a cross-origin frame, asking about that frame and not going stale', async () => {
    const session = await chrome.openPage(`${servers.originA}/builder-crossorigin.html`);
    const ready = (o: Observation) => rowsIn(o, servers.originB, 'Page title').length > 0;
    const first = await observeUntil(chrome.conn, session, ready);
    const child = frameByKey(chrome.conn, session, rowsIn(first, servers.originB, 'Page title')[0].frameKey);
    if (!child) throw new Error('no OOPIF frame');
    await evaluate(child.sessionId, `document.getElementById('publish').focus()`);
    const asked: Array<{ label: string; frameId: string }> = [];
    const { ctx } = contextFor(session, async (label, frame) => {
      asked.push({ label, frameId: frame.frameId });
      return false;
    });
    const { results } = await act(ctx, [{ op: 'press', key: 'Enter' }]);
    expect(results[0].result).toBe('denied');
    expect(asked).toEqual([{ label: 'Publish', frameId: child.frameId }]);
    expect(await evaluate(child.sessionId, 'window.clicks')).toBe(0);
  });

  it('gates click_point on a risky control, in the top page and inside a cross-origin frame', async () => {
    const top = await chrome.openPage(`${servers.originA}/confirm.html`);
    const obs = await observePage(chrome.conn, top);
    const del = row(obs, 'Delete account').rect;
    const asked: string[] = [];
    const deny = async (label: string) => {
      asked.push(label);
      return false;
    };
    const centre = { x: del.x + del.w / 2, y: del.y + del.h / 2 };
    expect(await clickPoint(contextFor(top, deny).ctx, centre.x, centre.y)).toMatchObject({ result: 'denied' });
    expect(asked).toEqual(['Delete account']);
    expect(await evaluate(top, 'window.deleted')).toBe(0);
    const harmless = row(obs, 'Search').rect;
    expect(await clickPoint(contextFor(top, deny).ctx, harmless.x + 2, harmless.y + 2)).toEqual({ result: 'done' });
    expect(asked).toHaveLength(1);
    expect(await clickPoint(contextFor(top).ctx, centre.x, centre.y)).toEqual({ result: 'done' });
    expect(await evaluate(top, 'window.deleted')).toBe(1);

    const session = await chrome.openPage(`${servers.originA}/builder-crossorigin.html`);
    const ready = (o: Observation) => rowsIn(o, servers.originB, 'Publish').length > 0;
    const framed = await observeUntil(chrome.conn, session, ready);
    const [publish] = rowsIn(framed, servers.originB, 'Publish');
    const child = frameByKey(chrome.conn, session, publish.frameKey);
    if (!child) throw new Error('no OOPIF frame');
    const inFrame: Array<{ label: string; frameId: string }> = [];
    const denyFrame = contextFor(session, async (label, frame) => {
      inFrame.push({ label, frameId: frame.frameId });
      return false;
    });
    // The OOPIF sits at (30, 20) and the button at (10, 20) inside it, 80 by 30.
    expect(await clickPoint(denyFrame.ctx, 80, 55)).toMatchObject({ result: 'denied' });
    expect(inFrame).toContainEqual({ label: 'Publish', frameId: child.frameId });
    expect(await evaluate(child.sessionId, 'window.clicks')).toBe(0);
  });

  it('click_point asks about a div with a click handler and about a label for a risky control', async () => {
    const session = await chrome.openPage(`${servers.originA}/confirm.html`);
    const centreOf = async (id: string) => {
      const rect = (await evaluate(
        session,
        `(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`
      )) as [number, number];
      return { x: rect[0], y: rect[1] };
    };
    const asked: string[] = [];
    const deny = async (label: string) => {
      asked.push(label);
      return false;
    };
    const div = await centreOf('divdel');
    expect(await clickPoint(contextFor(session, deny).ctx, div.x, div.y)).toMatchObject({ result: 'denied' });
    expect(await evaluate(session, 'window.divDeleted')).toBe(0);
    const label = await centreOf('unsub');
    const labelAt = (await evaluate(
      session,
      `(() => { const r = document.querySelector('label[for=unsub]').getBoundingClientRect(); return [r.x + 2, r.y + 2]; })()`
    )) as [number, number];
    expect(label.x).toBeGreaterThan(0);
    expect(await clickPoint(contextFor(session, deny).ctx, labelAt[0], labelAt[1])).toMatchObject({ result: 'denied' });
    expect(await evaluate(session, 'document.getElementById("unsub").checked')).toBe(false);
    expect(asked.map((l) => l.trim())).toEqual(['Delete', 'Unsubscribe']);

    // Allowed, the click goes through.
    expect(await clickPoint(contextFor(session).ctx, div.x, div.y)).toEqual({ result: 'done' });
    expect(await evaluate(session, 'window.divDeleted')).toBe(1);
  });

  it('gates a drag that releases on a risky control, even from a handle inside it, and refuses click-sized drags', async () => {
    const session = await chrome.openPage(`${servers.originA}/confirm.html`);
    const obs = await observePage(chrome.conn, session);
    const asked: string[] = [];
    const deny = contextFor(session, async (label) => {
      asked.push(label);
      return false;
    });
    const input = await inputSentDuring(async () => {
      // Onto a Delete button.
      expect((await drag(deny.ctx, row(obs, 'Card').id, row(obs, 'Delete account').id)).result).toBe('denied');
      // From the draggable handle inside the Publish draft button onto the button itself.
      const handle = obs.rows.find((r) => r.label === 'Publish draft' && r.role === 'draggable');
      const button = obs.rows.find((r) => r.label === 'Publish draft' && r.role === 'button');
      if (!handle || !button) throw new Error('no publish rows');
      expect((await drag(deny.ctx, handle.id, button.id, 'after')).result).toBe('denied');
    });
    expect(input).toEqual([]);
    expect(asked).toEqual(['Delete account', 'Publish draft']);
    expect(await evaluate(session, 'window.pubClicks')).toBe(0);
    expect(await evaluate(session, 'window.deleted')).toBe(0);

    // A drag that ends where it began is a click: refused whatever the control says.
    const click = await drag(contextFor(session).ctx, row(obs, 'Card').id, row(obs, 'Card').id);
    expect(click).toMatchObject({ result: 'error', reason: expect.stringContaining('use act click') });
  });

  it('presses Enter on a target that cancels mousedown: the key goes to the control that still has focus', async () => {
    const session = await chrome.openPage(`${servers.originA}/confirm.html`);
    const obs = await observePage(chrome.conn, session);
    await evaluate(session, `document.getElementById('del').focus()`);
    const asked: string[] = [];
    const ctx = contextFor(session, async (label) => {
      asked.push(label);
      return false;
    }).ctx;
    const input = await inputSentDuring(() => act(ctx, [{ op: 'press', key: 'Enter', target: row(obs, 'Bold').id }]));
    expect(input).toEqual([]);
    expect(asked).toEqual(['Delete account']);
    expect(await evaluate(session, 'window.deleted')).toBe(0);
  });

  it('asks for an image submit button that names its form with form=id from outside it', async () => {
    const session = await chrome.openPage(`${servers.originA}/confirm.html`);
    const obs = await observePage(chrome.conn, session);
    const asked: string[] = [];
    const ctx = contextFor(session, async (label) => {
      asked.push(label);
      return false;
    }).ctx;
    await act(ctx, [{ op: 'press', key: 'Enter', target: row(obs, 'Image query').id }]);
    expect(asked).toEqual(['Purchase']);
    expect(await evaluate(session, 'window.submits')).toEqual([]);
  });

  it('click_point on an icon inside a risky pointer-cursor button or link asks about the control', async () => {
    const session = await chrome.openPage(`${servers.originA}/confirm.html`);
    const centreOf = async (id: string) => {
      const [x, y] = (await evaluate(
        session,
        `(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return [r.x + r.width / 2, r.y + r.height / 2]; })()`
      )) as [number, number];
      return { x, y };
    };
    const asked: string[] = [];
    const deny = contextFor(session, async (label) => {
      asked.push(label.trim());
      return false;
    }).ctx;
    const icon = await centreOf('ico');
    expect(await clickPoint(deny, icon.x, icon.y)).toMatchObject({ result: 'denied' });
    const cart = await centreOf('cart');
    expect(await clickPoint(deny, cart.x, cart.y)).toMatchObject({ result: 'denied' });
    expect(asked).toEqual(['Delete account', 'Checkout']);
    expect(await evaluate(session, '[window.svgDeleted, window.checkouts]')).toEqual([0, 0]);
  });

  it('act click on a harmless child (a grip) inside a risky button asks about the button', async () => {
    const session = await chrome.openPage(`${servers.originA}/confirm.html`);
    const obs = await observePage(chrome.conn, session);
    const asked: string[] = [];
    const ctx = contextFor(session, async (label) => {
      asked.push(label);
      return false;
    }).ctx;
    const input = await inputSentDuring(async () => {
      const { results } = await act(ctx, [{ op: 'click', target: row(obs, 'Grip').id }]);
      expect(results[0].result).toBe('denied');
    });
    expect(input).toEqual([]);
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatch(/Remove/);
    expect(await evaluate(session, 'window.wraps')).toBe(0);
  });

  it('asks before a select picks a risky option, and before arrow keys can land on one', async () => {
    const session = await chrome.openPage(`${servers.originA}/confirm.html`);
    const obs = await observePage(chrome.conn, session);
    const asked: string[] = [];
    const ctx = contextFor(session, async (label) => {
      asked.push(label);
      return false;
    }).ctx;
    const picked = await act(ctx, [{ op: 'select', target: row(obs, 'Action').id, text: 'Delete selected' }]);
    expect(picked.results[0].result).toBe('denied');
    expect(asked).toEqual(['Delete selected']);
    expect(await evaluate(session, '[window.selChanged, document.getElementById("sel").value]')).toEqual([0, 'Choose']);

    await evaluate(session, `document.getElementById('sel').focus()`);
    const input = await inputSentDuring(() => act(ctx, [{ op: 'press', key: 'ArrowDown' }]));
    expect(input).toEqual([]);
    expect(asked).toHaveLength(2);
    expect(await evaluate(session, 'window.selChanged')).toBe(0);

    // Allowed, the option is chosen and the page's handler runs.
    await act(contextFor(session).ctx, [{ op: 'select', target: row(obs, 'Action').id, text: 'Delete selected' }]);
    expect(await evaluate(session, 'window.selChanged')).toBe(1);
  });

  it('a denied risky click sends no input and leaves the page alone', async () => {
    const session = await chrome.openPage(`${servers.originA}/confirm.html`);
    const obs = await observePage(chrome.conn, session);
    const { ctx, reported } = contextFor(session, async () => false);
    const input = await inputSentDuring(async () => {
      const { results } = await act(ctx, [{ op: 'click', target: row(obs, 'Delete account').id }]);
      expect(results[0].result).toBe('denied');
    });
    expect(input).toEqual([]);
    expect(reported).toEqual([]);
    expect(await evaluate(session, 'window.deleted')).toBe(0);
  });

  it('clicks through two levels of frames (an A frame inside a B builder inside A), each owner hit-tested', async () => {
    const session = await chrome.openPage(`${servers.originA}/builder-crossorigin.html`);
    const obs = await observeUntil(chrome.conn, session, (o) => rowsIn(o, servers.originA, 'Publish').length > 0);
    const [nested] = rowsIn(obs, servers.originA, 'Publish');
    const frame = frameByKey(chrome.conn, session, nested.frameKey);
    expect(frame?.owners).toHaveLength(2);
    // Headless Chrome routes input to a just-loaded nested OOPIF only once its parent has embedded it, which is also
    // when the frame first sees itself on screen.
    const embedded = `new Promise((resolve) => new IntersectionObserver((entries, observer) => {
      if (entries[0].isIntersecting) { observer.disconnect(); requestAnimationFrame(() => requestAnimationFrame(resolve)); }
    }).observe(document.body))`;
    await chrome.conn.send('Runtime.evaluate', { expression: embedded, awaitPromise: true }, frame?.sessionId);

    const { results } = await act(contextFor(session).ctx, [{ op: 'click', target: nested.id }]);

    expect(results[0].result).toBe('done');
    expect(await evaluate(frame?.sessionId ?? '', 'window.clicks')).toBe(1);
  });

  it('drags item A below item B in the HTML5 drag list (order verified)', async () => {
    const session = await chrome.openPage(`${servers.originA}/drag.html`);
    const obs = await observePage(chrome.conn, session);
    const { ctx, reported } = contextFor(session);

    const result = await drag(ctx, row(obs, 'Item 1').id, row(obs, 'Item 2').id, 'after');

    expect(result.result).toBe('done');
    expect(await evaluate(session, `[...document.querySelectorAll('#list li')].map((li) => li.id)`)).toEqual([
      'd2',
      'd1',
      'd3',
    ]);
    expect(await evaluate(session, 'window.dropLog')).toEqual(['d1->d2']);
    expect(reported.map((r) => r.op)).toEqual(['drag']);
  });

  it('drags a pointer-only sortable card (no HTML5 drag) with press, move and release', async () => {
    const session = await chrome.openPage(`${servers.originA}/drag.html`);
    const obs = await observePage(chrome.conn, session);
    const { ctx } = contextFor(session);
    const send = vi.spyOn(chrome.conn, 'send');
    try {
      expect((await drag(ctx, row(obs, 'Card 1').id, row(obs, 'Card 2').id, 'after')).result).toBe('done');
      expect(send.mock.calls.some(([method]) => method === 'Input.dispatchDragEvent')).toBe(false);
    } finally {
      send.mockRestore();
    }
    expect(await evaluate(session, `[...document.querySelectorAll('#sortable li')].map((li) => li.id)`)).toEqual([
      'p2',
      'p1',
      'p3',
    ]);
    expect(await evaluate(session, 'window.sortLog')).toEqual(['p1->p2']);
  });

  it('a top-page overlay over a cross-origin iframe makes its controls stale, with no input', async () => {
    const session = await chrome.openPage(`${servers.originA}/builder-crossorigin.html`);
    const obs = await observeUntil(chrome.conn, session, (o) => rowsIn(o, servers.originB, 'Publish').length > 0);
    const [publish] = rowsIn(obs, servers.originB, 'Publish');
    const child = frameByKey(chrome.conn, session, publish.frameKey)?.sessionId ?? '';
    await evaluate(
      session,
      `document.body.append(Object.assign(document.createElement('div'), { style: 'position:fixed;inset:0;z-index:9' }))`
    );
    const { ctx } = contextFor(session);

    let outcome: Awaited<ReturnType<typeof act>> | undefined;
    const input = await inputSentDuring(async () => {
      outcome = await act(ctx, [{ op: 'click', target: publish.id }]);
    });

    expect(input).toEqual([]);
    expect(outcome?.results[0]).toMatchObject({ result: 'stale', reason: expect.stringMatching(/covered/) });
    expect(await evaluate(child, 'window.clicks')).toBe(0);
  });

  it('a stale page (DOM replaced by other controls between observe and act) returns stale and performs no input', async () => {
    const session = await chrome.openPage(`${servers.originA}/child.html`);
    const obs = await observePage(chrome.conn, session);
    // Same places, other controls: an equivalent replacement would be re-found, a renamed one never is.
    await evaluate(
      session,
      `const body = document.body.cloneNode(true);
      body.querySelector('#publish').textContent = 'Unpublish';
      document.body.replaceWith(body)`
    );
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
    const refused = await act(ctx, [{ op: 'type', target: select.id, text: 'x' }]);
    expect(refused.results[0]).toMatchObject({ result: 'error', reason: expect.stringMatching(/not an editable/) });

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

  it('clips a target screenshot to the part the viewport shows', async () => {
    const session = await chrome.openPage(`${servers.originA}/builder-sameorigin.html`);
    const obs = await observeUntil(chrome.conn, session, (o) => rowsIn(o, 'GHL builder', 'Publish').length > 0);
    // Publish spans y 120-150 on the page; 130 px down it shows only its lower 20 px (its center still on screen).
    await evaluate(session, 'scrollTo(0, 130)');
    const { ctx } = contextFor(session);
    const send = vi.spyOn(chrome.conn, 'send');
    try {
      await screenshot(ctx, rowsIn(obs, 'GHL builder', 'Publish')[0].id);
      const [, params] = send.mock.calls.find(([method]) => method === 'Page.captureScreenshot') ?? [];
      expect(params).toMatchObject({ clip: { x: 40, y: 130, width: 80, height: 20 } });
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
