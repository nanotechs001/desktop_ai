/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentActionEvent } from '@/common/types/browser';
import { isAgentNavigableUrl } from './agentUrl';
import { createDebuggerSessions, type RelayEvent, type SessionInfo } from './debuggerSessions';
import { POLICY_ERROR_CODE, decideRelayCommand, mayAct } from './relayPolicy';
import {
  DEFAULT_RELAY_LIMITS,
  RELAY_HOST,
  asParams,
  checkUpgrade,
  guardUpgradeSocket,
  parseRequest,
  refuseUpgrade,
  takeSlot,
  type Params,
  type RelayLimits,
} from './relayTransport';
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
  /** Loopback ports agents must not navigate to besides the relay's own (e.g. the backend's). */
  blockedPorts?: () => readonly number[];
  limits?: Partial<RelayLimits>;
};

export type RelayHandle = { url: string; token: string; clients(): RelayClient[]; close(): Promise<void> };

type Connection = {
  client: RelayClient;
  ws: WebSocket;
  actionTimes: number[];
  createTimes: number[];
  pendingCreates: number;
  inFlight: number;
  queue: string[];
  queuedBytes: number;
  bufferTimer: NodeJS.Timeout | null;
};

const ACTION_LIMIT = 20;
const ACTION_WINDOW_MS = 1000;
const MAX_OP_LENGTH = 40;
const MAX_ACTION_LABEL_LENGTH = 120;
const AUTO_ATTACH_METHOD = 'Target.setAutoAttach';
const DIALOG_METHOD = 'Page.handleJavaScriptDialog';

const isFiniteNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/** A finite rect clamped to non-negative numbers; null when absent; undefined when malformed. */
const parseRect = (value: unknown): AgentActionEvent['rect'] | undefined => {
  if (value === null || value === undefined) return null;
  const rect = asParams(value);
  const numbers = rect ? [rect.x, rect.y, rect.width, rect.height] : [];
  if (!numbers.every(isFiniteNumber) || numbers.length !== 4) return undefined;
  const [x, y, width, height] = (numbers as number[]).map((n) => Math.max(0, n));
  return { x, y, width, height };
};

/** The point of an agent mousePressed, the only agent input Electron also reports as user input. */
const agentClickPoint = (method: string, params: Params): { x: number; y: number } | null =>
  method === 'Input.dispatchMouseEvent' &&
  params.type === 'mousePressed' &&
  isFiniteNumber(params.x) &&
  isFiniteNumber(params.y)
    ? { x: params.x, y: params.y }
    : null;

/**
 * Starts the agent relay: a token-guarded loopback WebSocket that exposes the in-app browser's tabs
 * as CDP targets over `webContents.debugger` (spec §3.2). No HTTP endpoints exist; upgrades with an
 * `Origin` header are refused so web pages cannot reach it.
 */
export async function startRelayServer(deps: RelayServerDeps): Promise<RelayHandle> {
  const { registry } = deps;
  const limits: RelayLimits = { ...DEFAULT_RELAY_LIMITS, ...deps.limits };
  const token = randomBytes(32).toString('hex');
  const sessions = createDebuggerSessions();
  const connections = new Map<string, Connection>();
  const wss = new WebSocketServer({ noServer: true, maxPayload: limits.maxPayloadBytes });

  /** Sends, and closes a client whose send buffer stays over the limit (it stopped reading). */
  const send = (conn: Connection, payload: object): void => {
    const { ws } = conn;
    if (ws.readyState !== ws.OPEN) return;
    ws.send(JSON.stringify(payload));
    if (ws.bufferedAmount <= limits.maxBufferedBytes || conn.bufferTimer) return;
    conn.bufferTimer = setTimeout(() => {
      conn.bufferTimer = null;
      if (ws.bufferedAmount > limits.maxBufferedBytes) ws.terminate();
    }, limits.bufferedGraceMs);
  };
  const httpServer = createServer((_req, res) => res.writeHead(404).end());

  const blockedPorts = (): ReadonlySet<number> => new Set([port, ...(deps.blockedPorts?.() ?? [])]);

  /** CDP Page.reload on a webview guest reloads the embedder (the AionUi window), so reload the tab directly. */
  const reload = (session: SessionInfo, params: Params): Params => {
    const contents = registry.contents(session.webContentsId);
    if (session.cdpSessionId || !contents) throw new Error('Page.reload is only supported on a tab session');
    if (params.ignoreCache === true) contents.reloadIgnoringCache();
    else contents.reload();
    return {};
  };

  const tabFor = (targetId: unknown): { webContentsId: number; contents: RelayContents } => {
    const webContentsId = typeof targetId === 'string' ? webContentsIdFromTargetId(targetId) : null;
    const contents = webContentsId === null ? null : registry.contents(webContentsId);
    if (webContentsId === null || !contents) throw new Error(`No such target: ${String(targetId)}`);
    return { webContentsId, contents };
  };

  const createTarget = async (conn: Connection, params: Params): Promise<Params> => {
    const { client } = conn;
    const { url } = params;
    if (typeof url !== 'string' || !isAgentNavigableUrl(url, blockedPorts())) {
      throw new Error(
        'Target.createTarget only accepts web urls outside link-local, metadata and app-internal addresses'
      );
    }
    const owned = registry.all().filter((t) => t.owner !== 'user' && t.owner.clientId === client.clientId).length;
    if (owned + conn.pendingCreates >= limits.maxTabsPerClient) {
      throw new Error(`An agent may keep at most ${limits.maxTabsPerClient} tabs open; close one first`);
    }
    const createTimes = takeSlot(
      conn.createTimes,
      limits.createTargetsPerWindow,
      limits.createTargetWindowMs,
      Date.now()
    );
    if (!createTimes) throw new Error('Target.createTarget rate limited');
    conn.createTimes = createTimes;
    conn.pendingCreates += 1;
    let contents: RelayContents;
    try {
      const waiting = deps.waitForTab(url);
      deps.openTab(url);
      contents = await waiting;
    } finally {
      conn.pendingCreates -= 1;
    }
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
    if (sessions.count(conn.client.clientId) >= limits.maxSessionsPerClient) {
      throw new Error(`An agent may hold at most ${limits.maxSessionsPerClient} sessions; detach one first`);
    }
    const sink = { id: conn.client.clientId, emit: (event: RelayEvent) => send(conn, event) };
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
    const actionTimes = takeSlot(conn.actionTimes, ACTION_LIMIT, ACTION_WINDOW_MS, now);
    if (!actionTimes) throw new Error('AionRelay.reportAction rate limited');
    conn.actionTimes = actionTimes;
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
        return { allow: false }; // TODO(Task 10): route to the in-pane confirm gate; fail closed until then.
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
    const tab = registry.ownership(webContentsId);
    const decision = decideRelayCommand({
      client: conn.client,
      method,
      params,
      tab,
      ownContexts,
      blockedPorts: blockedPorts(),
    });
    if (decision.allow === false) throw new Error(decision.message);
    if (method === 'Page.reload') return reload(session, params);
    const click = agentClickPoint(method, params);
    const endInput = click ? registry.beginAgentInput(webContentsId, click) : null;
    try {
      const result = await sessions.send(sessionId, method, params);
      const contextId = asParams(result)?.executionContextId;
      if (method === 'Page.createIsolatedWorld' && typeof contextId === 'number') {
        sessions.addOwnContext(sessionId, contextId);
      }
      return result ?? {};
    } finally {
      endInput?.();
    }
  };

  const onMessage = async (conn: Connection, raw: string): Promise<void> => {
    const request = parseRequest(raw);
    if (!request) return;
    if ('invalid' in request) {
      send(conn, { id: request.id, error: { code: POLICY_ERROR_CODE, message: request.invalid } });
      return;
    }
    const { id, method, params, sessionId } = request;
    try {
      const result =
        sessionId === undefined
          ? await browserCommand(conn, method, params)
          : await sessionCommand(conn, sessionId, method, params);
      send(conn, { id, result, sessionId });
      // Events of a new session (e.g. replayed OOPIFs) are held until its attach reply is out.
      if (method === 'Target.attachToTarget') sessions.ready(String(asParams(result)?.sessionId));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      send(conn, { id, error: { code: POLICY_ERROR_CODE, message }, sessionId });
    }
  };

  /** Runs up to `maxInFlightPerSocket` commands per client at once; the rest wait their turn. */
  const run = async (conn: Connection, raw: string): Promise<void> => {
    conn.inFlight += 1;
    try {
      await onMessage(conn, raw);
    } finally {
      conn.inFlight -= 1;
      const [next, ...rest] = conn.queue;
      if (next !== undefined) {
        conn.queue = rest;
        conn.queuedBytes -= Buffer.byteLength(next);
        void run(conn, next);
      }
    }
  };

  const enqueue = (conn: Connection, raw: string): void => {
    if (conn.inFlight < limits.maxInFlightPerSocket) {
      void run(conn, raw);
      return;
    }
    const request = parseRequest(raw);
    // A page blocked on alert/confirm stalls every other command, so its answer must never wait behind them.
    if (request && 'method' in request && request.method === DIALOG_METHOD) {
      void run(conn, raw);
      return;
    }
    const bytes = Buffer.byteLength(raw);
    const fits =
      conn.queue.length < limits.maxQueuedPerSocket && conn.queuedBytes + bytes <= limits.maxQueuedBytesPerSocket;
    if (fits) {
      conn.queue = [...conn.queue, raw];
      conn.queuedBytes += bytes;
      return;
    }
    if (request)
      send(conn, { id: request.id, error: { code: POLICY_ERROR_CODE, message: 'Too many pending commands' } });
  };

  const onConnection = (ws: WebSocket, label: string): void => {
    const conn: Connection = {
      client: { clientId: randomUUID(), label },
      ws,
      actionTimes: [],
      createTimes: [],
      pendingCreates: 0,
      inFlight: 0,
      queue: [],
      queuedBytes: 0,
      bufferTimer: null,
    };
    connections.set(conn.client.clientId, conn);
    ws.on('message', (data) => enqueue(conn, data.toString()));
    ws.on('close', () => {
      if (conn.bufferTimer) clearTimeout(conn.bufferTimer);
      conn.queue = [];
      conn.queuedBytes = 0;
      connections.delete(conn.client.clientId);
      sessions.dropSink(conn.client.clientId);
      registry.releaseClient(conn.client.clientId);
    });
    ws.on('error', (error) => console.warn('[AgentBrowserRelay] client socket error:', error.message));
  };

  httpServer.on('upgrade', (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    guardUpgradeSocket(socket);
    const verdict = checkUpgrade(req, token, port);
    if (verdict.ok === false) return refuseUpgrade(socket, verdict.status);
    if (connections.size >= limits.maxConnections) return refuseUpgrade(socket, '503 Service Unavailable');
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, verdict.label));
  });

  const unsubscribe = [
    registry.onDestroyed((last) => {
      const event = { method: 'Target.targetDestroyed', params: { targetId: targetIdFor(last.webContentsId) } };
      for (const conn of connections.values()) if (mayAct(last, conn.client)) send(conn, event);
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
    httpServer.listen(0, RELAY_HOST, () => {
      const address = httpServer.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('Could not determine the relay port'));
    });
  });

  return {
    url: `ws://${RELAY_HOST}:${port}/`,
    token,
    clients: () => Array.from(connections.values(), (conn) => conn.client),
    close: async () => {
      unsubscribe.forEach((off) => off());
      for (const conn of connections.values()) conn.ws.terminate();
      await new Promise<void>((resolve) => wss.close(() => httpServer.close(() => resolve())));
    },
  };
}
