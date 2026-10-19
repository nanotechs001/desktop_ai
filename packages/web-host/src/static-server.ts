/**
 * WebUI static server.
 *
 * Serves out/renderer/ as the SPA and reverse-proxies /api/*, /ws, /api/stt/stream,
 * /login and /logout to aioncore. All auth goes to backend's aionui-auth crate;
 * /login and /logout are aionui-auth's top-level paths, the rest live under
 * /api/auth/*. /ws and /api/stt/stream are WebSocket/stream upgrades spliced at
 * TCP level; /api/stt/stream is the STT streaming endpoint.
 *
 * Auth gate: aioncore runs with `--local`, so this listener is what enforces
 * login. Every proxied request and upgrade is classified (auth-gate/), and those
 * that need a session are checked against aioncore `GET /api/auth/user` first.
 *
 * Design: Node native http + serve-handler. No Express. No business routes.
 */

import http, { type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { networkInterfaces } from 'node:os';
import net, { type Socket } from 'node:net';
import serveHandler from 'serve-handler';
import {
  classifyRequest,
  createSessionValidator,
  forwardingHeaders,
  GATE_LIMITS,
  isCanonicalPath,
  type SessionValidator,
} from './auth-gate/index.js';

export type StaticServerOptions = {
  staticDir: string;
  backendPort: number;
  port?: number;
  allowRemote?: boolean;
  /** True while the Cloudflare tunnel runs; only then is a loopback peer's Cf-Connecting-Ip trusted. */
  isTunnelActive?: () => boolean;
};

export type StaticServerHandle = {
  port: number;
  url: string;
  localUrl: string;
  networkUrl?: string;
  lanIP?: string;
  stop: () => Promise<void>;
};

const DEFAULT_PORT = 25808;

// Ranges that are non-internal IPv4 yet never a reachable LAN address, so we
// must never advertise them as the WebUI access URL even when they are the only
// non-loopback interface present:
//   169.254.0.0/16  link-local / APIPA (host got no DHCP lease)
//   198.18.0.0/15   RFC 2544 benchmarking range — handed out by utility tunnels
//                   such as Cloudflare WARP; this is the address that showed up
//                   on a multi-NIC machine instead of the real LAN IP.
const isUnreachableLanRange = (addr: string): boolean => addr.startsWith('169.254.') || /^198\.(18|19)\./.test(addr);

// Rank candidate LAN addresses by how likely they are the network the user
// actually reaches the desktop on. Lower is better. Private (RFC 1918) home /
// office ranges win over anything else; 192.168/16 is the most common LAN, then
// the 172.16/12 block, then 10/8 (frequently carved up by VPNs / corp routing).
const rankLanCandidate = (addr: string): number => {
  if (addr.startsWith('192.168.')) return 0;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(addr)) return 1;
  if (addr.startsWith('10.')) return 2;
  return 3;
};

// Pick the best LAN IPv4 to advertise. Pure over the interface map so it can be
// unit-tested against real multi-NIC layouts. Iterating and returning the first
// non-internal hit (the old behavior) picks whatever the OS lists first, which
// on a multi-NIC box can be a VPN / benchmark adapter rather than the LAN.
export function pickLanIP(nets: ReturnType<typeof networkInterfaces>): string | null {
  const candidates: string[] = [];
  for (const name of Object.keys(nets)) {
    for (const iface of nets[name] || []) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (isUnreachableLanRange(iface.address)) continue;
      candidates.push(iface.address);
    }
  }
  // Stable sort keeps OS interface order among equally-ranked addresses (e.g. a
  // physical NIC listed before a VPN when both are 10/8).
  candidates.sort((a, b) => rankLanCandidate(a) - rankLanCandidate(b));
  return candidates[0] ?? null;
}

function getLanIP(): string | null {
  return pickLanIP(networkInterfaces());
}

type Credentials = Parameters<SessionValidator>[0];

// How long an aioncore session check may take before we fail closed with 503.
const VALIDATE_TIMEOUT_MS = 5000;

const credentialsOf = (headers: Record<string, string>): Credentials => ({
  cookie: headers.cookie,
  authorization: headers.authorization,
});

/** `GET /api/auth/user` on aioncore with only the request's credentials; resolves the status code. */
function fetchAuthUser(backendPort: number): (creds: Credentials) => Promise<number> {
  return (creds) =>
    new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (creds.cookie) headers.cookie = creds.cookie;
      if (creds.authorization) headers.authorization = creds.authorization;
      const req = http.get(
        { hostname: '127.0.0.1', port: backendPort, path: '/api/auth/user', headers, agent: false },
        (res) => {
          res.resume();
          resolve(res.statusCode ?? 0);
        }
      );
      req.setTimeout(VALIDATE_TIMEOUT_MS, () => req.destroy(new Error('auth check timed out')));
      req.on('error', reject);
    });
}

function replyError(res: ServerResponse, status: number, error: string): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error }));
}

function forwardToBackend(
  req: IncomingMessage,
  res: ServerResponse,
  backendPort: number,
  headers: Record<string, string>,
  onStatus: (status: number) => void
): void {
  const options: http.RequestOptions = {
    hostname: '127.0.0.1',
    port: backendPort,
    path: req.url,
    method: req.method,
    headers: { ...headers, host: `127.0.0.1:${backendPort}` },
  };
  const proxy = http.request(options, (proxyRes) => {
    onStatus(proxyRes.statusCode ?? 502);
    res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxy.on('error', () => {
    if (!res.headersSent) {
      res.writeHead(502, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'BACKEND_UNREACHABLE' }));
    } else {
      res.destroy();
    }
  });
  req.pipe(proxy);
}

// Max bytes we peek before forcing a routing decision. An HTTP request-line
// on its own is typically < 100 bytes; a full header block is < 2 KB. If we
// haven't seen a newline after 4 KB the client is sending something weird —
// hand it to the internal HTTP server and let it return 400.
const PEEK_LIMIT_BYTES = 4096;

/**
 * Splice `client` to a TCP endpoint on `targetPort`. Any bytes already read
 * from `client` during peek are replayed to the upstream as the first write,
 * so the endpoint sees the full HTTP request as-sent.
 *
 * With `heldUntilUpgrade`, client bytes (starting with `heldUntilUpgrade`) only
 * flow once the upstream answers `101`: a request it does not upgrade cannot be
 * followed by a second, ungated request on the same raw connection.
 */
function spliceToTcpEndpoint(
  client: Socket,
  targetPort: number,
  initialBytes: Buffer,
  heldUntilUpgrade?: Buffer
): Socket {
  client.setNoDelay(true);
  client.setKeepAlive(true);
  client.setTimeout(0);
  // The peek phase left `client` in flowing mode (it had a 'data' listener),
  // but that listener is now removed and the real consumer — `client.pipe(upstream)`
  // — is only wired inside the async 'connect' handler below. Pause here so any
  // body bytes arriving in the gap are buffered by the socket instead of being
  // dropped for lack of a consumer; `pipe()` resumes the socket once connected.
  // Without this, large/buffered uploads (e.g. reverse-proxied POST bodies that
  // span multiple TCP segments) lose their tail bytes and the backend hangs
  // forever waiting for the missing Content-Length (issue #4058).
  client.pause();
  const upstream = net.connect({ host: '127.0.0.1', port: targetPort });
  upstream.setNoDelay(true);
  upstream.setKeepAlive(true);
  upstream.once('connect', () => {
    if (initialBytes.length > 0) upstream.write(initialBytes);
    if (heldUntilUpgrade) {
      relayAfterUpgrade(client, upstream, heldUntilUpgrade);
      return;
    }
    upstream.pipe(client);
    client.pipe(upstream);
  });
  const tearDown = (): void => {
    client.destroy();
    upstream.destroy();
  };
  upstream.on('error', tearDown);
  client.on('error', tearDown);
  upstream.on('close', tearDown);
  client.on('close', tearDown);
  return upstream;
}

// Longest upstream status line we wait for before deciding it is not a 101.
const STATUS_LINE_LIMIT_BYTES = 1024;

function relayAfterUpgrade(client: Socket, upstream: Socket, held: Buffer): void {
  let head = Buffer.alloc(0);
  const onFirstBytes = (chunk: Buffer): void => {
    head = Buffer.concat([head, chunk]);
    const newlineIdx = head.indexOf(0x0a);
    if (newlineIdx < 0 && head.length < STATUS_LINE_LIMIT_BYTES) return;
    upstream.off('data', onFirstBytes);
    client.write(head);
    const statusLine = head.subarray(0, Math.max(newlineIdx, 0)).toString('latin1');
    if (/^HTTP\/1\.[01] 101\b/.test(statusLine)) {
      if (held.length > 0) upstream.write(held);
      client.pipe(upstream);
    } else {
      upstream.end(); // not upgraded: the backend finishes this response and closes
    }
    upstream.pipe(client);
  };
  upstream.on('data', onFirstBytes);
}

const REFUSAL_REASONS: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  431: 'Request Header Fields Too Large',
  503: 'Service Unavailable',
};

/** Answer a raw connection with a bodiless status and close it; later client bytes are discarded. */
function refuseRaw(client: Socket, status: number): void {
  client.resume();
  client.end(`HTTP/1.1 ${status} ${REFUSAL_REASONS[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** Parse a raw header block (no trailing blank line). Null on anything a downstream parser could read differently. */
function parseHead(text: string): { requestLine: string; headers: Record<string, string[]> } | null {
  const [requestLine, ...fields] = text.split('\r\n');
  const headers: Record<string, string[]> = {};
  for (const line of fields) {
    const colon = line.indexOf(':');
    const name = line.slice(0, colon);
    // Rejects obs-fold (leading whitespace), bare CR/LF and NUL.
    if (colon <= 0 || !HEADER_NAME.test(name) || ['\r', '\n', '\0'].some((c) => line.includes(c))) return null;
    (headers[name.toLowerCase()] ??= []).push(line.slice(colon + 1).trim());
  }
  return { requestLine, headers };
}

/**
 * Decide routing from the first chunk of an incoming HTTP connection:
 *  - `true`  → `GET /ws[...] HTTP/1.x` or `GET /api/stt/stream[...] HTTP/1.x` (WebSocket/stream upgrades), splice to backend
 *  - `false` → any other HTTP method / path, hand to internal HTTP server
 *  - `null`  → need more bytes (no CRLF yet)
 *
 * Routing needs only the request-line. Upgrade routes then wait for the full
 * header block so the auth gate can check the session before any byte reaches
 * the backend; `Upgrade: websocket` is not required here (a request the backend
 * does not upgrade gets its response and the connection is closed).
 */
function peekWsRoute(buf: Buffer): boolean | null {
  const newlineIdx = buf.indexOf(0x0a); // \n
  if (newlineIdx < 0) return null;
  const firstLine = buf.slice(0, newlineIdx).toString('ascii');
  return /^GET\s+\/(?:ws|api\/stt\/stream)(?:\?[^\s]*)?\s+HTTP\/1\.[01]\r?$/.test(firstLine);
}

export async function startStaticServer(opts: StaticServerOptions): Promise<StaticServerHandle> {
  const port = opts.port ?? DEFAULT_PORT;
  const allowRemote = opts.allowRemote === true;
  const host = allowRemote ? '0.0.0.0' : '127.0.0.1';

  const isTunnelActive = opts.isTunnelActive ?? (() => false);
  const validate = createSessionValidator(fetchAuthUser(opts.backendPort));
  // Internal-server connections are local splices; map each one's local port back to the real client.
  const peers = new Map<number, string | undefined>();

  const proxyThroughGate = async (req: IncomingMessage, res: ServerResponse, url: string): Promise<void> => {
    const method = req.method ?? '';
    const decision = classifyRequest(method, url);
    if (decision === 'blocked') {
      replyError(res, 404, 'NOT_FOUND');
      return;
    }
    const peer = peers.get(req.socket.remotePort ?? -1) ?? req.socket.remoteAddress;
    const headers = forwardingHeaders(peer, req.headers, isTunnelActive());
    // Validate exactly the credentials aioncore will receive (a Connection-named cookie is gone from both).
    const creds = credentialsOf(headers);
    if (decision === 'auth') {
      const verdict = await validate(creds);
      if (verdict !== 'valid') {
        replyError(res, verdict === 'invalid' ? 401 : 503, verdict === 'invalid' ? 'UNAUTHORIZED' : 'AUTH_UNAVAILABLE');
        return;
      }
    }
    forwardToBackend(req, res, opts.backendPort, headers, (status) => {
      if (method === 'POST' && url === '/logout' && status >= 200 && status < 300) validate.invalidate(creds);
    });
  };

  // The HTTP server listens only on loopback — user traffic hits the outer
  // net.Server first. We route to this server for everything except WS
  // upgrades and STT stream upgrades, which go straight to the backend via a raw TCP splice.
  //
  // Why two listeners instead of using `http.Server`'s native `upgrade` event:
  // bun 1.3's http-compat layer does not faithfully forward writes on the
  // socket delivered to the `upgrade` handler, so the backend's 101 response
  // never reaches the browser (see #2824). Making the outer listener pure
  // TCP avoids touching that code path on both bun and node.
  const http_server: Server = http.createServer(async (req, res) => {
    try {
      if (!req.url || !req.method) {
        res.writeHead(400).end();
        return;
      }

      // R2: the gate and aioncore must never disagree on which route a path names.
      if ((req.url.startsWith('/api') || req.url.startsWith('/ws')) && !isCanonicalPath(req.url)) {
        replyError(res, 400, 'NON_CANONICAL_PATH');
        return;
      }

      // /api/* — reverse proxy to backend (includes /api/auth/*).
      // /login and /logout are aionui-auth's top-level auth endpoints: proxy them too
      // so WebUI browser clients reach the backend without a path-rewrite.
      if (req.url.startsWith('/api/') || req.url.startsWith('/api?') || req.url === '/login' || req.url === '/logout') {
        await proxyThroughGate(req, res, req.url);
        return;
      }

      // static files + SPA fallback
      await serveHandler(req, res, {
        public: opts.staticDir,
        rewrites: [{ source: '**', destination: '/index.html' }],
      });
    } catch (err) {
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'INTERNAL_ERROR' }));
      } else {
        res.destroy();
      }
    }
  });

  // Internal HTTP server — 127.0.0.1 ephemeral port, never visible to the user.
  await new Promise<void>((resolve, reject) => {
    http_server.once('error', reject);
    http_server.listen(0, '127.0.0.1', () => {
      http_server.off('error', reject);
      resolve();
    });
  });
  const internalPort = (http_server.address() as { port: number } | null)?.port;
  if (!internalPort) {
    throw new Error('internal HTTP server failed to bind to a port');
  }

  // User-facing listener: inspect the first line of every TCP connection and
  // route to either the backend (for /ws and /api/stt/stream upgrades) or the internal HTTP
  // server (everything else). Both routes use raw TCP splice — no reliance
  // on http.Server's upgrade event.
  // /ws and /api/stt/stream both need a session (classifyRequest gives 'auth'); the
  // peek regex only admits those exact canonical paths, so no R2 check is needed here.
  const gateUpgrade = async (client: Socket, peeked: Buffer, headEnd: number, peer?: string): Promise<void> => {
    client.on('error', () => client.destroy());
    const head = parseHead(peeked.subarray(0, headEnd).toString('latin1'));
    if (!head) {
      refuseRaw(client, 400);
      return;
    }
    const headers = forwardingHeaders(peer, head.headers, isTunnelActive());
    const verdict = await validate(credentialsOf(headers));
    if (client.destroyed) return;
    if (verdict !== 'valid') {
      refuseRaw(client, verdict === 'invalid' ? 401 : 503);
      return;
    }
    const fields = Object.entries(headers).map(([name, value]) => `${name}: ${value}\r\n`);
    const rewritten = Buffer.from(`${head.requestLine}\r\n${fields.join('')}\r\n`, 'latin1');
    spliceToTcpEndpoint(client, opts.backendPort, rewritten, peeked.subarray(headEnd + 4));
  };

  const tcp_server = net.createServer((client: Socket) => {
    const peer = client.remoteAddress;
    let peeked = Buffer.alloc(0);
    let wsRoute: boolean | null = null;
    let settled = false;
    const cleanup = (): void => {
      if (settled) return;
      settled = true;
      client.removeListener('data', onData);
      client.removeListener('error', onEarlyError);
      client.removeListener('end', onEarlyEnd);
    };
    const onData = (chunk: Buffer): void => {
      peeked = Buffer.concat([peeked, chunk]);
      if (wsRoute !== true) {
        wsRoute = peekWsRoute(peeked);
        if (wsRoute === null && peeked.length < PEEK_LIMIT_BYTES) return;
        if (wsRoute !== true) {
          cleanup();
          const upstream = spliceToTcpEndpoint(client, internalPort, peeked);
          upstream.once('connect', () => {
            const localPort = upstream.localPort;
            if (localPort === undefined) return;
            peers.set(localPort, peer);
            upstream.once('close', () => peers.delete(localPort));
          });
          return;
        }
      }
      // Upgrade routes: the whole header block must be in hand before deciding.
      const headEnd = peeked.indexOf('\r\n\r\n');
      if (headEnd < 0 && peeked.length <= GATE_LIMITS.headerMaxBytes) return;
      cleanup();
      client.pause();
      if (headEnd < 0 || headEnd + 4 > GATE_LIMITS.headerMaxBytes) {
        refuseRaw(client, 431);
        return;
      }
      void gateUpgrade(client, peeked, headEnd, peer);
    };
    const onEarlyError = (): void => {
      cleanup();
      client.destroy();
    };
    const onEarlyEnd = (): void => {
      // Client closed before we saw a request line — nothing to route.
      cleanup();
      client.destroy();
    };
    client.on('data', onData);
    client.on('error', onEarlyError);
    client.on('end', onEarlyEnd);
  });

  await new Promise<void>((resolve, reject) => {
    tcp_server.once('error', reject);
    tcp_server.listen(port, host, () => {
      tcp_server.off('error', reject);
      resolve();
    });
  });

  const actualPort = (tcp_server.address() as { port: number } | null)?.port ?? port;
  const lanIP = allowRemote ? (getLanIP() ?? undefined) : undefined;
  const localUrl = `http://127.0.0.1:${actualPort}`;
  const networkUrl = lanIP ? `http://${lanIP}:${actualPort}` : undefined;

  return {
    port: actualPort,
    url: networkUrl ?? localUrl,
    localUrl,
    networkUrl,
    lanIP,
    stop: () =>
      new Promise<void>((resolve) => {
        tcp_server.close(() => {
          http_server.close(() => resolve());
        });
      }),
  };
}

export async function stopStaticServer(handle: StaticServerHandle): Promise<void> {
  await handle.stop();
}
