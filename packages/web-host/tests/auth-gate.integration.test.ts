/**
 * The WebUI listener must not let any request that needs a session reach aioncore without one.
 * Real TCP listener + a fake aioncore that answers /api/auth/user (200 for `aionui-session=good`),
 * echoes everything else with the headers it saw, and echoes raw bytes after a WebSocket upgrade.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
      const ok = !revoked && (req.headers.cookie ?? '').includes(GOOD);
      res.writeHead(forced ?? (ok ? 200 : 401)).end();
      return;
    }
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    if (req.method === 'POST' && req.url === '/logout') revoked = true;
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
