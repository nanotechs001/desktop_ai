/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import type { AgentActionEvent, ConfirmRequest } from '@/common/types/browser';
import { sanitizePageText } from '@/common/utils/utils';
import { webOriginOf } from '../confirmGate';
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
  type AgentInput,
  type RelayClient,
  type RelayContents,
  type TargetRegistry,
} from './targetRegistry';

export type RelayServerDeps = {
  registry: TargetRegistry;
  /** Asks the pane to open a browser tab (ipcBridge.browser.openTabRequested) in the agent's chat, when known. */
  openTab(url: string, conversationId?: string): void;
  /** Resolves with the next browser tab that attaches, in request order; rejects on timeout or a pane refusal. */
  waitForTab(url: string, conversationId?: string): Promise<RelayContents>;
  /** Asks the pane to close a browser tab (ipcBridge.browser.closeTabRequested). */
  closeTab(webContentsId: number): void;
  onAgentAction(event: AgentActionEvent): void;
  /** Asks the user to allow a risky action; resolves with the answer. `signal` aborts when the ask is moot. */
  requestConfirm(request: Omit<ConfirmRequest, 'id'>, signal: AbortSignal): Promise<boolean>;
  /** Loopback ports agents must not navigate to besides the relay's own (e.g. the backend's). */
  blockedPorts?: () => readonly number[];
  limits?: Partial<RelayLimits>;
};

export type RelayHandle = { url: string; token: string; clients(): RelayClient[]; close(): Promise<void> };

type Connection = {
  client: RelayClient;
  /** The chat the client's MCP runs for (`X-Aion-Conversation`); undefined for older MCPs and other engines. */
  conversationId?: string;
  ws: WebSocket;
  actionTimes: number[];
  createTimes: number[];
  pendingCreates: number;
  inFlight: number;
  dialogsInFlight: number;
  confirmsInFlight: number;
  /** Aborts when the socket closes, so a confirm nobody is waiting for leaves the pane. */
  closed: AbortController;
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
const MAX_DIALOGS_IN_FLIGHT = 2;
const MAX_CONFIRMS_IN_FLIGHT = 2;
const MAX_CONFIRM_LABEL_LENGTH = 120;
const FRAME_LOOKUP_TIMEOUT_MS = 5000;

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

/** An agent input Electron also reports as user input: a mousePressed's point, a keyDown/rawKeyDown's key and code. */
const agentInputOf = (method: string, params: Params): AgentInput | null => {
  if (method === 'Input.dispatchMouseEvent') {
    const pressed = params.type === 'mousePressed' && isFiniteNumber(params.x) && isFiniteNumber(params.y);
    return pressed ? { x: params.x as number, y: params.y as number } : null;
  }
  const keyDown = method === 'Input.dispatchKeyEvent' && (params.type === 'keyDown' || params.type === 'rawKeyDown');
  if (!keyDown || typeof params.key !== 'string') return null;
  return { key: params.key, code: typeof params.code === 'string' ? params.code : '' };
};

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
      const waiting = deps.waitForTab(url, conn.conversationId);
      deps.openTab(url, conn.conversationId);
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

  /**
   * The origin of frame `frameId` in the tab session's own frame tree: its security origin (never its url, which a
   * sandboxed frame does not own), `'opaque'` for a sandboxed frame, null when it is not found or says nothing.
   */
  const frameOriginOf = async (relaySessionId: string, frameId: string): Promise<string | 'opaque' | null> => {
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('Page.getFrameTree timed out')), FRAME_LOOKUP_TIMEOUT_MS);
    });
    try {
      const reply = await Promise.race([sessions.send(relaySessionId, 'Page.getFrameTree', {}), timeout]);
      const find = (tree: unknown): Params | null => {
        const node = asParams(tree);
        const frame = asParams(node?.frame);
        if (frame?.id === frameId) return frame;
        const children = Array.isArray(node?.childFrames) ? node.childFrames : [];
        return children.reduce<Params | null>((found, child) => found ?? find(child), null);
      };
      const frame = find(asParams(reply)?.frameTree);
      if (!frame) return null;
      if (typeof frame.securityOrigin !== 'string') return null;
      return webOriginOf(frame.securityOrigin) ?? 'opaque';
    } finally {
      clearTimeout(timer);
    }
  };

  /**
   * Asks the user before the agent clicks or presses a key on a risky control. Both origins come from main's own
   * state, never from the agent: the tab's committed main-frame url, and the frame (`sessionId` + `frameId`) looked
   * up in that session's frame tree. Fails closed: anything but an explicit Allow (no tab, no web origin, an
   * unknown frame, too many pending asks, an error, a navigation or close meanwhile, a timeout) is `{ allow: false }`.
   */
  const requestConfirm = async (conn: Connection, params: Params): Promise<Params> => {
    const { webContentsId, label, sessionId, frameId } = params;
    if (
      !Number.isInteger(webContentsId) ||
      typeof label !== 'string' ||
      typeof sessionId !== 'string' ||
      typeof frameId !== 'string'
    ) {
      throw new Error('Invalid AionRelay.requestConfirm params');
    }
    const id = webContentsId as number;
    if (!mayAct(registry.ownership(id), conn.client)) throw new Error('This tab is not shared with agents');
    const session = ownSession(conn, sessionId);
    if (session.webContentsId !== id) throw new Error(`Unknown sessionId: ${sessionId}`);
    const contents = registry.contents(id);
    if (!contents) throw new Error(`No such target: ${targetIdFor(id)}`);
    if (contents.isDestroyed() || conn.confirmsInFlight >= MAX_CONFIRMS_IN_FLIGHT) return { allow: false };

    const moot = new AbortController();
    const onNavigate = (details: { isMainFrame: boolean; isSameDocument?: boolean }): void => {
      if (details.isMainFrame && !details.isSameDocument) moot.abort();
    };
    contents.on('did-start-navigation', onNavigate);
    const offDestroyed = registry.onDestroyed((last) => {
      if (last.webContentsId === id) moot.abort();
    });
    conn.confirmsInFlight += 1;
    try {
      const origin = webOriginOf(contents.mainFrame.url);
      const frameOrigin = origin ? await frameOriginOf(sessionId, frameId) : null;
      if (!origin || !frameOrigin) return { allow: false };
      const request = {
        origin,
        frameOrigin: frameOrigin === 'opaque' ? null : frameOrigin,
        label: sanitizePageText(label, MAX_CONFIRM_LABEL_LENGTH),
        clientLabel: conn.client.label,
      };
      const allow = await deps.requestConfirm(request, AbortSignal.any([moot.signal, conn.closed.signal]));
      return { allow: allow === true && !moot.signal.aborted };
    } catch (error) {
      console.warn('[AgentBrowserRelay] confirm failed, denied:', error);
      return { allow: false };
    } finally {
      conn.confirmsInFlight -= 1;
      offDestroyed();
      contents.removeListener('did-start-navigation', onNavigate);
    }
  };

  /** Tabs this client may act on with who owns each: `Target.getTargets` cannot tell agent from shared. */
  const listTabs = (conn: Connection): Params => ({
    tabs: registry.listTargets().flatMap(({ targetId, title, url }) => {
      const tab = registry.ownership(webContentsIdFromTargetId(targetId) ?? -1);
      if (!mayAct(tab, conn.client)) return [];
      const own = tab?.owner !== 'user' && tab?.owner.clientId === conn.client.clientId;
      return [{ targetId, title, url, owner: own ? 'agent' : 'shared' }];
    }),
  });

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
      case 'AionRelay.listTabs':
        return listTabs(conn);
      case 'AionRelay.reportAction':
        return reportAction(conn, params);
      case 'AionRelay.requestConfirm':
        return requestConfirm(conn, params);
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
    const agentInput = agentInputOf(method, params);
    const endInput = agentInput ? registry.beginAgentInput(webContentsId, agentInput) : null;
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
  /** Starts queued commands while a slot is free. */
  const drain = (conn: Connection): void => {
    while (conn.inFlight < limits.maxInFlightPerSocket && conn.queue.length > 0) {
      const [next, ...rest] = conn.queue;
      conn.queue = rest;
      conn.queuedBytes -= Buffer.byteLength(next);
      void run(conn, next);
    }
  };

  const run = async (conn: Connection, raw: string): Promise<void> => {
    conn.inFlight += 1;
    try {
      await onMessage(conn, raw);
    } finally {
      conn.inFlight -= 1;
      drain(conn);
    }
  };

  /** Dialog answers use their own few slots, so they never wait behind (or inflate) the command slots. */
  const runDialog = async (conn: Connection, raw: string): Promise<void> => {
    conn.dialogsInFlight += 1;
    try {
      await onMessage(conn, raw);
    } finally {
      conn.dialogsInFlight -= 1;
    }
  };

  const refuseBusy = (conn: Connection, id: number): void =>
    send(conn, { id, error: { code: POLICY_ERROR_CODE, message: 'Too many pending commands' } });

  const enqueue = (conn: Connection, raw: string): void => {
    if (conn.inFlight < limits.maxInFlightPerSocket) {
      void run(conn, raw);
      return;
    }
    const request = parseRequest(raw);
    // A page blocked on alert/confirm stalls every other command, so its answer must never wait behind them.
    if (request && 'method' in request && request.method === DIALOG_METHOD) {
      if (conn.dialogsInFlight < MAX_DIALOGS_IN_FLIGHT) void runDialog(conn, raw);
      else refuseBusy(conn, request.id);
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
    if (request) refuseBusy(conn, request.id);
  };

  const onConnection = (ws: WebSocket, label: string, conversationId?: string): void => {
    const conn: Connection = {
      client: { clientId: randomUUID(), label },
      conversationId,
      ws,
      actionTimes: [],
      createTimes: [],
      pendingCreates: 0,
      inFlight: 0,
      dialogsInFlight: 0,
      confirmsInFlight: 0,
      closed: new AbortController(),
      queue: [],
      queuedBytes: 0,
      bufferTimer: null,
    };
    connections.set(conn.client.clientId, conn);
    ws.on('message', (data) => enqueue(conn, data.toString()));
    ws.on('close', () => {
      if (conn.bufferTimer) clearTimeout(conn.bufferTimer);
      conn.closed.abort();
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
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, verdict.label, verdict.conversationId));
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
