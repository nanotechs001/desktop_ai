/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BrowserTabProfile, TabOwnership } from '@/common/types/browser';

/**
 * One relay WebSocket connection (an agent's MCP server). `profile` is its chat's Agent profile, set once main has
 * resolved it; until then the client reaches no shared Agent-profile tab.
 */
export type RelayClient = {
  clientId: string;
  label: string;
  profile?: BrowserTabProfile;
  /** The chat the client's MCP runs for; recorded on tabs it claims so the WebUI can list a chat's tabs. */
  conversationId?: string;
};

/** The part of `webContents.debugger` the relay uses; Electron's Debugger satisfies it. */
export type RelayDebugger = {
  attach(protocolVersion?: string): void;
  detach(): void;
  isAttached(): boolean;
  sendCommand(method: string, commandParams?: object, sessionId?: string): Promise<unknown>;
  on(event: 'message', listener: (event: unknown, method: string, params: unknown, sessionId: string) => void): unknown;
  on(event: 'detach', listener: (event: unknown, reason: string) => void): unknown;
  removeListener(
    event: 'message',
    listener: (event: unknown, method: string, params: unknown, sessionId: string) => void
  ): unknown;
  removeListener(event: 'detach', listener: (event: unknown, reason: string) => void): unknown;
};

/** The part of a browser tab's WebContents the relay uses. */
export type RelayContents = {
  readonly id: number;
  readonly debugger: RelayDebugger;
  getURL(): string;
  /** The committed main frame; `getURL()` may already show a navigation that has not committed. */
  readonly mainFrame: { readonly url: string };
  getTitle(): string;
  isDestroyed(): boolean;
  reload(): void;
  reloadIgnoringCache(): void;
  once(event: 'destroyed', listener: () => void): unknown;
  on(event: 'did-start-navigation', listener: NavigationListener): unknown;
  removeListener(event: 'did-start-navigation', listener: NavigationListener): unknown;
};

/** A navigation starting in the tab; `isSameDocument` is a fragment or history-API change. */
export type NavigationListener = (details: { isMainFrame: boolean; isSameDocument?: boolean }) => void;

/** A CDP `TargetInfo` for one browser tab. */
export type RelayTargetInfo = {
  targetId: string;
  type: 'page';
  title: string;
  url: string;
  attached: boolean;
  canAccessOpener: false;
};

export type TargetRegistry = {
  /** Starts tracking a browser tab of `profile` (Personal if unset), user-owned, until it is destroyed. Tracking twice is a no-op. */
  track(contents: RelayContents, profile?: BrowserTabProfile): void;
  contents(webContentsId: number): RelayContents | null;
  listTargets(): RelayTargetInfo[];
  ownership(webContentsId: number): TabOwnership | null;
  all(): TabOwnership[];
  claim(webContentsId: number, client: RelayClient): void;
  /** A tab or popup an agent-owned page opened: claimed for the opener's owner and chat. No-op for a user opener. */
  inherit(openerId: number, childId: number): void;
  share(webContentsId: number, on: boolean): void;
  /** The client disconnected: its tabs stay open under a label nobody can reclaim. */
  releaseClient(clientId: string): void;
  /** Marks a tab used now: by an agent command (with that agent's chat, when known) or by user input. */
  touch(webContentsId: number, conversationId?: string): void;
  /** When the tab was last used (tracked counts as used), and the chat of the last agent that used it. */
  lastUse(webContentsId: number): TabUse | null;
  /**
   * Records an agent key (`Input.dispatchKeyEvent` keyDown/rawKeyDown, or `Input.insertText`) while its command is
   * in flight, because Electron reports it as a keyDown too. Call the returned function when the command settles.
   */
  beginAgentKey(webContentsId: number, key: KeyInput): () => void;
  /** True while an agent key matching Electron's report `key` is in flight on the tab. */
  isAgentKey(webContentsId: number, key: KeyInput): boolean;
  /** A keyDown on the tab: the user typed, unless it is an in-flight agent key. Without `key` (the phone), always the user. */
  noteUserKey(webContentsId: number, key?: KeyInput): void;
  /** The tab committed a new document: what the user typed is gone. */
  clearTyped(webContentsId: number): void;
  /** The user typed on the tab's current document: an agent must not leave or close it unasked. */
  typedSinceLoad(webContentsId: number): boolean;
  onChange(cb: (all: TabOwnership[]) => void): () => void;
  onDestroyed(cb: (last: TabOwnership) => void): () => void;
};

/** Kept apart from ownership: a use changes nothing the pane draws, so it notifies nobody. */
export type TabUse = { at: number; conversationId?: string };

/** A key as Electron reports it and CDP sends it. */
export type KeyInput = { key: string; code: string };

const TARGET_PREFIX = 'wc-';
/** An in-flight agent key is forgotten after this even if its command never settles. */
const AGENT_KEY_TTL_MS = 5000;

const logListenerError = (error: unknown): void => {
  console.error('[AgentBrowserRelay] registry listener failed:', error);
};

/** Runs every listener even when one throws. */
const callEach = <A>(listeners: Iterable<(arg: A) => void>, arg: A): void => {
  for (const listener of listeners) {
    try {
      listener(arg);
    } catch (error) {
      logListenerError(error);
    }
  }
};
const DISCONNECTED_LABEL = 'agent (disconnected)';
const PERSONAL_PROFILE: BrowserTabProfile = { kind: 'personal' };

/** The CDP target id of a browser tab. */
export const targetIdFor = (webContentsId: number): string => `${TARGET_PREFIX}${webContentsId}`;

/** The webContents id behind a relay target id, or null when it is not one. */
export const webContentsIdFromTargetId = (targetId: string): number | null => {
  const match = /^wc-(\d{1,9})$/.exec(targetId);
  return match ? Number(match[1]) : null;
};

/** In-memory registry of the in-app browser's tabs and who may drive them. */
export function createTargetRegistry(): TargetRegistry {
  const tabs = new Map<number, { contents: RelayContents; ownership: TabOwnership }>();
  const uses = new Map<number, TabUse>();
  const agentKeys = new Map<number, KeyInput[]>();
  const typed = new Set<number>();
  const isAgentKey = (webContentsId: number, { key, code }: KeyInput): boolean =>
    (agentKeys.get(webContentsId) ?? []).some((agent) => agent.key === key && agent.code === code);
  const changeListeners = new Set<(all: TabOwnership[]) => void>();
  const destroyedListeners = new Set<(last: TabOwnership) => void>();

  const all = (): TabOwnership[] => Array.from(tabs.values(), (tab) => tab.ownership);
  const notify = (): void => {
    callEach(changeListeners, all());
  };
  const update = (webContentsId: number, patch: Partial<TabOwnership>): void => {
    const tab = tabs.get(webContentsId);
    if (!tab) return;
    tabs.set(webContentsId, { ...tab, ownership: { ...tab.ownership, ...patch } });
    notify();
  };

  return {
    track(contents, profile = PERSONAL_PROFILE) {
      if (tabs.has(contents.id) || contents.isDestroyed()) return;
      const webContentsId = contents.id;
      tabs.set(webContentsId, {
        contents,
        ownership: { webContentsId, owner: 'user', sharedWith: null, profile },
      });
      uses.set(webContentsId, { at: Date.now() });
      contents.once('destroyed', () => {
        const tab = tabs.get(webContentsId);
        if (!tab) return;
        tabs.delete(webContentsId);
        uses.delete(webContentsId);
        agentKeys.delete(webContentsId);
        typed.delete(webContentsId);
        callEach(destroyedListeners, tab.ownership);
        notify();
      });
      notify();
    },
    contents: (webContentsId) => tabs.get(webContentsId)?.contents ?? null,
    listTargets: () =>
      Array.from(tabs.values(), ({ contents }) => ({
        targetId: targetIdFor(contents.id),
        type: 'page' as const,
        title: contents.getTitle(),
        url: contents.getURL(),
        attached: contents.debugger.isAttached(),
        canAccessOpener: false as const,
      })),
    ownership: (webContentsId) => tabs.get(webContentsId)?.ownership ?? null,
    all,
    claim: (webContentsId, { clientId, label, conversationId }) =>
      update(webContentsId, { owner: { clientId, label, ...(conversationId ? { conversationId } : {}) } }),
    inherit(openerId, childId) {
      const owner = tabs.get(openerId)?.ownership.owner;
      if (!owner || owner === 'user' || !tabs.has(childId)) return;
      update(childId, { owner: { ...owner } });
    },
    share: (webContentsId, on) => update(webContentsId, { sharedWith: on ? 'all' : null }),
    releaseClient(clientId) {
      for (const { ownership } of tabs.values()) {
        if (ownership.owner !== 'user' && ownership.owner.clientId === clientId) {
          const { conversationId } = ownership.owner;
          update(ownership.webContentsId, {
            owner: {
              clientId: `disconnected:${clientId}`,
              label: DISCONNECTED_LABEL,
              ...(conversationId ? { conversationId } : {}),
            },
          });
        }
      }
    },
    touch(webContentsId, conversationId) {
      const previous = uses.get(webContentsId);
      if (!previous) return;
      const chat = conversationId ?? previous.conversationId;
      uses.set(webContentsId, { at: Date.now(), ...(chat ? { conversationId: chat } : {}) });
    },
    lastUse: (webContentsId) => uses.get(webContentsId) ?? null,
    beginAgentKey(webContentsId, key) {
      const own: KeyInput = { ...key };
      agentKeys.set(webContentsId, [...(agentKeys.get(webContentsId) ?? []), own]);
      const end = (): void => {
        clearTimeout(timer);
        const left = (agentKeys.get(webContentsId) ?? []).filter((entry) => entry !== own);
        if (left.length > 0) agentKeys.set(webContentsId, left);
        else agentKeys.delete(webContentsId);
      };
      const timer = setTimeout(end, AGENT_KEY_TTL_MS);
      timer.unref?.();
      return end;
    },
    isAgentKey,
    noteUserKey(webContentsId, key) {
      // Not consumed: a matching report while the agent's key is in flight is the agent's (the user pressing the very
      // same key in those few ms is missed, which only lets one leave go unasked).
      if (!tabs.has(webContentsId) || (key && isAgentKey(webContentsId, key))) return;
      typed.add(webContentsId);
    },
    clearTyped: (webContentsId) => {
      typed.delete(webContentsId);
    },
    typedSinceLoad: (webContentsId) => typed.has(webContentsId),
    onChange(cb) {
      changeListeners.add(cb);
      return () => changeListeners.delete(cb);
    },
    onDestroyed(cb) {
      destroyedListeners.add(cb);
      return () => destroyedListeners.delete(cb);
    },
  };
}
