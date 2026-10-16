import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  formatObservation,
  observePage,
  type ActionRow,
  type Observation,
} from '@process/resources/builtinMcp/aionBrowser/actionSpace';
import { watchFrames } from '@process/resources/builtinMcp/aionBrowser/frames';
import { chromePath, launchTestChrome, type TestChrome } from './helpers/chrome';
import { startFixtureServers, type FixtureServers } from './helpers/fixtureServer';

const WAIT_MS = 5000;

let chrome: TestChrome;
let servers: FixtureServers;

/** Observes until `ready` holds: OOPIFs attach (and nested ones load) a little after the top load event. */
async function observeUntil(
  sessionId: string,
  ready: (obs: Observation) => boolean,
  deadline = Date.now() + WAIT_MS
): Promise<Observation> {
  const obs = await observePage(chrome.conn, sessionId);
  if (ready(obs) || Date.now() > deadline) return obs;
  await new Promise((resolve) => setTimeout(resolve, 50));
  return observeUntil(sessionId, ready, deadline);
}

const rowsIn = (obs: Observation, frameLabel: string, label: string): ActionRow[] =>
  obs.rows.filter((row) => row.frameLabel === frameLabel && row.label === label);

describe.skipIf(!chromePath)('observe on real Chrome', () => {
  beforeAll(async () => {
    servers = await startFixtureServers();
    chrome = await launchTestChrome(chromePath as string);
    watchFrames(chrome.conn);
  });

  afterAll(async () => {
    await chrome?.close();
    await servers?.close();
  });

  it('lists controls inside a same-origin iframe with frame label and translated rects', async () => {
    const session = await chrome.openPage(`${servers.originA}/builder-sameorigin.html`);
    const obs = await observeUntil(session, (o) => rowsIn(o, 'GHL builder', 'Publish').length > 0);

    const [publish] = rowsIn(obs, 'GHL builder', 'Publish');
    expect(publish).toMatchObject({ role: 'button', rect: { x: 40, y: 120, w: 80, h: 30 } });
    expect(publish.id).toMatch(/^f\d+:\d+$/);
    // The zero-size and the off-screen iframe hold the same child page; neither is observed.
    expect(obs.rows.filter((row) => row.label === 'Publish')).toHaveLength(1);
    expect(obs.frames.map((f) => f.label)).toEqual([servers.originA, 'GHL builder']);

    const text = formatObservation(obs);
    expect(text).toContain(`[${publish.id}] button "Publish" · in: GHL builder`);
    expect(text).toMatch(/\[f\d+:\d+\] button "Top action"\n/); // top-frame rows carry no frame suffix
    expect(text).toContain('Builder canvas text');
  });

  it('lists controls inside a cross-origin (OOPIF) iframe — ids f<k>:<n>, frame label = origin', async () => {
    const session = await chrome.openPage(`${servers.originA}/builder-crossorigin.html`);
    const nestedReady = (o: Observation) =>
      rowsIn(o, servers.originB, 'Publish').length > 0 && rowsIn(o, servers.originA, 'Publish').length > 0;
    const obs = await observeUntil(session, nestedReady);

    const [oopif] = rowsIn(obs, servers.originB, 'Publish');
    expect(oopif.id).toMatch(/^f\d+:\d+$/);
    expect(oopif.rect).toMatchObject({ x: 40, y: 40 });
    expect(formatObservation(obs)).toContain(`[${oopif.id}] button "Publish" · in: ${servers.originB}`);

    // One level deeper: A's child.html inside B's builder (an OOPIF inside an OOPIF), offsets chained to the top.
    const [nested] = rowsIn(obs, servers.originA, 'Publish');
    expect(nested.rect).toMatchObject({ x: 70, y: 290 });
    expect(new Set(obs.frames.map((f) => f.frameKey)).size).toBe(obs.frames.length);
    expect(obs.frames.map((f) => f.label)).toContain('nested');

    // Frame keys stay put across observes of the same documents.
    const again = await observePage(chrome.conn, session);
    expect(rowsIn(again, servers.originB, 'Publish')[0].id).toBe(oopif.id);
  });

  it('lists controls inside open shadow roots', async () => {
    const session = await chrome.openPage(`${servers.originA}/shadow.html`);
    const obs = await observePage(chrome.conn, session);
    const summary = obs.rows.map((row) => `${row.role} ${row.label}`);

    expect(summary).toEqual(
      expect.arrayContaining(['button Shadow save', 'textbox Shadow email', 'link Deep link', 'textbox Post body'])
    );
    expect(summary.some((line) => line.includes('Closed secret'))).toBe(false);
    expect(obs.text).toContain('Text inside a shadow root');
  });

  it('scope limits rows to one frame; rows cap at 250 with omitted count', async () => {
    const session = await chrome.openPage(`${servers.originA}/builder-sameorigin.html`);
    await observeUntil(session, (o) => rowsIn(o, 'GHL builder', 'Publish').length > 0);

    const scoped = await observePage(chrome.conn, session, { scope: 'GHL builder' });
    expect(scoped.rows.length).toBeGreaterThan(0);
    expect(scoped.rows.every((row) => row.frameLabel === 'GHL builder')).toBe(true);
    expect(scoped.text).not.toContain('Top action');
    expect(scoped.omitted).toBe(0);
  });

  it('observe never returns a screenshot', async () => {
    const session = await chrome.openPage(`${servers.originA}/builder-sameorigin.html`);
    const send = vi.spyOn(chrome.conn, 'send');
    let sent: string[];
    try {
      await observePage(chrome.conn, session);
    } finally {
      sent = send.mock.calls.map(([method]) => method);
      send.mockRestore();
    }
    expect(sent.length).toBeGreaterThan(0);
    expect(sent.some((method) => method.includes('Screenshot') || method.startsWith('Page.capture'))).toBe(false);
  });
});
