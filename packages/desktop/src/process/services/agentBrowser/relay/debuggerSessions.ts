/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import { targetIdFor, type RelayContents, type RelayDebugger } from './targetRegistry';

/** A CDP event as sent to a relay client. */
export type RelayEvent = { method: string; params: Record<string, unknown>; sessionId?: string };

/** Where a client's events go; `id` identifies the client. */
export type SessionSink = { id: string; emit(event: RelayEvent): void };

export type SessionInfo = {
  webContentsId: number;
  sinkId: string;
  cdpSessionId: string;
  ownContexts: ReadonlySet<number>;
};

export type DebuggerSessions = {
  /**
   * Attaches the tab's debugger (once per tab, shared by every client) and opens a relay session
   * for `sink`. Events for the session are held until `ready()`, so the attach reply goes first.
   * Throws the debugger's own error when attaching fails.
   */
  attach(contents: RelayContents, sink: SessionSink): Promise<string>;
  ready(relaySessionId: string): void;
  /** Sends on the tab's debugger, to the OOPIF child session when the relay session is one. */
  send(relaySessionId: string, method: string, params: Record<string, unknown>): Promise<unknown>;
  session(relaySessionId: string): SessionInfo | null;
  /** Records an isolated world the session created; forgotten when its frame's document changes. */
  addOwnContext(relaySessionId: string, contextId: number): void;
  detachSession(relaySessionId: string): void;
  /** Ends every top session for which `keep` is false, telling its client. */
  prune(keep: (webContentsId: number, sinkId: string) => boolean): void;
  dropSink(sinkId: string): void;
  /** Live sessions (tab and OOPIF) of one client. */
  count(sinkId: string): number;
  dropContents(webContentsId: number): void;
};

const AUTO_ATTACH = { autoAttach: true, flatten: true, waitForDebuggerOnStart: false };
const PROTOCOL_VERSION = '1.3';

type MessageListener = (event: unknown, method: string, params: unknown, sessionId: string) => void;
type DetachListener = (event: unknown, reason: string) => void;

type TabState = {
  dbg: RelayDebugger;
  onMessage: MessageListener;
  onDetach: DetachListener;
  /** OOPIF child sessions by CDP session id, in attach order (parents before children). */
  children: Map<string, { parent: string; params: Record<string, unknown> }>;
};

type Session = SessionInfo & {
  id: string;
  sink: SessionSink;
  /** Parent relay session; null for a top session. */
  parent: string | null;
  /** The top relay session this one hangs off (itself for a top session). */
  root: string;
  /** Events held until the attach reply is sent; null once ready. */
  pending: RelayEvent[] | null;
};

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

const isRootFrame = (params: Record<string, unknown>): boolean => asRecord(params.frame).parentId === undefined;

const logSetupError = (error: unknown): void => {
  console.warn('[AgentBrowserRelay] session setup command failed:', error);
};

/** The relay's own per-session setup: Page events (to see navigations) and OOPIF auto-attach. */
const setUpSession = (dbg: RelayDebugger, cdpSessionId?: string): Promise<unknown> => {
  const send = (method: string, params: object) =>
    cdpSessionId ? dbg.sendCommand(method, params, cdpSessionId) : dbg.sendCommand(method, params);
  return Promise.all([send('Page.enable', {}), send('Target.setAutoAttach', AUTO_ATTACH)]);
};

/** Owns `webContents.debugger` for every browser tab and fans its sessions out to relay clients. */
export function createDebuggerSessions(): DebuggerSessions {
  const tabs = new Map<number, TabState>();
  const sessions = new Map<string, Session>();

  const deliver = (session: Session, event: RelayEvent): void => {
    const root = sessions.get(session.root);
    if (root?.pending) root.pending.push(event);
    else session.sink.emit(event);
  };

  const sessionsOn = (webContentsId: number, cdpSessionId: string): Session[] =>
    Array.from(sessions.values()).filter((s) => s.webContentsId === webContentsId && s.cdpSessionId === cdpSessionId);

  const openChild = (parent: Session, cdpSessionId: string, params: Record<string, unknown>): string => {
    const id = randomUUID();
    sessions.set(id, {
      id,
      webContentsId: parent.webContentsId,
      sinkId: parent.sinkId,
      ownContexts: new Set(),
      sink: parent.sink,
      cdpSessionId,
      parent: parent.id,
      root: parent.root,
      pending: null,
    });
    deliver(parent, { method: 'Target.attachedToTarget', params: { ...params, sessionId: id }, sessionId: parent.id });
    return id;
  };

  /** Removes a session and its descendants; `notify` tells the client a top session ended. */
  const close = (id: string, notify: boolean): void => {
    const session = sessions.get(id);
    if (!session) return;
    for (const child of Array.from(sessions.values()).filter((s) => s.parent === id)) close(child.id, false);
    sessions.delete(id);
    if (notify) {
      session.sink.emit({
        method: 'Target.detachedFromTarget',
        params: { sessionId: id, targetId: targetIdFor(session.webContentsId) },
      });
    }
    releaseTabIfUnused(session.webContentsId);
  };

  const forgetTab = (webContentsId: number): TabState | null => {
    const tab = tabs.get(webContentsId);
    if (!tab) return null;
    tabs.delete(webContentsId);
    tab.dbg.removeListener('message', tab.onMessage);
    tab.dbg.removeListener('detach', tab.onDetach);
    return tab;
  };

  function releaseTabIfUnused(webContentsId: number): void {
    if (Array.from(sessions.values()).some((s) => s.webContentsId === webContentsId)) return;
    const tab = forgetTab(webContentsId);
    try {
      if (tab?.dbg.isAttached()) tab.dbg.detach();
    } catch (error) {
      console.warn('[AgentBrowserRelay] debugger detach failed:', error);
    }
  }

  const dropContents = (webContentsId: number): void => {
    forgetTab(webContentsId);
    for (const s of Array.from(sessions.values())) {
      if (s.webContentsId === webContentsId && s.parent === null) close(s.id, true);
    }
  };

  /** A new document in the session's root frame: isolated worlds made for the old one are gone. */
  const forgetContexts = (webContentsId: number, cdpSessionId: string): void => {
    for (const s of sessionsOn(webContentsId, cdpSessionId)) sessions.set(s.id, { ...s, ownContexts: new Set() });
  };

  const onChildAttached = (
    webContentsId: number,
    tab: TabState,
    parentCdp: string,
    params: Record<string, unknown>
  ) => {
    const cdpSessionId = params.sessionId;
    if (typeof cdpSessionId !== 'string' || tab.children.has(cdpSessionId)) return;
    tab.children.set(cdpSessionId, { parent: parentCdp, params });
    // Nested OOPIFs only attach when auto-attach is set on their parent's session too.
    setUpSession(tab.dbg, cdpSessionId).catch(logSetupError);
    sessionsOn(webContentsId, parentCdp).forEach((parent) => openChild(parent, cdpSessionId, params));
  };

  const onChildDetached = (webContentsId: number, tab: TabState, params: Record<string, unknown>): void => {
    const cdpSessionId = params.sessionId;
    if (typeof cdpSessionId !== 'string') return;
    tab.children.delete(cdpSessionId);
    for (const s of sessionsOn(webContentsId, cdpSessionId)) {
      deliver(s, {
        method: 'Target.detachedFromTarget',
        params: { ...params, sessionId: s.id },
        sessionId: s.parent ?? undefined,
      });
      close(s.id, false);
    }
  };

  const listen = (webContentsId: number, dbg: RelayDebugger): TabState => {
    const tab: TabState = {
      dbg,
      children: new Map(),
      // Child-session events carry their CDP session id as the 4th argument; top-session events carry ''.
      onMessage: (_event, method, rawParams, cdpSessionId) => {
        const params = asRecord(rawParams);
        const source = cdpSessionId ?? '';
        if (method === 'Target.attachedToTarget') return onChildAttached(webContentsId, tab, source, params);
        if (method === 'Target.detachedFromTarget') return onChildDetached(webContentsId, tab, params);
        if (method === 'Page.frameNavigated' && isRootFrame(params)) forgetContexts(webContentsId, source);
        sessionsOn(webContentsId, source).forEach((s) => deliver(s, { method, params, sessionId: s.id }));
      },
      onDetach: () => dropContents(webContentsId),
    };
    dbg.on('message', tab.onMessage);
    dbg.on('detach', tab.onDetach);
    tabs.set(webContentsId, tab);
    return tab;
  };

  /** Re-announces known OOPIF children to a session that attached after them. */
  const replayChildren = (top: Session, tab: TabState): void => {
    const relayIdByCdp = new Map<string, string>([['', top.id]]);
    for (const [cdpSessionId, child] of tab.children) {
      const parentId = relayIdByCdp.get(child.parent);
      const parent = parentId ? sessions.get(parentId) : undefined;
      if (!parent) continue;
      relayIdByCdp.set(cdpSessionId, openChild(parent, cdpSessionId, child.params));
    }
  };

  return {
    async attach(contents, sink) {
      const webContentsId = contents.id;
      let tab = tabs.get(webContentsId);
      const firstAttach = !tab;
      if (!tab) {
        contents.debugger.attach(PROTOCOL_VERSION);
        tab = listen(webContentsId, contents.debugger);
      }
      const id = randomUUID();
      const session: Session = {
        id,
        webContentsId,
        sinkId: sink.id,
        ownContexts: new Set(),
        sink,
        cdpSessionId: '',
        parent: null,
        root: id,
        pending: [],
      };
      sessions.set(id, session);
      replayChildren(session, tab);
      if (firstAttach) {
        try {
          await setUpSession(contents.debugger);
        } catch (error) {
          close(id, false);
          throw error;
        }
      }
      return id;
    },
    ready(relaySessionId) {
      const session = sessions.get(relaySessionId);
      if (!session?.pending) return;
      const held = session.pending;
      sessions.set(relaySessionId, { ...session, pending: null });
      held.forEach((event) => session.sink.emit(event));
    },
    async send(relaySessionId, method, params) {
      const session = sessions.get(relaySessionId);
      const tab = session ? tabs.get(session.webContentsId) : undefined;
      if (!session || !tab) throw new Error(`Unknown sessionId: ${relaySessionId}`);
      return session.cdpSessionId
        ? tab.dbg.sendCommand(method, params, session.cdpSessionId)
        : tab.dbg.sendCommand(method, params);
    },
    session: (relaySessionId) => sessions.get(relaySessionId) ?? null,
    addOwnContext(relaySessionId, contextId) {
      const session = sessions.get(relaySessionId);
      if (session)
        sessions.set(relaySessionId, { ...session, ownContexts: new Set([...session.ownContexts, contextId]) });
    },
    detachSession: (relaySessionId) => close(relaySessionId, false),
    prune(keep) {
      for (const s of Array.from(sessions.values())) {
        if (s.parent === null && !keep(s.webContentsId, s.sinkId)) close(s.id, true);
      }
    },
    dropSink(sinkId) {
      for (const s of Array.from(sessions.values())) {
        if (s.sinkId === sinkId && s.parent === null) close(s.id, false);
      }
    },
    count: (sinkId) => Array.from(sessions.values()).filter((s) => s.sinkId === sinkId).length,
    dropContents,
  };
}
