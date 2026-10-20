/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Runs inside the standalone aion-browser MCP process: no electron imports, and nothing that pulls them in.
import WebSocket from 'ws';
import { CdpConnection, createWebSocketTransport } from '@process/services/agentBrowser/cdpConnection';
import type { ScriptForm, ScriptWorld } from '@process/services/agentBrowser/relay/pageScript';
import { parseConversationId } from '@process/services/agentBrowser/relay/relayTransport';
import type { ReportedAction } from './actions';
import { watchFrames } from './frames';

/** Thrown by {@link RelayClient.connect} when the Pixebot Browser relay env vars are absent or unusable. */
export const RELAY_ENV_MISSING = 'relay-env-missing';

/** The relay could not be reached (Pixebot Browser not running, wrong token, ...). */
export class RelayConnectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RelayConnectError';
  }
}

/** One tab the agent may use. `owner` is 'agent' for tabs it opened and 'shared' for tabs the user shared. */
export type TabSummary = { tab: string; title: string; url: string; owner: 'agent' | 'shared' };

const MAX_BACKOFF_MS = 5000;
const BASE_BACKOFF_MS = 250;
const HANDSHAKE_TIMEOUT_MS = 5000;
const LABEL_PREFIX = 'aion-browser';
const MAX_LABEL_LENGTH = 40;
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);
/** Relay target ids are `wc-<webContents id>` (targetRegistry.targetIdFor). */
const TARGET_ID = /^wc-(\d{1,9})$/;

/** Wait before the `failures`-th consecutive reconnect attempt: 250 ms doubling, capped at 5 s. */
export const retryDelayMs = (failures: number): number =>
  Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** Math.max(0, failures - 1));

/** `aion-browser-<agent>` reduced to the `[\w .-]{1,40}` alphabet the relay accepts as a client label. */
const clientLabel = (agentName: string | undefined): string => {
  const agent = (agentName ?? '').replace(/[^\w .-]/g, '').trim();
  return (agent ? `${LABEL_PREFIX}-${agent}` : LABEL_PREFIX).slice(0, MAX_LABEL_LENGTH);
};

/** The relay url and token, or null. Only a loopback ws url is accepted so the token cannot be sent elsewhere. */
const readRelayEnv = (env: NodeJS.ProcessEnv): { url: URL; token: string } | null => {
  const token = env.AION_BROWSER_RELAY_TOKEN;
  if (!env.AION_BROWSER_RELAY_URL || !token) return null;
  try {
    const url = new URL(env.AION_BROWSER_RELAY_URL);
    return url.protocol === 'ws:' && LOOPBACK_HOSTS.has(url.hostname) ? { url, token } : null;
  } catch {
    return null;
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const openSocket = (url: URL, token: string, conversationId: string | undefined): Promise<WebSocket> =>
  new Promise((resolve, reject) => {
    const ws = new WebSocket(url, {
      // X-Aion-Conversation lets the pane open this agent's tabs in its own chat.
      headers: {
        Authorization: `Bearer ${token}`,
        ...(conversationId ? { 'X-Aion-Conversation': conversationId } : {}),
      },
      handshakeTimeout: HANDSHAKE_TIMEOUT_MS,
    });
    ws.once('open', () => {
      ws.removeListener('error', reject);
      resolve(ws);
    });
    ws.once('error', reject);
  });

type RelayTab = { targetId: string; title: string; url: string; owner: TabSummary['owner'] };

const isRelayTab = (value: unknown): value is RelayTab => {
  const tab = value as Record<string, unknown> | null;
  return (
    typeof tab === 'object' &&
    tab !== null &&
    typeof tab.targetId === 'string' &&
    typeof tab.title === 'string' &&
    typeof tab.url === 'string' &&
    (tab.owner === 'agent' || tab.owner === 'shared')
  );
};

/**
 * The aion-browser server's link to the Pixebot Browser agent relay (a token-guarded loopback WebSocket speaking CDP).
 * Connects lazily on first use and again after the socket drops, waiting out a capped backoff after failures.
 * Per-connection state (CDP sessions, the current tab) is forgotten when the connection goes, because the
 * relay ties tab ownership to the connection.
 */
export class RelayClient {
  /** The tab later calls use when they name none; set by `tabs` open and switch. */
  currentTab: string | null = null;

  private conn: CdpConnection | null = null;
  private connecting: Promise<CdpConnection> | null = null;
  private hadConnection = false;
  private reconnected = false;
  private failures = 0;
  private retryAt = 0;
  private sessions = new Map<string, Promise<string>>();
  /** Tab -> its attached session id, to match a relay detach to the cached tab. */
  private sessionIds = new Map<string, string>();

  /**
   * @param env Source of AION_BROWSER_RELAY_URL / AION_BROWSER_RELAY_TOKEN and AIONUI_CONVERSATION_ID (the agent's chat).
   * @param agentName The MCP client's name (from `initialize`), read at each connect for the relay's client label.
   */
  constructor(
    private env: NodeJS.ProcessEnv,
    private readonly agentName: () => string | undefined = () => undefined
  ) {}

  /** The live connection. Call after another method has connected; throws when the socket is gone. */
  get connection(): CdpConnection {
    if (!this.conn || this.conn.closed) throw new Error('The connection to the Pixebot browser was lost');
    return this.conn;
  }

  /** Connects to the relay named by `env`; no-op while already connected. Throws {@link RELAY_ENV_MISSING}. */
  async connect(env: NodeJS.ProcessEnv): Promise<void> {
    this.env = env;
    await this.ensureConnected();
  }

  /** Opens a tab at `url` (claimed by this client) and returns its target id. */
  async openTab(url: string): Promise<string> {
    const conn = await this.ensureConnected();
    const { targetId } = await conn.send<{ targetId?: unknown }>('Target.createTarget', { url });
    if (typeof targetId !== 'string') throw new Error('The Pixebot browser returned no tab id');
    return targetId;
  }

  /** Tabs this client opened or the user shared. */
  async listTabs(): Promise<TabSummary[]> {
    const conn = await this.ensureConnected();
    const { tabs } = await conn.send<{ tabs?: unknown }>('AionRelay.listTabs');
    const list = Array.isArray(tabs) ? tabs.filter(isRelayTab) : [];
    return list.map(({ targetId, title, url, owner }) => ({
      tab: targetId,
      title,
      url,
      owner,
    }));
  }

  /** Closes a tab this client opened. */
  async closeTab(targetId: string): Promise<void> {
    const conn = await this.ensureConnected();
    await conn.send('Target.closeTarget', { targetId });
    this.forgetTab(targetId);
  }

  /** The flattened CDP session id for a tab, attaching once and reusing it afterwards. */
  async session(targetId: string): Promise<string> {
    const conn = await this.ensureConnected();
    const cached = this.sessions.get(targetId);
    if (cached) return cached;
    const attach = conn
      .send<{ sessionId?: unknown }>('Target.attachToTarget', { targetId, flatten: true })
      .then(async ({ sessionId }) => {
        if (typeof sessionId !== 'string') throw new Error('The Pixebot browser returned no session id');
        // Keeps rAF, focus and menus working in a tab the user is not looking at (spec §4 Observation step 1).
        await conn.send('Emulation.setFocusEmulationEnabled', { enabled: true }, sessionId);
        if (this.sessions.get(targetId) === attach) this.sessionIds.set(targetId, sessionId);
        return sessionId;
      });
    this.sessions.set(targetId, attach);
    attach.catch(() => {
      if (this.sessions.get(targetId) === attach) this.sessions.delete(targetId);
    });
    return attach;
  }

  /** Tells the pane (AionRelay.reportAction) that an action ran on `targetId`, for its highlight. */
  async reportAction(targetId: string, action: ReportedAction): Promise<void> {
    const match = TARGET_ID.exec(targetId);
    if (!match) return;
    await this.connection.send('AionRelay.reportAction', { webContentsId: Number(match[1]), ...action });
  }

  /**
   * Asks the user (AionRelay.requestConfirm) to allow a risky action on `targetId`, in the frame `frame` names (the
   * relay looks up that frame's origin itself). Waits for their answer, up to the relay's timeout; fails closed:
   * anything but an explicit Allow, including a lost connection, is false.
   */
  async requestConfirm(
    targetId: string,
    label: string,
    frame: { sessionId: string; frameId: string }
  ): Promise<boolean> {
    const match = TARGET_ID.exec(targetId);
    if (!match) return false;
    try {
      const reply = await this.connection.send<{ allow?: unknown }>('AionRelay.requestConfirm', {
        webContentsId: Number(match[1]),
        label,
        sessionId: frame.sessionId,
        frameId: frame.frameId,
      });
      return reply.allow === true;
    } catch {
      return false;
    }
  }

  /**
   * Runs a script that may change the page (AionRelay.runScript) on `targetId`'s tab session `sessionId`, in `world`.
   * The relay asks the user first, per origin, and waits for their answer up to its timeout. Resolves with the CDP
   * evaluate reply, or null when the user did not allow it; throws when the relay refuses the tab or the script.
   */
  async runWriteScript(
    targetId: string,
    sessionId: string,
    script: { code: string; form: ScriptForm; world: ScriptWorld }
  ): Promise<unknown> {
    const match = TARGET_ID.exec(targetId);
    if (!match) throw new Error(`No tab ${targetId} that you may use; call tabs list to see them.`);
    const reply = await this.connection.send<{ allow?: unknown; reply?: unknown }>('AionRelay.runScript', {
      webContentsId: Number(match[1]),
      sessionId,
      ...script,
    });
    return reply.allow === true ? (reply.reply ?? {}) : null;
  }

  /** True once after the connection was re-established, so callers can tell the agent its old tabs are gone. */
  takeReconnected(): boolean {
    const reconnected = this.reconnected;
    this.reconnected = false;
    return reconnected;
  }

  /** Drops the connection; a later call reconnects. */
  close(): void {
    this.conn?.close();
  }

  private forgetTab(targetId: string): void {
    this.forgetSession(targetId);
    if (this.currentTab === targetId) this.currentTab = null;
  }

  /** Drops a tab's cached session so the next call attaches afresh; the tab itself stays usable. */
  private forgetSession(targetId: string): void {
    this.sessions.delete(targetId);
    this.sessionIds.delete(targetId);
  }

  private ensureConnected(): Promise<CdpConnection> {
    if (this.conn && !this.conn.closed) return Promise.resolve(this.conn);
    this.connecting ??= this.open().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async open(): Promise<CdpConnection> {
    const relay = readRelayEnv(this.env);
    if (!relay) throw new Error(RELAY_ENV_MISSING);
    const backoff = this.retryAt - Date.now();
    if (backoff > 0) await sleep(backoff);
    const url = new URL(relay.url);
    url.searchParams.set('client', clientLabel(this.agentName()));
    let ws: WebSocket;
    try {
      ws = await openSocket(url, relay.token, parseConversationId(this.env.AIONUI_CONVERSATION_ID));
    } catch (error) {
      this.failures += 1;
      this.retryAt = Date.now() + retryDelayMs(this.failures);
      throw new RelayConnectError(error instanceof Error ? error.message : String(error));
    }
    this.failures = 0;
    this.reconnected = this.hadConnection;
    this.hadConnection = true;
    const conn = new CdpConnection(createWebSocketTransport(ws));
    watchFrames(conn); // before any attach: the relay announces a tab's OOPIFs right after the attach reply
    conn.on('Target.targetDestroyed', ({ targetId }) => {
      if (typeof targetId === 'string') this.forgetTab(targetId);
    });
    // A top-level detach (no parent session): the relay ended a tab session (stop sharing, crash, reload).
    conn.on('Target.detachedFromTarget', ({ sessionId }, parent) => {
      if (parent !== undefined || typeof sessionId !== 'string') return;
      for (const [targetId, id] of this.sessionIds) if (id === sessionId) this.forgetSession(targetId);
    });
    conn.onClose(() => {
      if (this.conn !== conn) return;
      this.conn = null;
      this.sessions = new Map();
      this.sessionIds = new Map();
      this.currentTab = null;
    });
    this.conn = conn;
    return conn;
  }
}
