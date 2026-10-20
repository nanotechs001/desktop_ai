/**
 * The WebUI's live view of the desktop's agent browser tabs, answered by the listener itself after the auth gate:
 * `GET /api/browser-view/tabs?conversation=<id>` and the `/api/browser-view/stream?tab=<id>` WebSocket. Both also
 * need a same-origin `Origin`. Messages are carried as-is; the desktop's BrowserViewRoutes parses them.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Socket } from 'node:net';
import { WebSocket, WebSocketServer } from 'ws';
import type { BrowserViewPeer, BrowserViewRoutes, BrowserViewStreamHandle } from '../types.js';

export const TABS_PATH = '/api/browser-view/tabs';
export const STREAM_PATH = '/api/browser-view/stream';
/** Anything a lenient parser could read as a request line for the stream route. */
export const STREAM_ROUTE_LIKE = /^\S+\s+\/api\/browser-view\/stream(?:[?\s]|$)/i;
/** The only stream upgrade request line: exactly one `tab`, a relay target id. */
export const STREAM_REQUEST_LINE = /^GET (\/api\/browser-view\/stream)(\?tab=wc-\d{1,9}) HTTP\/1\.1$/;

const MAX_STREAMS_PER_TAB = 2;
const MAX_STREAMS = 4;
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

function reply(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

/** The tabs route, for a request the auth gate already passed. */
export function serveTabs(req: IncomingMessage, res: ServerResponse, url: string, routes: BrowserViewRoutes): void {
  if (!isSameOrigin(req.headers)) return reply(res, 403, { error: 'FORBIDDEN_ORIGIN' });
  if (req.method !== 'GET') return reply(res, 405, { error: 'METHOD_NOT_ALLOWED' });
  const ids = new URL(url, 'http://localhost').searchParams.getAll('conversation');
  if (ids.length !== 1 || !CONVERSATION_ID.test(ids[0])) return reply(res, 400, { error: 'BAD_CONVERSATION' });
  reply(res, 200, { tabs: routes.listTabs(ids[0]) });
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
  const timer = setInterval(() => {
    stillValid().then((ok) => {
      if (!ok) endSession();
    }, endSession);
  }, REVALIDATE_MS);

  ws.on('error', () => {}); // ws closes the socket itself after a protocol error (e.g. an oversized message)
  ws.on('message', (data, isBinary) => {
    if (isBinary) return;
    const raw = data.toString();
    if (handle) handle.onMessage(raw);
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
      early.forEach((raw) => result.onMessage(raw));
      early = [];
    },
    () => ws.close(INTERNAL_ERROR, 'stream-failed')
  );
}
