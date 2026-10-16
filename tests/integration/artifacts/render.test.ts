/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ArtifactKind } from '@/common/types/agent/artifacts';
import { renderArtifactPage } from '@process/artifacts/pages';
import { startArtifactServer, type ArtifactServer } from '@process/artifacts/server';
import { createArtifactStore, type ArtifactStore } from '@process/artifacts/store';
import { chromePath, launchTestChrome, type TestChrome } from '../agentBrowser/helpers/chrome';

/** Written by `node scripts/build-mcp-servers.js` (also run by `bun run start` and the packaging build). */
const LIBS_DIR = path.resolve(__dirname, '../../../out/main/artifact-libs');
const WAIT_MS = 8000;

const REACT_SOURCE = `
import { useState } from 'react';
import { LineChart, Line, XAxis, YAxis } from 'recharts';
import { Rocket } from 'lucide-react';
type Point = { x: number; y: number };
const data: Point[] = [{ x: 1, y: 2 }, { x: 2, y: 5 }, { x: 3, y: 3 }];
export default function App() {
  const [n, setN] = useState<number>(0);
  return (
    <div id="app" className="p-4 text-red-600">
      <Rocket id="icon" />
      <LineChart width={300} height={150} data={data}>
        <XAxis dataKey="x" /><YAxis /><Line dataKey="y" isAnimationActive={false} />
      </LineChart>
      <button id="btn" onClick={() => setN(n + 1)}>{n}</button>
    </div>
  );
}`;

type Evaluated = { result: { value?: unknown }; exceptionDetails?: { text: string } };

describe.skipIf(!chromePath)('artifact pages in headless Chrome', () => {
  let root: string;
  let store: ArtifactStore;
  let server: ArtifactServer;
  let chrome: TestChrome;
  /** Every request URL each page session sent. */
  const requests = new Map<string, string[]>();

  const create = async (kind: ArtifactKind, content: string): Promise<string> => {
    const created = await store.create('conv1', { title: `A ${kind}`, kind, content });
    if (!created.ok) throw new Error(created.message);
    return created.value.id;
  };

  const evaluate = async (sessionId: string, expression: string): Promise<unknown> => {
    const reply = await chrome.conn.send<Evaluated>(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true, userGesture: true },
      sessionId
    );
    if (reply.exceptionDetails) throw new Error(reply.exceptionDetails.text);
    return reply.result.value;
  };

  /** Polls `expression` in the page until it is truthy (or the wait runs out) and returns its last value. */
  const waitFor = (sessionId: string, expression: string): Promise<unknown> =>
    evaluate(
      sessionId,
      `new Promise((resolve) => {
        const end = Date.now() + ${WAIT_MS};
        const poll = () => {
          let v; try { v = (${expression}); } catch (e) { v = null; }
          if (v || Date.now() > end) resolve(v ?? null); else setTimeout(poll, 50);
        };
        poll();
      })`
    );

  /** Opens a tab, records its requests from the very first one, and loads the artifact. */
  const open = async (id: string): Promise<string> => {
    const sessionId = await chrome.openPage('about:blank');
    const urls: string[] = [];
    requests.set(sessionId, urls);
    chrome.conn.on('Network.requestWillBeSent', (params, from) => {
      if (from === sessionId) urls.push((params.request as { url: string }).url);
    });
    await chrome.conn.send('Network.enable', {}, sessionId);
    const loaded = new Promise<void>((resolve) => {
      const off = chrome.conn.on('Page.loadEventFired', (_params, from) => {
        if (from !== sessionId) return;
        off();
        resolve();
      });
    });
    await chrome.conn.send('Page.navigate', { url: server.url(id) }, sessionId);
    await loaded;
    return sessionId;
  };

  beforeAll(async () => {
    if (!existsSync(path.join(LIBS_DIR, 'manifest.json'))) {
      throw new Error(`No bundled libraries in ${LIBS_DIR}; run node scripts/build-mcp-servers.js first`);
    }
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-render-'));
    store = createArtifactStore(root);
    server = await startArtifactServer({ store, token: 'unused', renderPage: renderArtifactPage, libsDir: LIBS_DIR });
    chrome = await launchTestChrome(chromePath as string);
  }, 30_000);

  afterAll(async () => {
    await chrome?.close();
    await server?.close();
    if (root) await fs.rm(root, { recursive: true, force: true });
  });

  it('a react artifact using recharts and lucide renders its chart with no request outside 127.0.0.1', async () => {
    const page = await open(await create('react', REACT_SOURCE));
    expect(await waitFor(page, "!!document.querySelector('.recharts-line path')")).toBe(true);
    expect(await evaluate(page, "!!document.querySelector('svg.lucide')")).toBe(true);
    await evaluate(page, "document.getElementById('btn').click()");
    expect(await waitFor(page, "document.getElementById('btn').textContent === '1'")).toBe(true);
    // Tailwind ran: text-red-600 is not the default black.
    expect(await waitFor(page, "getComputedStyle(document.getElementById('app')).color !== 'rgb(0, 0, 0)'")).toBe(true);

    const urls = requests.get(page) ?? [];
    expect(urls).toContain(`${server.origin}/lib/recharts.js`);
    expect(urls.filter((u) => !u.startsWith(`${server.origin}/`) && !/^(data|blob):/.test(u))).toEqual([]);
  });

  it('bad JSX shows the compile error in the page, server still serves', async () => {
    const page = await open(await create('react', 'export default function App() { return <div>; }'));
    const message = (await waitFor(page, "document.querySelector('#root pre')?.textContent")) as string | null;
    expect(message).toMatch(/\(\d+:\d+\)/);
    expect(await evaluate(page, "getComputedStyle(document.querySelector('#root pre')).color")).toBe(
      'rgb(185, 28, 28)'
    );

    const runtime = await open(await create('react', "export default function App() { throw new Error('boom'); }"));
    expect(await waitFor(runtime, "document.querySelector('#root pre')?.textContent")).toContain('boom');

    const next = await open(await create('mermaid', 'graph TD; A-->B'));
    expect(await waitFor(next, "!!document.querySelector('#root svg')")).toBe(true);
  });

  it('fetch("https://example.com") from an artifact is blocked by CSP', async () => {
    const page = await open(await create('react', 'export default () => <p id="ok">ok</p>;'));
    expect(await waitFor(page, "!!document.getElementById('ok')")).toBe(true);
    const outcome = await evaluate(
      page,
      `new Promise((resolve) => {
        const violations = [];
        document.addEventListener('securitypolicyviolation', (e) => violations.push(e.effectiveDirective));
        fetch('https://example.com').then(
          () => resolve({ fetched: true, violations }),
          (e) => setTimeout(() => resolve({ fetched: false, error: e.name, violations }), 100)
        );
      })`
    );
    expect(outcome).toEqual({ fetched: false, error: 'TypeError', violations: ['connect-src'] });
    expect((requests.get(page) ?? []).some((u) => u.includes('example.com'))).toBe(false);
  });

  it('mermaid and markdown artifacts render', async () => {
    const diagram = await open(await create('mermaid', 'graph TD; Start-->Finish'));
    expect(await waitFor(diagram, "document.querySelector('#root svg')?.textContent.includes('Finish')")).toBe(true);

    const doc = await open(
      await create('markdown', '# Weekly notes\n\nSome **bold** text.\n\n```mermaid\ngraph LR; Plan-->Ship\n```\n')
    );
    expect(await waitFor(doc, "document.querySelector('h1')?.textContent")).toBe('Weekly notes');
    expect(await evaluate(doc, "document.querySelector('strong')?.textContent")).toBe('bold');
    expect(await waitFor(doc, "document.querySelector('.mermaid svg')?.textContent.includes('Ship')")).toBe(true);
  });

  describe('each artifact page is its own sandboxed origin', () => {
    it('localStorage access throws', async () => {
      const page = await open(await create('html', '<p>storage</p>'));
      expect(
        await evaluate(
          page,
          "(() => { try { localStorage.length; return 'readable'; } catch (e) { return e.name; } })()"
        )
      ).toBe('SecurityError');
    });

    it("an artifact can't read another artifact's DOM via an iframe or a popup", async () => {
      const secret = await create('html', '<p id="secret">s3cret</p>');
      const page = await open(await create('html', `<iframe id="f" src="/a/${secret}"></iframe>`));
      expect(
        await evaluate(
          page,
          "(() => { try { return document.getElementById('f').contentWindow.document.body.innerHTML; } catch (e) { return e.name; } })()"
        )
      ).toBe('SecurityError');
      // A popup shares no origin with its opener either.
      const popup = await waitFor(
        page,
        `(() => {
          window.w = window.w || window.open('/a/${secret}');
          try { return window.w.document.getElementById('secret')?.textContent ?? null; } catch (e) { return e.name; }
        })()`
      );
      expect(popup).toBe('SecurityError');
    });

    it('the React page still renders with the libs', async () => {
      const page = await open(await create('react', 'export default () => <h2 className="font-bold">Sandboxed</h2>;'));
      expect(await waitFor(page, "document.querySelector('h2')?.textContent")).toBe('Sandboxed');
    });
  });
});
