/**
 * The WebUI's live view of the desktop's agent browser tabs, answered by the listener itself after the auth gate:
 * `GET /api/browser-view/tabs?conversation=<id>` and the `/api/browser-view/stream?tab=<id>` WebSocket. Both must
 * be same-origin (isSameOriginFetch for the tabs route; the WebSocket needs a matching `Origin`). Messages are
 * carried as-is; the desktop's BrowserViewService parses them. Also the chat's risky-action asks:
 * `GET /api/browser-view/confirms?conversation=<id>` (same rule as tabs) and `POST /api/browser-view/confirms/<id>`
 * (a matching `Origin` required).
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import { z } from 'zod';
import { normalizePath } from './auth-gate/index.js';
import type { BrowserConfirmRoutes, BrowserViewPeer, BrowserViewRoutes, BrowserViewStreamHandle } from './types.js';

export const TABS_PATH = '/api/browser-view/tabs';
export const STREAM_PATH = '/api/browser-view/stream';
export const CONFIRMS_PATH = '/api/browser-view/confirms';
/** One answer: the desktop's confirm ids are UUIDs. */
const CONFIRM_ANSWER_PATH =
  /^\/api\/browser-view\/confirms\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/;
const MAX_ANSWER_BYTES = 1024;
const ANSWER_BODY = z.object({ allow: z.boolean(), always: z.boolean() }).strict();
/** Anything a lenient parser could read as a request line for the stream route. */
export const STREAM_ROUTE_LIKE = /^\S+\s+\/api\/browser-view\/stream(?:[?\s]|$)/i;
/** The only stream upgrade request line: exactly one `tab`, a relay target id. */
export const STREAM_REQUEST_LINE = /^GET (\/api\/browser-view\/stream)(\?tab=wc-(?:0|[1-9]\d{0,8})) HTTP\/1\.1$/;

const MAX_STREAMS_PER_TAB = 2;
const MAX_STREAMS = 4;
/** Session re-check and heartbeat interval: a phone that misses a ping is terminated on the next tick. */
const REVALIDATE_MS = 30_000;
const MAX_PAYLOAD_BYTES = 64 * 1024;
/** Messages the phone sends (its `hello` first) while the desktop is still attaching to the tab. */
const MAX_EARLY_MESSAGES = 16;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,64}$/;
const CLOSE_CODES = { 'tab-closed': 1001, 'not-allowed': 1008 } as const;
const POLICY_VIOLATION = 1008;
const INTERNAL_ERROR = 1011;

type Headers = Record<string, string | string[] | undefined>;

/** True when `Origin` is an http(s) origin whose host:port equals the `Host` header, case-insensitively. */
export function isSameOrigin(headers: Headers): boolean {
  const { origin, host } = headers;
  if (typeof origin !== 'string' || typeof host !== 'string') return false;
  try {
    const url = new URL(origin);
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.host === host.toLowerCase();
  } catch {
    return false;
  }
}

/**
 * R4: the tabs route is a same-origin `fetch` GET, which browsers send without `Origin`. A present `Origin` must
 * match (it wins over `Sec-Fetch-Site`); an absent one needs `Sec-Fetch-Site: same-origin`.
 */
export function isSameOriginFetch(headers: Headers): boolean {
  if (headers.origin !== undefined) return isSameOrigin(headers);
  return headers['sec-fetch-site'] === 'same-origin';
}

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** The one valid `conversation` query parameter of `url`, or null. */
const conversationOf = (url: string): string | null => {
  const ids = new URL(url, 'http://localhost').searchParams.getAll('conversation');
  return ids.length === 1 && CONVERSATION_ID.test(ids[0]) ? ids[0] : null;
};

/** The tabs route, for a request the auth gate already passed. */
export function serveTabs(req: IncomingMessage, res: ServerResponse, url: string, routes: BrowserViewRoutes): void {
  if (!isSameOriginFetch(req.headers)) return reply(res, 403, { error: 'FORBIDDEN_ORIGIN' });
  if (req.method !== 'GET') return reply(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const id = conversationOf(url);
  if (id === null) return reply(res, 400, { error: 'BAD_CONVERSATION' });
  reply(res, 200, { tabs: routes.listTabs(id) });
}

/** True for the confirm list and anything under it (answers, and paths that are neither: 404 here, never aioncore). */
export const isConfirmsPath = (path: string): boolean => path === CONFIRMS_PATH || path.startsWith(`${CONFIRMS_PATH}/`);

/**
 * The body as text, or null once it passes `max` bytes. A declared oversize body is drained; a chunked one that grows
 * past `max` is cut off (the request destroyed), so a sender cannot keep the socket reading forever.
 */
function readBody(req: IncomingMessage, max: number): Promise<string | null> {
  return new Promise((resolve, reject) => {
    if (Number(req.headers['content-length'] ?? 0) > max) {
      req.resume();
      return resolve(null);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size <= max) return void chunks.push(chunk);
      req.destroy();
      resolve(null);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const parseAnswer = (text: string): z.infer<typeof ANSWER_BODY> | null => {
  try {
    const parsed = ANSWER_BODY.safeParse(JSON.parse(text));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
};

/** The confirm routes, for a request the auth gate already passed. Never sends CORS headers. */
export function serveConfirms(
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  routes: BrowserConfirmRoutes
): void {
  const path = normalizePath(url) ?? '';
  if (path === CONFIRMS_PATH) {
    if (!isSameOriginFetch(req.headers)) return reply(res, 403, { error: 'FORBIDDEN_ORIGIN' });
    if (req.method !== 'GET') return reply(res, 405, { error: 'METHOD_NOT_ALLOWED' });
    const id = conversationOf(url);
    if (id === null) return reply(res, 400, { error: 'BAD_CONVERSATION' });
    return reply(res, 200, { confirms: routes.listConfirms(id) });
  }
  const confirmId = CONFIRM_ANSWER_PATH.exec(path)?.[1];
  if (!confirmId) return reply(res, 404, { error: 'NOT_FOUND' });
  // A state-changing request: a matching Origin is required (a form or fetch from elsewhere carries its own).
  if (!isSameOrigin(req.headers)) return reply(res, 403, { error: 'FORBIDDEN_ORIGIN' });
  if (req.method !== 'POST') return reply(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  readBody(req, MAX_ANSWER_BYTES)
    .then((text) => {
      if (text === null) {
        // A cut-off chunked body took its socket with it: nothing left to answer on.
        if (res.socket?.writable) reply(res, 413, { error: 'BODY_TOO_LARGE' });
        return;
      }
      const answer = parseAnswer(text);
      if (!answer) return reply(res, 400, { error: 'BAD_BODY' });
      if (!routes.answerConfirm(confirmId, answer.allow, answer.always)) return reply(res, 404, { error: 'NOT_FOUND' });
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
    })
    .catch((error: unknown) => {
      console.error('[web-host] confirm answer failed', error);
      if (!res.headersSent) reply(res, 500, { error: 'INTERNAL' });
    });
}

export type BrowserViewStreams = {
  /**
   * A stream upgrade the auth gate already passed: same-origin check, limits, the WebSocket handshake, then the
   * desktop stream. `stillValid` re-checks the session every 30 s; the stream closes with 1008 when it fails.
   */
  accept(
    socket: Socket,
    target: string,
    headers: Record<string, string>,
    head: Buffer,
    stillValid: () => Promise<boolean>
  ): void;
};

export function createBrowserViewStreams(
  routes: BrowserViewRoutes,
  refuse: (socket: Socket, status: number) => void
): BrowserViewStreams {
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const perTab = new Map<string, number>();
  let total = 0;

  const count = (socket: Socket, tabId: string): void => {
    total += 1;
    perTab.set(tabId, (perTab.get(tabId) ?? 0) + 1);
    socket.once('close', () => {
      total -= 1;
      const left = (perTab.get(tabId) ?? 1) - 1;
      if (left > 0) perTab.set(tabId, left);
      else perTab.delete(tabId);
    });
  };

  return {
    accept(socket, target, headers, head, stillValid) {
      if (!isSameOrigin(headers)) return refuse(socket, 403);
      const tabId = new URL(target, 'http://localhost').searchParams.get('tab') ?? '';
      if (total >= MAX_STREAMS || (perTab.get(tabId) ?? 0) >= MAX_STREAMS_PER_TAB) return refuse(socket, 429);
      count(socket, tabId);
      // ws reads only the method, url and headers of the request it upgrades; the gate rebuilt those.
      // This holds only while the server has no `verifyClient` or `path` option (those read req.socket / req.url).
      const req = { method: 'GET', url: target, headers } as IncomingMessage;
      wss.handleUpgrade(req, socket, head, (ws) => {
        socket.resume(); // the raw upgrade path paused it while the gate ran
        connect(ws, tabId, routes, stillValid);
      });
    },
  };
}

function connect(ws: WebSocket, tabId: string, routes: BrowserViewRoutes, stillValid: () => Promise<boolean>): void {
  let handle: BrowserViewStreamHandle | null = null;
  let early: string[] = [];
  let closed = false;
  const send = (data: Buffer | string): void => {
    if (ws.readyState === WebSocket.OPEN) ws.send(data);
  };
  const peer: BrowserViewPeer = {
    sendBinary: send,
    sendText: send,
    close: (code, reason) => ws.close(code, reason),
  };
  const endSession = (): void => ws.close(POLICY_VIOLATION, 'session-ended');
  const deliver = (target: BrowserViewStreamHandle, raw: string): void => {
    try {
      target.onMessage(raw);
    } catch (error) {
      console.error('[web-host] browser-view stream message failed', error);
      ws.close(INTERNAL_ERROR, 'stream-failed');
    }
  };
  // A phone that vanished without a FIN would otherwise hold its slot and the tab's cast forever.
  let alive = true;
  ws.on('pong', () => (alive = true));
  const timer = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    ws.ping();
    stillValid().then((ok) => {
      if (!ok) endSession();
    }, endSession);
  }, REVALIDATE_MS);

  ws.on('error', () => {}); // ws closes the socket itself after a protocol error (e.g. an oversized message)
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const raw = data.toString();
    if (handle) deliver(handle, raw);
    else if (early.length < MAX_EARLY_MESSAGES) early.push(raw);
  });
  ws.on('close', () => {
    closed = true;
    clearInterval(timer);
    handle?.close();
  });

  routes.openStream(tabId, peer).then(
    (result) => {
      if ('error' in result) return ws.close(CLOSE_CODES[result.error], result.error);
      if (closed) return result.close();
      handle = result;
      early.forEach((raw) => deliver(result, raw));
      early = [];
    },
    () => ws.close(INTERNAL_ERROR, 'stream-failed')
  );
}
