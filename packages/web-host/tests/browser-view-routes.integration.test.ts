/**
 * The live browser-view routes: `GET /api/browser-view/tabs` and the `/api/browser-view/stream` WebSocket.
 * Both go through the existing auth gate, then need a same-origin `Origin`; streams are limited, re-validated,
 * and closed by a sign-out. Real TCP listener, the fake aioncore and a fake BrowserViewRoutes.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import type { AddressInfo, Socket } from 'node:net';
import WebSocket, { type RawData } from 'ws';
import { createBrowserViewStreams } from '../src/browserViewRoutes.js';
import { startStaticServer, type StaticServerHandle } from '../src/static-server.js';
import type { BrowserViewPeer, BrowserViewRoutes } from '../src/types.js';
import {
  GOOD,
  rawExchange,
  request,
  startFakeBackend,
  STATIC_DIR,
  upgrade,
  type FakeBackend,
} from './fixtures/fake-aioncore.js';

const TABS = [{ id: 'wc-7', title: 'Example', url: 'https://example.com/' }];

type FakeRoutes = BrowserViewRoutes & {
  peers: BrowserViewPeer[];
  messages: string[];
  closes: number;
  /** Hold openStream answers until the returned function runs. */
  hold: () => () => void;
};

function fakeRoutes(): FakeRoutes {
  let held: Array<() => void> | null = null;
  const routes: FakeRoutes = {
    peers: [],
    messages: [],
    closes: 0,
    hold: () => {
      const queue: Array<() => void> = [];
      held = queue;
      return () => {
        held = null;
        for (const go of queue.splice(0)) go();
      };
    },
    listTabs: vi.fn<BrowserViewRoutes['listTabs']>((conversationId) => (conversationId === 'conv-1' ? TABS : [])),
    openStream: vi.fn(async (tabId: string, peer: BrowserViewPeer) => {
      if (held) await new Promise<void>((r) => held?.push(r));
      if (tabId === 'wc-99') return { error: 'not-allowed' as const };
      routes.peers.push(peer);
      const onMessage = (raw: string): void => {
        if (raw === 'boom') throw new Error('bad message');
        routes.messages.push(raw);
      };
      return { onMessage, close: () => (routes.closes += 1) };
    }),
  };
  return routes;
}

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !cond(); i++) await new Promise((r) => setTimeout(r, 10));
  expect(cond()).toBe(true);
};

type Opened = {
  ws: WebSocket;
  received: RawData[];
  closed: () => { code: number; reason: string } | null;
};

/** Open a stream socket; resolves with the open socket, or the HTTP status that refused it. `autoPong: false` ignores pings. */
function openStream(
  port: number,
  tab: string,
  headers: Record<string, string>,
  opts: { autoPong?: boolean } = {}
): Promise<Opened | number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/browser-view/stream?tab=${tab}`, { headers, ...opts });
    const received: RawData[] = [];
    let closed: { code: number; reason: string } | null = null;
    ws.on('message', (data) => received.push(data));
    ws.on('close', (code, reason) => (closed = { code, reason: reason.toString() }));
    ws.on('open', () => resolve({ ws, received, closed: () => closed }));
    ws.on('unexpected-response', (req, res) => {
      req.destroy();
      resolve(res.statusCode ?? 0);
    });
    ws.on('error', reject);
  });
}

const opened = async (p: Promise<Opened | number>): Promise<Opened> => {
  const r = await p;
  if (typeof r === 'number') throw new Error(`refused with ${r}`);
  return r;
};

const jwtAt = (iat: number): string => `e30.${Buffer.from(JSON.stringify({ iat })).toString('base64url')}.good`;

describe('browser-view routes', () => {
  let backend: FakeBackend;
  let routes: FakeRoutes;
  let handle: StaticServerHandle;
  let origin: string;
  let session: Record<string, string>;
  const sockets: WebSocket[] = [];

  beforeEach(async () => {
    backend = await startFakeBackend();
    routes = fakeRoutes();
    handle = await startStaticServer({
      staticDir: STATIC_DIR,
      backendPort: backend.port,
      port: 0,
      localRoutes: { browserView: routes },
    });
    origin = `http://127.0.0.1:${handle.port}`;
    session = { cookie: GOOD, origin };
  });

  afterEach(async () => {
    for (const ws of sockets.splice(0)) ws.terminate();
    await handle.stop();
    await backend.close();
  });

  const stream = async (tab: string, headers = session): Promise<Opened> => {
    const s = await opened(openStream(handle.port, tab, headers));
    sockets.push(s.ws);
    return s;
  };

  describe('without a session', () => {
    it('GET /api/browser-view/tabs is 401 and never calls listTabs', async () => {
      const r = await request(handle.port, 'GET', '/api/browser-view/tabs?conversation=conv-1', { origin });
      expect(r.status).toBe(401);
      expect(routes.listTabs).not.toHaveBeenCalled();
    });

    it('the stream upgrade is refused with 401 and never opens a stream', async () => {
      expect(await openStream(handle.port, 'wc-7', { origin })).toBe(401);
      expect(routes.openStream).not.toHaveBeenCalled();
      expect(backend.seen).toHaveLength(0);
    });
  });

  describe('Origin', () => {
    it.each([
      ['a missing Origin', {}],
      ['a foreign Origin', { origin: 'https://evil.example' }],
      ['an Origin on another port', { origin: 'http://127.0.0.1:1' }],
      ['a non-http Origin', { origin: 'file://127.0.0.1' }],
      ['a null Origin', { origin: 'null' }],
    ])('%s gives 403 on the tabs route', async (_name, extra) => {
      const r = await request(handle.port, 'GET', '/api/browser-view/tabs?conversation=conv-1', {
        cookie: GOOD,
        ...extra,
      });
      expect(r.status).toBe(403);
      expect(routes.listTabs).not.toHaveBeenCalled();
    });

    it('no Origin with Sec-Fetch-Site: same-origin passes on the tabs route, without CORS headers', async () => {
      const r = await request(handle.port, 'GET', '/api/browser-view/tabs?conversation=conv-1', {
        cookie: GOOD,
        'sec-fetch-site': 'same-origin',
      });
      expect(r.status).toBe(200);
      expect(JSON.parse(r.body)).toEqual({ tabs: TABS });
      expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
    });

    it.each([
      ['Sec-Fetch-Site: cross-site and no Origin', { 'sec-fetch-site': 'cross-site' }],
      ['Sec-Fetch-Site: same-site and no Origin', { 'sec-fetch-site': 'same-site' }],
      ['Sec-Fetch-Site: none and no Origin', { 'sec-fetch-site': 'none' }],
      [
        'a foreign Origin with Sec-Fetch-Site: same-origin',
        { origin: 'https://evil.example', 'sec-fetch-site': 'same-origin' },
      ],
    ])('%s gives 403 on the tabs route, without CORS headers', async (_name, extra) => {
      const r = await request(handle.port, 'GET', '/api/browser-view/tabs?conversation=conv-1', {
        cookie: GOOD,
        ...extra,
      });
      expect(r.status).toBe(403);
      expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
      expect(routes.listTabs).not.toHaveBeenCalled();
    });

    it.each([
      ['a missing Origin', {}],
      ['a missing Origin with Sec-Fetch-Site: same-origin', { 'sec-fetch-site': 'same-origin' }],
      ['a foreign Origin', { origin: 'https://evil.example' }],
    ])('%s gives 403 on the stream upgrade', async (_name, extra) => {
      expect(await openStream(handle.port, 'wc-7', { cookie: GOOD, ...extra })).toBe(403);
      expect(routes.openStream).not.toHaveBeenCalled();
    });

    it('a tunnel hostname matches its https Origin, case-insensitively', async () => {
      const host = 'Calm-River-42.TryCloudflare.com';
      const headers = { cookie: GOOD, host, origin: 'https://calm-river-42.trycloudflare.com' };
      const r = await request(handle.port, 'GET', '/api/browser-view/tabs?conversation=conv-1', headers);
      expect(r.status).toBe(200);
      const s = await stream('wc-7', headers);
      expect(s.ws.readyState).toBe(WebSocket.OPEN);
    });
  });

  describe('with a session', () => {
    it('GET /api/browser-view/tabs answers the tabs as uncached JSON, without reaching aioncore', async () => {
      const r = await request(handle.port, 'GET', '/api/browser-view/tabs?conversation=conv-1', session);
      expect(r.status).toBe(200);
      expect(r.headers['content-type']).toBe('application/json');
      expect(r.headers['cache-control']).toBe('no-store');
      expect(Object.keys(r.headers).filter((h) => h.startsWith('access-control-'))).toEqual([]);
      expect(JSON.parse(r.body)).toEqual({ tabs: TABS });
      expect(routes.listTabs).toHaveBeenCalledWith('conv-1');
      expect(backend.seen).toHaveLength(0);
    });

    it('GET /api/browser-view/tabs waits for a list the desktop looks up, and fails closed when the lookup fails', async () => {
      routes.listTabs.mockImplementationOnce(async () => TABS);
      const listed = await request(handle.port, 'GET', '/api/browser-view/tabs?conversation=conv-1', session);
      expect(listed.status).toBe(200);
      expect(JSON.parse(listed.body)).toEqual({ tabs: TABS });

      routes.listTabs.mockImplementationOnce(async () => {
        throw new Error('lookup failed');
      });
      const failed = await request(handle.port, 'GET', '/api/browser-view/tabs?conversation=conv-1', session);
      expect(failed.status).toBe(500);
      expect(JSON.parse(failed.body)).toEqual({ error: 'LIST_FAILED' });
    });

    it.each([
      ['no conversation', ''],
      ['an empty conversation', '?conversation='],
      ['a conversation with a space', '?conversation=a%20b'],
      ['a too-long conversation', `?conversation=${'a'.repeat(65)}`],
      ['two conversations', '?conversation=a&conversation=b'],
    ])('%s is 400', async (_name, query) => {
      const r = await request(handle.port, 'GET', `/api/browser-view/tabs${query}`, session);
      expect(r.status).toBe(400);
      expect(routes.listTabs).not.toHaveBeenCalled();
    });

    it('a POST to the tabs route is 405', async () => {
      const r = await request(handle.port, 'POST', '/api/browser-view/tabs?conversation=conv-1', session);
      expect(r.status).toBe(405);
      expect(routes.listTabs).not.toHaveBeenCalled();
    });

    it('carries frames to the phone and its text messages to the stream; binary from the phone is ignored', async () => {
      const s = await stream('wc-7');
      await until(() => routes.peers.length === 1);
      expect(routes.openStream).toHaveBeenCalledWith('wc-7', expect.anything());
      routes.peers[0].sendBinary(Buffer.from([1, 2, 3]));
      routes.peers[0].sendText('{"type":"no-frames"}');
      await until(() => s.received.length === 2);
      expect(Buffer.from(s.received[0] as Buffer)).toEqual(Buffer.from([1, 2, 3]));
      expect(s.received[1].toString()).toBe('{"type":"no-frames"}');
      s.ws.send(Buffer.from([9]));
      s.ws.send('{"type":"ack"}');
      await until(() => routes.messages.length === 1);
      expect(routes.messages).toEqual(['{"type":"ack"}']);
    });

    it('keeps messages the phone sends while the stream is still opening', async () => {
      const release = routes.hold();
      const s = await stream('wc-7');
      s.ws.send('{"type":"hello","width":390,"dpr":3}');
      await new Promise((r) => setTimeout(r, 50));
      release();
      await until(() => routes.messages.length === 1);
      expect(routes.messages).toEqual(['{"type":"hello","width":390,"dpr":3}']);
    });

    it('forwards the close code of a refused stream, and releases its slot', async () => {
      // Two un-released slots would make the third a 429.
      for (let i = 0; i < 3; i++) {
        const s = await stream('wc-99');
        await until(() => s.closed() !== null);
        expect(s.closed()).toEqual({ code: 1008, reason: 'not-allowed' });
      }
    });

    it('closes a stream whose onMessage throws with 1011, and logs it', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const s = await stream('wc-7');
      await until(() => routes.peers.length === 1);
      s.ws.send('boom');
      await until(() => s.closed() !== null);
      expect(s.closed()?.code).toBe(1011);
      expect(error).toHaveBeenCalled();
      error.mockRestore();
    });

    it('forwards the close code the stream ends with, and closing the phone closes the stream', async () => {
      const a = await stream('wc-7');
      await until(() => routes.peers.length === 1);
      routes.peers[0].close(1001, 'tab-closed');
      await until(() => a.closed() !== null);
      expect(a.closed()).toEqual({ code: 1001, reason: 'tab-closed' });
      await until(() => routes.closes === 1);

      const b = await stream('wc-7');
      await until(() => routes.peers.length === 2);
      b.ws.close();
      await until(() => routes.closes === 2);
    });

    it.each([
      ['a tab that is not a wc- id', '/api/browser-view/stream?tab=7'],
      ['an extra query parameter', '/api/browser-view/stream?tab=wc-7&x=1'],
      ['no tab', '/api/browser-view/stream'],
      ['a non-canonical path', '/api/browser-view/../browser-view/stream?tab=wc-7'],
      ['an upper-case path', '/API/browser-view/stream?tab=wc-7'],
      ['a doubled slash', '//api/browser-view/stream?tab=wc-7'],
      ['an encoded slash', '/api/browser-view%2fstream?tab=wc-7'],
      ['encoded dot segments', '/api/browser-view/%2e%2e/browser-view/stream?tab=wc-7'],
      ['two tabs', '/api/browser-view/stream?tab=wc-1&tab=wc-2'],
      ['a tab id with a leading zero', '/api/browser-view/stream?tab=wc-01'],
    ])('an upgrade with %s is 400', async (_name, target) => {
      const r = await rawExchange(handle.port, [upgrade(target, `Cookie: ${GOOD}\r\nOrigin: http://127.0.0.1\r\n`)]);
      expect(r.text).toMatch(/^HTTP\/1\.1 400/);
      expect(routes.openStream).not.toHaveBeenCalled();
    });

    it('stop() closes open streams', async () => {
      const s = await stream('wc-7');
      await until(() => routes.peers.length === 1);
      await handle.stop();
      await until(() => s.closed() !== null);
      await until(() => routes.closes === 1);
      handle = { ...handle, stop: async () => {} }; // already stopped
    });
  });

  describe('limits', () => {
    it('refuses a 3rd stream to one tab with 429, and takes one again after a close', async () => {
      const first = await stream('wc-7');
      await stream('wc-7');
      expect(await openStream(handle.port, 'wc-7', session)).toBe(429);
      first.ws.close();
      await until(() => first.closed() !== null);
      await new Promise((r) => setTimeout(r, 50));
      await stream('wc-7');
    });

    it('refuses a 5th stream in total with 429', async () => {
      for (const tab of ['wc-1', 'wc-2', 'wc-3', 'wc-4']) await stream(tab);
      expect(await openStream(handle.port, 'wc-5', session)).toBe(429);
    });
  });

  describe('revocation', () => {
    it('setSessionsNotBefore closes a stream with an older session, keeps a newer one, and releases the slot', async () => {
      const fresh = { cookie: `aionui-session=${jwtAt(3_000)}`, origin };
      const old = await stream('wc-7', { cookie: `aionui-session=${jwtAt(1_000)}`, origin });
      const kept = await stream('wc-7', fresh);
      await until(() => routes.peers.length === 2);
      expect(await openStream(handle.port, 'wc-7', fresh)).toBe(429);
      handle.setSessionsNotBefore(2_000_000);
      await until(() => old.closed() !== null);
      await until(() => routes.closes === 1);
      await new Promise((r) => setTimeout(r, 50));
      expect(kept.closed()).toBeNull();
      await stream('wc-7', fresh);
    });
  });

  describe('a reused keep-alive connection', () => {
    const FIRST = 'GET /api/auth/status HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n';
    const lastResponse = (text: string): string => text.slice(text.lastIndexOf('HTTP/1.1 '));
    const target = '/api/browser-view/stream?tab=wc-7';

    it('opens a stream through the internal-server upgrade path', async () => {
      const r = await rawExchange(
        handle.port,
        [FIRST, upgrade(target, `Cookie: ${GOOD}\r\nOrigin: http://127.0.0.1\r\n`)],
        { gapMs: 150, timeoutMs: 800 }
      );
      expect(r.text).toMatch(/^HTTP\/1\.1 200/);
      expect(lastResponse(r.text)).toMatch(/^HTTP\/1\.1 101/);
      expect(routes.openStream).toHaveBeenCalledWith('wc-7', expect.anything());
    });

    it('refuses a foreign Origin there too', async () => {
      const r = await rawExchange(
        handle.port,
        [FIRST, upgrade(target, `Cookie: ${GOOD}\r\nOrigin: https://evil.example\r\n`)],
        { gapMs: 150 }
      );
      expect(lastResponse(r.text)).toMatch(/^HTTP\/1\.1 403/);
      expect(routes.openStream).not.toHaveBeenCalled();
    });
  });
});

describe('browser-view stream re-validation', () => {
  let backend: FakeBackend;
  let routes: FakeRoutes;
  let handle: StaticServerHandle;

  beforeEach(async () => {
    // Before the server starts, so its session cache reads the fake clock too.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    backend = await startFakeBackend();
    routes = fakeRoutes();
    handle = await startStaticServer({
      staticDir: STATIC_DIR,
      backendPort: backend.port,
      port: 0,
      localRoutes: { browserView: routes },
    });
  });

  afterEach(async () => {
    vi.useRealTimers();
    await handle.stop();
    await backend.close();
  });

  const headers = (): Record<string, string> => ({ cookie: GOOD, origin: `http://127.0.0.1:${handle.port}` });
  const open = (opts: { autoPong?: boolean } = {}): Promise<Opened> =>
    opened(openStream(handle.port, 'wc-7', headers(), opts));
  const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 50));

  it('re-checks the session every 30 s and keeps a stream whose session is still good and answers pings', async () => {
    const s = await open();
    await until(() => routes.peers.length === 1);
    const calls = backend.authCalls;
    vi.advanceTimersByTime(30_000);
    await until(() => backend.authCalls === calls + 1);
    await settle();
    vi.advanceTimersByTime(30_000);
    await until(() => backend.authCalls === calls + 2);
    await settle();
    expect(s.closed()).toBeNull();
    s.ws.terminate();
  });

  it('closes the streams with 1008 when the session fails re-validation, releasing their slots', async () => {
    const a = await open();
    const b = await open();
    await until(() => routes.peers.length === 2);
    expect(await openStream(handle.port, 'wc-7', headers())).toBe(429);
    backend.authStatus(401);
    vi.advanceTimersByTime(29_999);
    await settle();
    expect(a.closed()).toBeNull();
    vi.advanceTimersByTime(1);
    await until(() => a.closed() !== null && b.closed() !== null);
    expect([a.closed()?.code, b.closed()?.code]).toEqual([1008, 1008]);
    await until(() => routes.closes === 2);
    backend.authStatus(null);
    await open();
  });

  it('closes the stream with 1008 when aioncore cannot answer the re-check', async () => {
    const s = await open();
    await until(() => routes.peers.length === 1);
    backend.authStatus(500);
    vi.advanceTimersByTime(30_000);
    await until(() => s.closed() !== null);
    expect(s.closed()?.code).toBe(1008);
  });

  it('terminates a phone that stops answering pings within two ticks, and releases its slot', async () => {
    const silent = await open({ autoPong: false });
    const live = await open();
    await until(() => routes.peers.length === 2);
    vi.advanceTimersByTime(30_000);
    await settle();
    expect(silent.closed()).toBeNull();
    vi.advanceTimersByTime(30_000);
    await until(() => silent.closed() !== null);
    await until(() => routes.closes === 1);
    await settle();
    expect(live.closed()).toBeNull();
    const again = await open();
    expect(again.ws.readyState).toBe(WebSocket.OPEN);
    live.ws.terminate();
    again.ws.terminate();
  });
});

describe('browser-view stream re-check against a real clock', () => {
  it('asks aioncore on every tick, not the 30 s session cache', async () => {
    // Date stays real: the session cache entry is still fresh when the next tick fires.
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const backend = await startFakeBackend();
    const routes = fakeRoutes();
    const handle = await startStaticServer({
      staticDir: STATIC_DIR,
      backendPort: backend.port,
      port: 0,
      localRoutes: { browserView: routes },
    });
    try {
      const s = await opened(
        openStream(handle.port, 'wc-7', { cookie: GOOD, origin: `http://127.0.0.1:${handle.port}` })
      );
      await until(() => routes.peers.length === 1);
      const calls = backend.authCalls;
      vi.advanceTimersByTime(30_000);
      await until(() => backend.authCalls === calls + 1);
      await new Promise((r) => setTimeout(r, 50));
      vi.advanceTimersByTime(30_000);
      await until(() => backend.authCalls === calls + 2);
      s.ws.terminate();
    } finally {
      vi.useRealTimers();
      await handle.stop();
      await backend.close();
    }
  });
});

describe('browser-view stream re-check that rejects', () => {
  it('closes the stream with 1008', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const routes = fakeRoutes();
    const streams = createBrowserViewStreams(routes, (socket) => socket.destroy());
    const server = http.createServer();
    server.on('upgrade', (req, socket, head) => {
      const headers = req.headers as Record<string, string>;
      const target = '/api/browser-view/stream?tab=wc-7';
      streams.accept(socket as Socket, target, headers, head, () => Promise.reject(new Error('down')));
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    const port = (server.address() as AddressInfo).port;
    try {
      const s = await opened(openStream(port, 'wc-7', { origin: `http://127.0.0.1:${port}` }));
      await until(() => routes.peers.length === 1);
      vi.advanceTimersByTime(30_000);
      await until(() => s.closed() !== null);
      expect(s.closed()?.code).toBe(1008);
    } finally {
      vi.useRealTimers();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

describe('browser-view routes not configured', () => {
  let backend: FakeBackend;
  let handle: StaticServerHandle;

  beforeEach(async () => {
    backend = await startFakeBackend();
    handle = await startStaticServer({ staticDir: STATIC_DIR, backendPort: backend.port, port: 0 });
  });

  afterEach(async () => {
    await handle.stop();
    await backend.close();
  });

  it('forwards GET /api/browser-view/tabs to aioncore', async () => {
    const r = await request(handle.port, 'GET', '/api/browser-view/tabs?conversation=conv-1', { cookie: GOOD });
    expect(r.status).toBe(200); // the fake echoes; aioncore answers 404
    expect(backend.seen.map((s) => s.url)).toEqual(['/api/browser-view/tabs?conversation=conv-1']);
  });

  it('keeps refusing a stream upgrade as outside the upgrade allowlist', async () => {
    const r = await rawExchange(handle.port, [
      upgrade('/api/browser-view/stream?tab=wc-7', `Cookie: ${GOOD}\r\nOrigin: http://127.0.0.1\r\n`),
    ]);
    expect(r.text).toMatch(/^HTTP\/1\.1 400/);
    expect(backend.seen).toHaveLength(0);
  });
});
