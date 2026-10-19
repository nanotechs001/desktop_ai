/**
 * The WebUI listener must not let any request that needs a session reach aioncore without one.
 * Real TCP listener + a fake aioncore that answers /api/auth/user (200 for `aionui-session=good`),
 * echoes everything else with the headers it saw, and echoes raw bytes after a WebSocket upgrade.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';
import { startStaticServer, type StaticServerHandle } from '../src/static-server.js';

const STATIC_DIR = path.join(__dirname, 'fixtures', 'renderer');
const GOOD = 'aionui-session=good';

type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders };

type FakeBackend = {
  port: number;
  seen: Seen[]; // every request except /api/auth/user
  authCalls: number;
  bytes: () => number; // raw bytes received on all connections
  authStatus: (status: number | null) => void; // force a status for /api/auth/user
  close: () => Promise<void>;
};

async function startFakeBackend(): Promise<FakeBackend> {
  const seen: Seen[] = [];
  let authCalls = 0;
  let bytes = 0;
  let forced: number | null = null;
  let revoked = false;
  const sockets = new Set<net.Socket>();

  const server = http.createServer((req, res) => {
    if (req.url === '/api/auth/user') {
      authCalls += 1;
      const cookie = req.headers.cookie ?? '';
      // Like the live aioncore: a revoked session is 401, a garbage cookie or token is 400.
      const goodToken = /\.good\b/.test(cookie + (req.headers.authorization ?? '')); // see jwtFor()
      const status = cookie.includes(GOOD) || goodToken ? (revoked ? 401 : 200) : 400;
      res.writeHead(forced ?? status).end();
      return;
    }
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    if (req.method === 'POST' && req.url?.split('?')[0] === '/logout') revoked = true; // routes ignore the query
    req.resume();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ url: req.url, headers: req.headers }));
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('data', (d: Buffer) => (bytes += d.length));
    s.on('close', () => sockets.delete(s));
  });
  server.on('upgrade', (req, socket) => {
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n');
    socket.pipe(socket); // raw echo
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    port: (server.address() as AddressInfo).port,
    seen,
    get authCalls() {
      return authCalls;
    },
    bytes: () => bytes,
    authStatus: (s) => (forced = s),
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** Send raw bytes (one string per write, `gapMs` apart); resolve with everything received until close. */
function rawExchange(
  port: number,
  writes: string[],
  opts: { gapMs?: number; after101?: string; timeoutMs?: number } = {}
): Promise<{ text: string; closed: boolean }> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ host: '127.0.0.1', port });
    let text = '';
    let sentAfter = false;
    const timer = setTimeout(() => {
      sock.destroy();
      resolve({ text, closed: false });
    }, opts.timeoutMs ?? 1500);
    sock.on('connect', async () => {
      for (const [i, w] of writes.entries()) {
        if (i > 0 && opts.gapMs) await new Promise((r) => setTimeout(r, opts.gapMs));
        if (!sock.destroyed) sock.write(w);
      }
    });
    sock.on('data', (d: Buffer) => {
      text += d.toString('latin1');
      if (opts.after101 && !sentAfter && text.includes('\r\n\r\n') && text.startsWith('HTTP/1.1 101')) {
        sentAfter = true;
        sock.write(opts.after101);
      }
      if (opts.after101 && sentAfter && text.endsWith(opts.after101)) {
        clearTimeout(timer);
        sock.destroy();
        resolve({ text, closed: false });
      }
    });
    sock.on('close', () => {
      clearTimeout(timer);
      resolve({ text, closed: true });
    });
    sock.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
  });
}

function request(
  port: number,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

const upgrade = (route: string, extra = ''): string =>
  `GET ${route} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
  `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`;

describe('WebUI listener auth gate', () => {
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

  it('GET /api/agents without a cookie is 401 and never reaches the backend', async () => {
    const r = await request(handle.port, 'GET', '/api/agents');
    expect(r.status).toBe(401);
    expect(backend.seen).toHaveLength(0);
  });

  it('GET /api/agents with a good cookie reaches the backend with a trustworthy x-forwarded-for', async () => {
    const r = await request(handle.port, 'GET', '/api/agents', { cookie: GOOD, 'X-Forwarded-For': '1.2.3.4' });
    expect(r.status).toBe(200);
    expect(backend.seen.map((s) => s.url)).toEqual(['/api/agents']);
    expect(backend.seen[0].headers['x-forwarded-for']).toBe('127.0.0.1');
    expect(backend.seen[0].headers.cookie).toBe(GOOD);
  });

  it('a garbage cookie that aioncore answers with 400 is 401, not 503', async () => {
    const r = await request(handle.port, 'GET', '/api/agents', { cookie: 'aionui-session=garbage' });
    expect(r.status).toBe(401);
    expect(backend.authCalls).toBe(1);
  });

  it('a bad cookie is 401', async () => {
    const r = await request(handle.port, 'GET', '/api/agents', { cookie: 'aionui-session=bad' });
    expect(r.status).toBe(401);
    expect(backend.seen).toHaveLength(0);
  });

  it('POST /api/webui/reset-password is 404 even with a good cookie, and never reaches the backend', async () => {
    const r = await request(handle.port, 'POST', '/api/webui/reset-password', { cookie: GOOD });
    expect(r.status).toBe(404);
    expect(backend.seen).toHaveLength(0);
    expect(backend.authCalls).toBe(0);
  });

  it('POST /login without a cookie reaches the backend', async () => {
    const r = await request(handle.port, 'POST', '/login', { 'content-type': 'application/json' });
    expect(r.status).toBe(200);
    expect(backend.seen.map((s) => `${s.method} ${s.url}`)).toEqual(['POST /login']);
  });

  it('GET / serves the SPA', async () => {
    const r = await request(handle.port, 'GET', '/');
    expect(r.status).toBe(200);
    expect(r.body).toContain('<title>equiv</title>');
  });

  it('aioncore failing /api/auth/user (500) gives 503', async () => {
    backend.authStatus(500);
    const r = await request(handle.port, 'GET', '/api/agents', { cookie: GOOD });
    expect(r.status).toBe(503);
    expect(backend.seen).toHaveLength(0);
  });

  it('non-canonical /api paths are 400 and never reach the backend (R2)', async () => {
    const paths = ['/api/webui/../agents', '/api/%2e%2e/webui/x', '/api//agents', '/api/a%2fb', '/api/./agents'];
    const results = await Promise.all(paths.map((p) => request(handle.port, 'GET', p, { cookie: GOOD })));
    expect(results.map((r) => r.status)).toEqual(paths.map(() => 400));
    expect(backend.seen).toHaveLength(0);
    expect(backend.authCalls).toBe(0);
  });

  it('a Connection header naming cookie cannot strip the validated credential', async () => {
    const r = await rawExchange(handle.port, [
      `GET /api/agents HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${GOOD}\r\nConnection: close, cookie\r\n\r\n`,
    ]);
    expect(r.text).toMatch(/^HTTP\/1\.1 401/);
    expect(backend.seen).toHaveLength(0);
  });

  it('a 2xx POST /logout drops the cached session', async () => {
    expect((await request(handle.port, 'GET', '/api/agents', { cookie: GOOD })).status).toBe(200);
    expect((await request(handle.port, 'POST', '/logout', { cookie: GOOD })).status).toBe(200);
    expect((await request(handle.port, 'GET', '/api/agents', { cookie: GOOD })).status).toBe(401);
  });

  it('POST /logout with a query string still drops the cached session', async () => {
    expect((await request(handle.port, 'GET', '/api/agents', { cookie: GOOD })).status).toBe(200);
    expect((await request(handle.port, 'POST', '/logout?next=%2F', { cookie: GOOD })).status).toBe(200);
    expect(backend.seen.map((s) => s.url)).toContain('/logout?next=%2F');
    expect((await request(handle.port, 'GET', '/api/agents', { cookie: GOOD })).status).toBe(401);
  });

  it('logout drops the session even when other cookies differ', async () => {
    const withTheme = { cookie: `theme=dark; ${GOOD}` };
    expect((await request(handle.port, 'GET', '/api/agents', withTheme)).status).toBe(200);
    expect((await request(handle.port, 'POST', '/logout', { cookie: GOOD })).status).toBe(200);
    expect((await request(handle.port, 'GET', '/api/agents', withTheme)).status).toBe(401);
  });

  describe('strict request line on the raw upgrade path', () => {
    const tail = `Host: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: ${GOOD}\r\n\r\n`;
    const cases: Array<[string, string]> = [
      ['bare-LF request line hiding a spoofed header', `GET /ws HTTP/1.1\nX-Forwarded-For: 6.6.6.6\r\n${tail}`],
      [
        'bare-LF request line hiding a pipelined request',
        `GET /ws HTTP/1.1\nPOST /api/webui/reset-password HTTP/1.1\r\n${tail}`,
      ],
      ['tab separator', `GET\t/ws HTTP/1.1\r\n${tail}`],
      ['double space', `GET  /ws HTTP/1.1\r\n${tail}`],
      ['HTTP/1.0', `GET /ws HTTP/1.0\r\n${tail}`],
      ['lowercase method', `get /ws HTTP/1.1\r\n${tail}`],
      ['bare LF inside the headers', `GET /api/stt/stream HTTP/1.1\r\nHost: x\nX-Forwarded-For: 6.6.6.6\r\n${tail}`],
      ['bare CR inside the headers', `GET /ws HTTP/1.1\r\nHost: x\rX-Evil: 1\r\n${tail}`],
    ];
    for (const [name, raw] of cases) {
      it(`refuses ${name} with 400, and the backend gets zero bytes`, async () => {
        const r = await rawExchange(handle.port, [raw]);
        expect(r.text).toMatch(/^HTTP\/1\.1 400/);
        expect(r.closed).toBe(true);
        expect(backend.bytes()).toBe(0);
      });
    }

    it('forwards a request line rebuilt from its parsed parts', async () => {
      const r = await rawExchange(handle.port, [`GET /ws?x=1 HTTP/1.1\r\n${tail}`], { after101: 'ok' });
      expect(r.text).toMatch(/^HTTP\/1\.1 101/);
      expect(backend.seen[0].url).toBe('/ws?x=1');
    });
  });

  for (const route of ['/ws', '/api/stt/stream']) {
    describe(route, () => {
      it('an upgrade without a cookie gets 401, is closed, and the backend gets zero bytes', async () => {
        const r = await rawExchange(handle.port, [upgrade(route)]);
        expect(r.text).toMatch(/^HTTP\/1\.1 401/);
        expect(r.closed).toBe(true);
        expect(backend.bytes()).toBe(0);
      });

      it('an upgrade with a good cookie is piped and echoes', async () => {
        const r = await rawExchange(handle.port, [upgrade(route, `Cookie: ${GOOD}\r\nX-Forwarded-For: 6.6.6.6\r\n`)], {
          after101: 'ping-frame',
        });
        expect(r.text).toMatch(/^HTTP\/1\.1 101/);
        expect(r.text.endsWith('ping-frame')).toBe(true);
        expect(backend.seen[0].url).toBe(route);
        expect(backend.seen[0].headers['x-forwarded-for']).toBe('127.0.0.1');
      });

      it('a header block split across 3 writes 20 ms apart is still authed', async () => {
        const full = upgrade(route, `Cookie: ${GOOD}\r\n`);
        const third = Math.ceil(full.length / 3);
        const parts = [full.slice(0, third), full.slice(third, 2 * third), full.slice(2 * third)];
        const r = await rawExchange(handle.port, parts, { gapMs: 20, after101: 'hello' });
        expect(r.text).toMatch(/^HTTP\/1\.1 101/);

        const denied = upgrade(route);
        const t = Math.ceil(denied.length / 3);
        const r2 = await rawExchange(handle.port, [denied.slice(0, t), denied.slice(t, 2 * t), denied.slice(2 * t)], {
          gapMs: 20,
        });
        expect(r2.text).toMatch(/^HTTP\/1\.1 401/);
      });

      it('more than 16 KiB without a header end is refused', async () => {
        const r = await rawExchange(handle.port, [
          `GET ${route} HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${GOOD}\r\nX-Pad: ${'a'.repeat(17 * 1024)}`,
        ]);
        expect(r.text).toMatch(/^HTTP\/1\.1 431/);
        expect(r.closed).toBe(true);
        expect(backend.bytes()).toBe(0);
      });
    });
  }

  it('the real browser client upgrade shape passes when logged in', async () => {
    // What Chrome sends for `new WebSocket(`${proto}//${location.host}/ws`)` (browser.ts / httpBridge.ts):
    // no token in the URL or subprotocol; the same-origin aionui-session cookie authenticates it.
    const chrome =
      'GET /ws HTTP/1.1\r\n' +
      `Host: 192.168.1.20:${handle.port}\r\n` +
      'Connection: Upgrade\r\n' +
      'Pragma: no-cache\r\n' +
      'Cache-Control: no-cache\r\n' +
      'User-Agent: Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/130.0 Safari/537.36\r\n' +
      'Upgrade: websocket\r\n' +
      `Origin: http://192.168.1.20:${handle.port}\r\n` +
      'Sec-WebSocket-Version: 13\r\n' +
      'Accept-Encoding: gzip, deflate\r\n' +
      'Accept-Language: en-US,en;q=0.9\r\n' +
      `Cookie: theme=dark; ${GOOD}\r\n` +
      'Sec-WebSocket-Key: x3JJHMbDL1EzLkh9GBhXDw==\r\n' +
      'Sec-WebSocket-Extensions: permessage-deflate; client_max_window_bits\r\n' +
      '\r\n';
    const r = await rawExchange(handle.port, [chrome], { after101: 'frame' });
    expect(r.text).toMatch(/^HTTP\/1\.1 101/);
    const h = backend.seen[0].headers;
    expect(h.upgrade).toBe('websocket');
    expect(h.connection).toBe('Upgrade');
    expect(h.origin).toBe(`http://192.168.1.20:${handle.port}`);
    expect(h['sec-websocket-key']).toBe('x3JJHMbDL1EzLkh9GBhXDw==');
  });

  it('a /ws request the backend does not upgrade cannot smuggle a second request', async () => {
    const r = await rawExchange(handle.port, [
      `GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${GOOD}\r\n\r\n` +
        `POST /api/webui/reset-password HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Length: 0\r\n\r\n`,
    ]);
    expect(r.text).toMatch(/^HTTP\/1\.1 200/);
    expect(backend.seen.map((s) => s.url)).toEqual(['/ws']);
  });
});

describe('WebUI listener timeouts', () => {
  let backend: FakeBackend;
  let handle: StaticServerHandle;

  beforeEach(async () => {
    backend = await startFakeBackend();
    handle = await startStaticServer({
      staticDir: STATIC_DIR,
      backendPort: backend.port,
      port: 0,
      timeouts: { headerMs: 200, refuseLingerMs: 200 },
    });
  });

  afterEach(async () => {
    await handle.stop();
    await backend.close();
  });

  it('closes a connection that never sends anything', async () => {
    const r = await rawExchange(handle.port, []);
    expect(r).toEqual({ text: '', closed: true });
  });

  it('closes an upgrade whose header block never ends, without reaching the backend', async () => {
    const r = await rawExchange(handle.port, [`GET /ws HTTP/1.1\r\nHost: 127.0.0.1\r\nCookie: ${GOOD}\r\n`]);
    expect(r).toEqual({ text: '', closed: true });
    expect(backend.bytes()).toBe(0);
  });

  it('closes a refused socket after the linger timeout even if the client keeps it half-open', async () => {
    const sock = net.connect({ host: '127.0.0.1', port: handle.port, allowHalfOpen: true });
    sock.on('error', () => {});
    const got = await new Promise<string>((resolve) => {
      sock.on('connect', () => sock.write(upgrade('/ws')));
      sock.once('data', (d: Buffer) => resolve(d.toString('latin1'))); // read the 401, never end our side
    });
    expect(got).toMatch(/^HTTP\/1\.1 401/);
    // The listener only finishes stopping once every connection is gone, so this shows the server dropped it.
    const outcome = await Promise.race([
      handle.stop().then(() => 'stopped'),
      new Promise((r) => setTimeout(() => r('still open'), 1000)),
    ]);
    sock.destroy();
    expect(outcome).toBe('stopped');
  });

  it('does not time out a piped upgrade', async () => {
    const r = await rawExchange(handle.port, [upgrade('/ws', `Cookie: ${GOOD}\r\n`)], { timeoutMs: 600 });
    expect(r.text).toMatch(/^HTTP\/1\.1 101/);
    expect(r.closed).toBe(false);
  });
});

describe('WebUI listener peer address', () => {
  it('refuses a connection whose remote address is unknown', async () => {
    const createServer = vi.spyOn(net, 'createServer');
    const backend = await startFakeBackend();
    const handle = await startStaticServer({ staticDir: STATIC_DIR, backendPort: backend.port, port: 0 });
    const onConnection = createServer.mock.calls[0][0] as unknown as (socket: net.Socket) => void;
    createServer.mockRestore();
    const fake = { remoteAddress: undefined, destroy: vi.fn(), on: vi.fn(), setTimeout: vi.fn() };
    onConnection(fake as unknown as net.Socket);
    expect(fake.destroy).toHaveBeenCalled();
    expect(fake.on).not.toHaveBeenCalledWith('data', expect.anything());
    await handle.stop();
    await backend.close();
  });
});

describe('WebUI listener sessionsNotBefore', () => {
  const NOT_BEFORE_S = 2_000_000_000; // seconds; setSessionsNotBefore takes ms
  // aioncore (fake) accepts any token whose signature segment is "good"; the gate only reads iat.
  const jwtFor = (iatSeconds: number | null, refresh = false): string =>
    `e30.${Buffer.from(JSON.stringify(iatSeconds === null ? { r: refresh } : { iat: iatSeconds })).toString('base64url')}.good`;
  const OLD = jwtFor(NOT_BEFORE_S - 1);
  const NEW = jwtFor(NOT_BEFORE_S);
  let backend: FakeBackend;
  let handle: StaticServerHandle;

  beforeEach(async () => {
    backend = await startFakeBackend();
    handle = await startStaticServer({
      staticDir: STATIC_DIR,
      backendPort: backend.port,
      port: 0,
      sessionsNotBefore: NOT_BEFORE_S * 1000,
    });
  });

  afterEach(async () => {
    await handle.stop();
    await backend.close();
  });

  it('refuses a cookie issued before not-before, and lets a newer one through', async () => {
    const stale = await request(handle.port, 'GET', '/api/agents', { cookie: `aionui-session=${OLD}` });
    expect(stale.status).toBe(401);
    expect(backend.seen).toHaveLength(0);
    const fresh = await request(handle.port, 'GET', '/api/agents', { cookie: `aionui-session=${NEW}` });
    expect(fresh.status).toBe(200);
  });

  it('refuses a Bearer token issued before not-before, and lets a newer one through', async () => {
    expect((await request(handle.port, 'GET', '/api/agents', { authorization: `Bearer ${OLD}` })).status).toBe(401);
    expect((await request(handle.port, 'GET', '/api/agents', { authorization: `Bearer ${NEW}` })).status).toBe(200);
    expect(backend.seen).toHaveLength(1);
  });

  it('refuses a malformed token and one without iat while not-before is set', async () => {
    for (const token of ['garbage.good', jwtFor(null)]) {
      const r = await request(handle.port, 'GET', '/api/agents', { cookie: `aionui-session=${token}` });
      expect(r.status).toBe(401);
    }
    expect(backend.seen).toHaveLength(0);
  });

  it('refuses a WebSocket upgrade with an old cookie and accepts one with a new cookie', async () => {
    const old = await rawExchange(handle.port, [upgrade('/ws', `Cookie: aionui-session=${OLD}\r\n`)]);
    expect(old.text.startsWith('HTTP/1.1 401')).toBe(true);
    expect(backend.seen).toHaveLength(0);
    const fresh = await rawExchange(handle.port, [upgrade('/ws', `Cookie: aionui-session=${NEW}\r\n`)]);
    expect(fresh.text.startsWith('HTTP/1.1 101')).toBe(true);
  });

  it('refuses an old refresh cookie without forwarding it, and forwards a new one', async () => {
    const stale = await request(handle.port, 'POST', '/api/auth/refresh', { cookie: `aionui-refresh=${OLD}` });
    expect(stale.status).toBe(401);
    const none = await request(handle.port, 'POST', '/api/auth/refresh');
    expect(none.status).toBe(401);
    expect(backend.seen).toHaveLength(0);
    const fresh = await request(handle.port, 'POST', '/api/auth/refresh', { cookie: `aionui-refresh=${NEW}` });
    expect(fresh.status).toBe(200);
    expect(backend.seen.map((s) => s.url)).toEqual(['/api/auth/refresh']);
  });

  it('keeps login, logout and status open', async () => {
    expect((await request(handle.port, 'POST', '/login')).status).toBe(200);
    expect((await request(handle.port, 'GET', '/api/auth/status')).status).toBe(200);
  });

  it('setSessionsNotBefore applies at once, clears the validator cache, and null turns it off', async () => {
    const cookie = `aionui-session=${OLD}`;
    handle.setSessionsNotBefore(null);
    expect((await request(handle.port, 'GET', '/api/agents', { cookie })).status).toBe(200);
    expect((await request(handle.port, 'GET', '/api/agents', { cookie })).status).toBe(200);
    expect(backend.authCalls).toBe(1); // second hit served from the cache
    handle.setSessionsNotBefore(NOT_BEFORE_S * 1000);
    expect((await request(handle.port, 'GET', '/api/agents', { cookie })).status).toBe(401);
    handle.setSessionsNotBefore(null);
    expect((await request(handle.port, 'GET', '/api/agents', { cookie })).status).toBe(200);
    expect(backend.authCalls).toBe(2); // cache was cleared by the setter
  });
});

describe('WebUI listener credential bytes (R8)', () => {
  const FRESH_REFRESH = `e30.${Buffer.from(JSON.stringify({ iat: 3_000_000_000 })).toString('base64url')}.good`;
  let backend: FakeBackend;
  let handle: StaticServerHandle;

  beforeEach(async () => {
    backend = await startFakeBackend();
    handle = await startStaticServer({
      staticDir: STATIC_DIR,
      backendPort: backend.port,
      port: 0,
      sessionsNotBefore: 2_000_000_000_000,
    });
  });

  afterEach(async () => {
    await handle.stop();
    await backend.close();
  });

  it('a non-ASCII cookie byte beside a forged fresh refresh cookie is 400 and never forwarded', async () => {
    const r = await request(handle.port, 'POST', '/api/auth/refresh', {
      cookie: `aionui-refresh=${FRESH_REFRESH}; x=\xe9`,
    });
    expect(r.status).toBe(400);
    expect(backend.seen).toHaveLength(0);
  });

  it('is 400 on an /api route, for a cookie and for an Authorization header, valid session or not', async () => {
    const cookie = await request(handle.port, 'GET', '/api/agents', { cookie: `${GOOD}; x=\xe9` });
    expect(cookie.status).toBe(400);
    const auth = await request(handle.port, 'GET', '/api/agents', { authorization: 'Bearer a\xe9' });
    expect(auth.status).toBe(400);
    expect(backend.seen).toHaveLength(0);
    expect(backend.authCalls).toBe(0);
  });

  it('is 400 on an open route too (POST /login)', async () => {
    const r = await request(handle.port, 'POST', '/login', { cookie: 'x=\xe9' });
    expect(r.status).toBe(400);
    expect(backend.seen).toHaveLength(0);
  });

  it.each(['/ws', '/api/stt/stream'])('refuses an upgrade on %s with a non-ASCII cookie byte', async (route) => {
    const r = await rawExchange(handle.port, [upgrade(route, `Cookie: aionui-session=${FRESH_REFRESH}; x=\xe9\r\n`)]);
    expect(r.text.startsWith('HTTP/1.1 400')).toBe(true);
    expect(backend.seen).toHaveLength(0);
  });

  it('an upgrade with a non-ASCII Authorization byte is 400', async () => {
    const r = await rawExchange(handle.port, [upgrade('/ws', 'Authorization: Bearer a\xe9\r\n')]);
    expect(r.text.startsWith('HTTP/1.1 400')).toBe(true);
  });

  it('a plain ASCII cookie still works', async () => {
    const r = await request(handle.port, 'GET', '/api/agents', {
      cookie: `aionui-session=${FRESH_REFRESH}; theme=dark`,
    });
    expect(r.status).toBe(200);
  });

  it('refuses an /api/stt/stream upgrade with an old cookie', async () => {
    const old = `e30.${Buffer.from(JSON.stringify({ iat: 1 })).toString('base64url')}.good`;
    const r = await rawExchange(handle.port, [upgrade('/api/stt/stream', `Cookie: aionui-session=${old}\r\n`)]);
    expect(r.text.startsWith('HTTP/1.1 401')).toBe(true);
    expect(backend.seen).toHaveLength(0);
  });
});

describe('WebUI listener open sockets', () => {
  const jwtAt = (iat: number): string => `e30.${Buffer.from(JSON.stringify({ iat })).toString('base64url')}.good`;
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

  /** Open an upgraded socket; resolves once the 101 arrives. `closed()` reports whether it has closed. */
  async function openSocket(route: string, token: string): Promise<{ closed: () => boolean; sock: net.Socket }> {
    const sock = net.connect({ host: '127.0.0.1', port: handle.port });
    let closed = false;
    sock.on('close', () => (closed = true));
    sock.on('error', () => {});
    let text = '';
    const opened = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no 101')), 2000);
      sock.on('data', (d: Buffer) => {
        text += d.toString('latin1');
        if (text.startsWith('HTTP/1.1 101') && text.includes('\r\n\r\n')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    sock.write(upgrade(route, `Cookie: aionui-session=${token}\r\n`));
    await opened;
    return { closed: () => closed, sock };
  }

  const settle = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

  it.each(['/ws', '/api/stt/stream'])('closes an open %s with an old token when not-before is set', async (route) => {
    const old = await openSocket(route, jwtAt(1_000));
    const fresh = await openSocket(route, jwtAt(3_000));
    await settle(50);
    handle.setSessionsNotBefore(2_000_000);
    await settle(200);
    expect(old.closed()).toBe(true);
    expect(fresh.closed()).toBe(false);
    fresh.sock.destroy();
  });

  it('leaves open sockets alone when not-before is cleared, and forgets sockets that closed', async () => {
    const a = await openSocket('/ws', jwtAt(1_000));
    handle.setSessionsNotBefore(null);
    await settle(100);
    expect(a.closed()).toBe(false);
    a.sock.destroy();
    await settle(100);
    expect(() => handle.setSessionsNotBefore(2_000_000)).not.toThrow();
  });
});

describe('WebUI listener without sessionsNotBefore', () => {
  it("keeps today's behaviour: a malformed token that aioncore accepts passes", async () => {
    const backend = await startFakeBackend();
    const handle = await startStaticServer({ staticDir: STATIC_DIR, backendPort: backend.port, port: 0 });
    try {
      expect((await request(handle.port, 'GET', '/api/agents', { cookie: GOOD })).status).toBe(200);
      expect((await request(handle.port, 'POST', '/api/auth/refresh', {})).status).toBe(200);
    } finally {
      await handle.stop();
      await backend.close();
    }
  });
});
