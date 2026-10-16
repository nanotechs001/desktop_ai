/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentActionEvent } from '@/common/types/browser';
import { isSafeUrl } from '@process/services/browserSession/urlSafety';
import { createDebuggerSessions, type RelayEvent } from './debuggerSessions';
import { POLICY_ERROR_CODE, decideRelayCommand, mayAct } from './relayPolicy';
import {
  targetIdFor,
  webContentsIdFromTargetId,
  type RelayClient,
  type RelayContents,
  type TargetRegistry,
} from './targetRegistry';

export type RelayServerDeps = {
  registry: TargetRegistry;
  /** Asks the pane to open a browser tab (ipcBridge.browser.openTabRequested). */
  openTab(url: string): void;
  /** Resolves with the next browser tab that attaches, in request order; rejects on timeout. */
  waitForTab(url: string): Promise<RelayContents>;
  /** Asks the pane to close a browser tab (ipcBridge.browser.closeTabRequested). */
  closeTab(webContentsId: number): void;
  onAgentAction(event: AgentActionEvent): void;
};

export type RelayHandle = { url: string; token: string; clients(): RelayClient[]; close(): Promise<void> };

type Connection = { client: RelayClient; ws: WebSocket; actionTimes: number[] };
type Params = Record<string, unknown>;
type RelayRequest = { id: number; method: string; params: Params; sessionId?: string };

const HOST = '127.0.0.1';
const MAX_PAYLOAD_BYTES = 4 * 1024 * 1024;
const ACTION_LIMIT = 20;
const ACTION_WINDOW_MS = 1000;
const MAX_OP_LENGTH = 40;
const MAX_ACTION_LABEL_LENGTH = 200;
const DEFAULT_LABEL = 'agent';
const AUTO_ATTACH_METHOD = 'Target.setAutoAttach';

/** `?client=` value reduced to `[\w .-]{1,40}`; 'agent' when nothing is left. */
export const sanitizeClientLabel = (raw: string | null): string =>
  (raw ?? '')
    .replace(/[^\w .-]/g, '')
    .trim()
    .slice(0, 40) || DEFAULT_LABEL;

/** Constant-time token check; hashing first makes the lengths equal. */
const tokensMatch = (expected: string, given: string): boolean =>
  timingSafeEqual(createHash('sha256').update(expected).digest(), createHash('sha256').update(given).digest());

const send = (ws: WebSocket, payload: object): void => {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
};

const asParams = (value: unknown): Params | null =>
  value === undefined ? {} : value && typeof value === 'object' && !Array.isArray(value) ? (value as Params) : null;

/** Parses one client frame; null when it cannot even be replied to. */
const parseRequest = (raw: string): RelayRequest | { id: number; invalid: string } | null => {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const message = asParams(data);
  const id = message?.id;
  if (!message || typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) return null;
  const params = asParams(message.params);
  const { method, sessionId } = message;
  if (typeof method !== 'string' || !method || !params) return { id, invalid: 'Invalid request' };
  if (sessionId !== undefined && typeof sessionId !== 'string') return { id, invalid: 'Invalid sessionId' };
  return { id, method, params, sessionId: typeof sessionId === 'string' ? sessionId : undefined };
};

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

const parseRect = (value: unknown): AgentActionEvent['rect'] | undefined => {
  if (value === null || value === undefined) return null;
  const rect = asParams(value);
  if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(isFiniteNumber)) return undefined;
  return { x: rect.x as number, y: rect.y as number, width: rect.width as number, height: rect.height as number };
};

const refuse = (socket: Duplex, status: string): void => {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
};

/**
 * Starts the agent relay: a token-guarded loopback WebSocket that exposes the in-app browser's tabs
 * as CDP targets over `webContents.debugger` (spec §3.2). No HTTP endpoints exist; upgrades with an
 * `Origin` header are refused so web pages cannot reach it.
 */
export async function startRelayServer(deps: RelayServerDeps): Promise<RelayHandle> {
  const { registry } = deps;
  const token = randomBytes(32).toString('hex');
  const sessions = createDebuggerSessions();
  const connections = new Map<string, Connection>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD_BYTES });
  const httpServer = createServer((_req, res) => res.writeHead(404).end());

  const tabFor = (targetId: unknown): { webContentsId: number; contents: RelayContents } => {
    const webContentsId = typeof targetId === 'string' ? webContentsIdFromTargetId(targetId) : null;
    const contents = webContentsId === null ? null : registry.contents(webContentsId);
    if (webContentsId === null || !contents) throw new Error(`No such target: ${String(targetId)}`);
    return { webContentsId, contents };
  };

  const createTarget = async ({ client }: Connection, params: Params): Promise<Params> => {
    const { url } = params;
    if (typeof url !== 'string' || !isSafeUrl(url)) throw new Error('Target.createTarget only accepts http(s) urls');
    const waiting = deps.waitForTab(url);
    deps.openTab(url);
    const contents = await waiting;
    registry.track(contents);
    registry.claim(contents.id, client);
    // The client may have gone while the tab opened; it must not stay claimable under its label.
    if (!connections.has(client.clientId)) registry.releaseClient(client.clientId);
    return { targetId: targetIdFor(contents.id) };
  };

  const attachToTarget = async (conn: Connection, params: Params): Promise<Params> => {
    if (params.flatten === false) throw new Error('Only flattened sessions are supported');
    const { webContentsId, contents } = tabFor(params.targetId);
    if (!mayAct(registry.ownership(webContentsId), conn.client)) throw new Error('This tab is not shared with agents');
    const sink = { id: conn.client.clientId, emit: (event: RelayEvent) => send(conn.ws, event) };
    let sessionId: string;
    try {
      sessionId = await sessions.attach(contents, sink);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`Could not attach to this tab: ${message}`, { cause: error });
    }
    // The client may have gone during the attach; its socket close already dropped its other sessions.
    if (!connections.has(conn.client.clientId)) sessions.detachSession(sessionId);
    return { sessionId };
  };

  const ownSession = (conn: Connection, sessionId: unknown) => {
    const session = typeof sessionId === 'string' ? sessions.session(sessionId) : null;
    if (!session || session.sinkId !== conn.client.clientId) throw new Error(`Unknown sessionId: ${String(sessionId)}`);
    return session;
  };

  const reportAction = (conn: Connection, params: Params): Params => {
    const { webContentsId, op, label } = params;
    const rect = parseRect(params.rect);
    const valid =
      typeof webContentsId === 'number' &&
      typeof op === 'string' &&
      op.length > 0 &&
      op.length <= MAX_OP_LENGTH &&
      typeof label === 'string' &&
      rect !== undefined;
    if (!valid) throw new Error('Invalid AionRelay.reportAction params');
    if (!mayAct(registry.ownership(webContentsId), conn.client)) throw new Error('This tab is not shared with agents');
    const now = Date.now();
    conn.actionTimes = conn.actionTimes.filter((at) => now - at < ACTION_WINDOW_MS);
    if (conn.actionTimes.length >= ACTION_LIMIT) throw new Error('AionRelay.reportAction rate limited');
    conn.actionTimes = [...conn.actionTimes, now];
    deps.onAgentAction({
      webContentsId,
      clientLabel: conn.client.label,
      op,
      label: label.slice(0, MAX_ACTION_LABEL_LENGTH),
      rect,
      at: now,
    });
    return {};
  };

  /** Commands without a sessionId: the browser-level Target domain and the relay's own methods. */
  const browserCommand = async (conn: Connection, method: string, params: Params): Promise<Params> => {
    switch (method) {
      case 'Target.getTargets':
        return {
          targetInfos: registry
            .listTargets()
            .filter((t) => mayAct(registry.ownership(webContentsIdFromTargetId(t.targetId) ?? -1), conn.client)),
        };
      case 'Target.createTarget':
        return createTarget(conn, params);
      case 'Target.attachToTarget':
        return attachToTarget(conn, params);
      case 'Target.detachFromTarget':
        ownSession(conn, params.sessionId);
        sessions.detachSession(String(params.sessionId));
        return {};
      case 'Target.closeTarget': {
        const { webContentsId } = tabFor(params.targetId);
        const owner = registry.ownership(webContentsId)?.owner;
        if (owner === 'user' || owner?.clientId !== conn.client.clientId)
          throw new Error('Agents may close only tabs they opened');
        deps.closeTab(webContentsId);
        return { success: true };
      }
      case AUTO_ATTACH_METHOD:
        return {}; // The relay always auto-attaches OOPIFs itself.
      case 'AionRelay.reportAction':
        return reportAction(conn, params);
      case 'AionRelay.requestConfirm':
        return { allow: true }; // TODO(Task 10): route to the in-pane confirm gate.
      default:
        throw new Error(`${method} is not allowed for agents`);
    }
  };

  const sessionCommand = async (
    conn: Connection,
    sessionId: string,
    method: string,
    params: Params
  ): Promise<unknown> => {
    const session = ownSession(conn, sessionId);
    if (method === AUTO_ATTACH_METHOD) return {};
    const { webContentsId, ownContexts } = session;
    const decision = decideRelayCommand({
      client: conn.client,
      method,
      params,
      tab: registry.ownership(webContentsId),
      ownContexts,
    });
    if (decision.allow === false) throw new Error(decision.message);
    const endInput = method.startsWith('Input.') ? registry.beginAgentInput(webContentsId) : null;
    try {
      const result = await sessions.send(sessionId, method, params);
      const contextId = asParams(result)?.executionContextId;
      if (method === 'Page.createIsolatedWorld' && typeof contextId === 'number') ownContexts.add(contextId);
      return result ?? {};
    } finally {
      endInput?.();
    }
  };

  const onMessage = async (conn: Connection, raw: string): Promise<void> => {
    const request = parseRequest(raw);
    if (!request) return;
    if ('invalid' in request) {
      send(conn.ws, { id: request.id, error: { code: POLICY_ERROR_CODE, message: request.invalid } });
      return;
    }
    const { id, method, params, sessionId } = request;
    try {
      const result =
        sessionId === undefined
          ? await browserCommand(conn, method, params)
          : await sessionCommand(conn, sessionId, method, params);
      send(conn.ws, { id, result, sessionId });
      // Events of a new session (e.g. replayed OOPIFs) are held until its attach reply is out.
      if (method === 'Target.attachToTarget') sessions.ready(String(asParams(result)?.sessionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(conn.ws, { id, error: { code: POLICY_ERROR_CODE, message }, sessionId });
    }
  };

  const onConnection = (ws: WebSocket, label: string): void => {
    const conn: Connection = { client: { clientId: randomUUID(), label }, ws, actionTimes: [] };
    connections.set(conn.client.clientId, conn);
    ws.on('message', (data) => void onMessage(conn, data.toString()));
    ws.on('close', () => {
      connections.delete(conn.client.clientId);
      sessions.dropSink(conn.client.clientId);
      registry.releaseClient(conn.client.clientId);
    });
    ws.on('error', (error) => console.warn('[AgentBrowserRelay] client socket error:', error.message));
  };

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? '/', `http://${HOST}`);
    if (req.headers.origin !== undefined) return refuse(socket, '403 Forbidden');
    if (!tokensMatch(token, url.searchParams.get('token') ?? '')) return refuse(socket, '401 Unauthorized');
    const label = sanitizeClientLabel(url.searchParams.get('client'));
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, label));
  });

  const unsubscribe = [
    registry.onDestroyed((last) => {
      const event = { method: 'Target.targetDestroyed', params: { targetId: targetIdFor(last.webContentsId) } };
      for (const conn of connections.values()) if (mayAct(last, conn.client)) send(conn.ws, event);
      sessions.dropContents(last.webContentsId);
    }),
    // Unsharing (or any ownership change) ends sessions their client may no longer drive.
    registry.onChange(() =>
      sessions.prune((webContentsId, sinkId) => {
        const conn = connections.get(sinkId);
        return conn !== undefined && mayAct(registry.ownership(webContentsId), conn.client);
      })
    ),
  ];

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(0, HOST, () => {
      const address = httpServer.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('Could not determine the relay port'));
    });
  });

  return {
    url: `ws://${HOST}:${port}/`,
    token,
    clients: () => Array.from(connections.values(), (conn) => conn.client),
    close: async () => {
      unsubscribe.forEach((off) => off());
      for (const conn of connections.values()) conn.ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => httpServer.close(() => resolve())));
    },
  };
}
