/**
 * A fake aioncore for the WebUI listener tests, and raw/HTTP client helpers. It answers /api/auth/user
 * (200 for `aionui-session=good`), echoes everything else with the headers it saw, and echoes raw bytes
 * after a WebSocket upgrade.
 */

import http from 'node:http';
import net, { type AddressInfo } from 'node:net';
import path from 'node:path';

export const STATIC_DIR = path.join(__dirname, 'renderer');
export const GOOD = 'aionui-session=good';

export type Seen = { method: string; url: string; headers: http.IncomingHttpHeaders };

export type FakeBackend = {
  port: number;
  seen: Seen[]; // every request except /api/auth/user
  authCalls: number;
  bytes: () => number; // raw bytes received on all connections
  authStatus: (status: number | null) => void; // force a status for /api/auth/user
  holdAuth: () => { waiting: () => number; release: () => void }; // delay /api/auth/user answers until release()
  close: () => Promise<void>;
};

export async function startFakeBackend(): Promise<FakeBackend> {
  const seen: Seen[] = [];
  let authCalls = 0;
  let bytes = 0;
  let forced: number | null = null;
  let held: Array<() => void> | null = null;
  let revoked = false;
  const sockets = new Set<net.Socket>();

  const server = http.createServer((req, res) => {
    if (req.url === '/api/auth/user') {
      authCalls += 1;
      const cookie = req.headers.cookie ?? '';
      // Like the live aioncore: a revoked session is 401, a garbage cookie or token is 400.
      const goodToken = /\.good\b/.test(cookie + (req.headers.authorization ?? '')); // see jwtFor()
      const status = cookie.includes(GOOD) || goodToken ? (revoked ? 401 : 200) : 400;
      const answer = (): void => void res.writeHead(forced ?? status).end();
      if (held) held.push(answer);
      else answer();
      return;
    }
    seen.push({ method: req.method ?? '', url: req.url ?? '', headers: req.headers });
    if (req.method === 'POST' && req.url?.split('?')[0] === '/logout') revoked = true; // routes ignore the query
    req.resume();
    const setCookie =
      req.url === '/login'
        ? { 'set-cookie': ['aionui-session=s; HttpOnly; Path=/', 'aionui-refresh=r; Path=/; secure'] }
        : {};
    res.writeHead(200, { 'content-type': 'application/json', ...setCookie });
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
    holdAuth: () => {
      const queue: Array<() => void> = [];
      held = queue;
      return {
        waiting: () => queue.length,
        release: () => {
          held = null;
          for (const answer of queue.splice(0)) answer();
        },
      };
    },
    close: () =>
      new Promise<void>((r) => {
        for (const s of sockets) s.destroy();
        server.close(() => r());
      }),
  };
}

/** Send raw bytes (one string per write, `gapMs` apart); resolve with everything received until close. */
export function rawExchange(
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
      if (opts.after101 && !sentAfter && /HTTP\/1\.1 101 [^]*?\r\n\r\n/.test(text)) {
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

export function request(
  port: number,
  method: string,
  urlPath: string,
  headers: Record<string, string> = {}
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, headers, agent: false }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c: string) => (body += c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
    });
    req.on('error', reject);
    req.end();
  });
}

export const upgrade = (route: string, extra = ''): string =>
  `GET ${route} HTTP/1.1\r\nHost: 127.0.0.1\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
  `Sec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n${extra}\r\n`;
