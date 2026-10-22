import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ActionContext } from '@process/resources/builtinMcp/aionBrowser/actions';
import { watchFrames } from '@process/resources/builtinMcp/aionBrowser/frames';
import { formatScriptReply, runReadScript, scriptFrame } from '@process/resources/builtinMcp/aionBrowser/runScript';
import { PAGE_CHANGED, evaluateWriteScript, type ScriptWorld } from '@process/services/agentBrowser/relay/pageScript';
import { chromePath, launchTestChrome, type TestChrome } from './helpers/chrome';
import { startFixtureServers, type FixtureServers } from './helpers/fixtureServer';
import { observeUntil } from './helpers/observeUntil';

let chrome: TestChrome;
let servers: FixtureServers;

const BUILDER = 'funnel-builder';
const CANVAS = 'canvas';

const contextFor = (sessionId: string): ActionContext => ({
  conn: chrome.conn,
  sessionId,
  report: async () => undefined,
  confirm: async () => true,
});

/** The funnel builder (top on A, builder on B, canvas inside the builder) once every frame lists, and its frame keys. */
const openFunnel = async () => {
  const session = await chrome.openPage(`${servers.originA}/funnel.html?top`);
  const obs = await observeUntil(chrome.conn, session, (o) =>
    o.rows.some((r) => r.frameLabel === CANVAS && r.label === 'Footer note')
  );
  const keyOf = (label: string): string => obs.frames.find((f) => f.label === label)?.frameKey ?? '';
  return { ctx: contextFor(session), keyOf };
};

describe.skipIf(!chromePath)('run_script in the frames of a funnel builder on real Chrome', () => {
  beforeAll(async () => {
    servers = await startFixtureServers();
    chrome = await launchTestChrome(chromePath as string);
    watchFrames(chrome.conn);
  });

  afterAll(async () => {
    await chrome?.close();
    await servers?.close();
  });

  it.each([
    [BUILDER, 'Funnel builder'],
    [CANVAS, 'Canvas'],
  ])('read mode returns the title and origin of the %s frame', async (label, title) => {
    const { ctx, keyOf } = await openFunnel();
    const frame = await scriptFrame(ctx, keyOf(label));
    const outcome = await runReadScript(
      ctx,
      '({ title: document.title, origin: location.origin })',
      'expression',
      frame
    );
    expect(outcome).toEqual({ ok: true, text: JSON.stringify({ title, origin: servers.originB }) });
  });

  it('defaults to the top frame, which cannot read the cross-origin builder', async () => {
    const { ctx } = await openFunnel();
    const code = '[location.origin, document.querySelector("iframe").contentDocument]';
    expect(await runReadScript(ctx, code, 'expression')).toEqual({
      ok: true,
      text: JSON.stringify([servers.originA, null]),
    });
  });

  it('stays read-only inside a frame', async () => {
    const { ctx, keyOf } = await openFunnel();
    const frame = await scriptFrame(ctx, keyOf(CANVAS));
    expect(await runReadScript(ctx, 'document.title = "edited"', 'expression', frame)).toEqual({
      ok: false,
      error: "This script changes the page; rerun with mode 'write' (asks the user).",
    });
  });

  it('refuses an unknown frame id, and one whose frame is gone since observe', async () => {
    const { ctx, keyOf } = await openFunnel();
    await expect(scriptFrame(ctx, 'f999')).rejects.toThrow(
      'Unknown frame f999; use a frame id from the latest observe.'
    );
    const canvas = keyOf(CANVAS);
    const builder = await scriptFrame(ctx, keyOf(BUILDER));
    await chrome.conn.send(
      'Runtime.evaluate',
      { expression: 'document.querySelector("iframe").remove()' },
      builder.sessionId
    );
    await expect(scriptFrame(ctx, canvas)).rejects.toThrow(`Unknown frame ${canvas}; use a frame id`);
  });

  it.each([
    ['page', 'object'],
    ['isolated', 'undefined'],
  ] as const)('a write script allowed for the frame runs in the nested canvas, world %s', async (world, globals) => {
    const { ctx, keyOf } = await openFunnel();
    const canvas = await scriptFrame(ctx, keyOf(CANVAS));
    const send = (method: string, params: Record<string, unknown>) =>
      chrome.conn.send(method, params, canvas.sessionId);
    const script = {
      code: 'document.title = "edited";\nreturn [document.title, typeof window.selected];',
      form: 'body' as const,
      world: world as ScriptWorld,
      frameId: canvas.frameId,
    };
    // window.selected is the canvas page's own global: only its JS world sees it.
    expect(formatScriptReply(await evaluateWriteScript(send, script, servers.originB))).toEqual({
      ok: true,
      text: JSON.stringify(['edited', globals]),
    });
    // A thrown error comes back with its message.
    const thrown = { ...script, code: 'const x = null;\nreturn x.y;' };
    expect(formatScriptReply(await evaluateWriteScript(send, thrown, servers.originB), thrown.code)).toMatchObject({
      ok: false,
      error: expect.stringContaining('TypeError: Cannot read properties of null'),
    });
    // Allowed for another origin than the frame has now: it does not run.
    const refused = asRecord(await evaluateWriteScript(send, script, servers.originA));
    expect(asRecord(asRecord(refused.exceptionDetails).exception).value).toBe(PAGE_CHANGED);
  });
});

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
