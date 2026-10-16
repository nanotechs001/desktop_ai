/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TabOwnership } from '@/common/types/browser';

/** One relay WebSocket connection (an agent's MCP server). */
export type RelayClient = { clientId: string; label: string };

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
  getTitle(): string;
  isDestroyed(): boolean;
  reload(): void;
  reloadIgnoringCache(): void;
  once(event: 'destroyed', listener: () => void): unknown;
};

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
  /** Starts tracking a browser tab (user-owned) until it is destroyed. Tracking twice is a no-op. */
  track(contents: RelayContents): void;
  contents(webContentsId: number): RelayContents | null;
  listTargets(): RelayTargetInfo[];
  ownership(webContentsId: number): TabOwnership | null;
  all(): TabOwnership[];
  claim(webContentsId: number, client: RelayClient): void;
  share(webContentsId: number, on: boolean): void;
  setPaused(webContentsId: number, paused: boolean): void;
  /** The client disconnected: its tabs stay open under a label nobody can reclaim. */
  releaseClient(clientId: string): void;
  /**
   * Records an agent `Input.dispatchMouseEvent` mousePressed at `point` (CSS px) while it is in flight,
   * because Electron reports it as a mouseDown too. Call the returned function when the command settles.
   */
  beginAgentInput(webContentsId: number, point: { x: number; y: number }): () => void;
  /** User keyDown or mouseDown on a tab: pauses agent input on agent-owned or shared tabs. */
  noteUserInput(webContentsId: number, input: UserInput): void;
  onChange(cb: (all: TabOwnership[]) => void): () => void;
  onDestroyed(cb: (last: TabOwnership) => void): () => void;
};

/** A user keyDown, or a mouseDown at CSS-px coordinates in the tab. */
export type UserInput = { kind: 'key' } | { kind: 'mouse'; x: number; y: number };

const TARGET_PREFIX = 'wc-';
/** How far (CSS px) Electron's report of an agent click may land from the CDP coordinates. */
const AGENT_CLICK_TOLERANCE_PX = 2;
/** An in-flight agent click is forgotten after this even if its command never settles. */
const AGENT_INPUT_TTL_MS = 5000;

type AgentClick = { x: number; y: number };

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
  const agentClicks = new Map<number, AgentClick[]>();
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
    track(contents) {
      if (tabs.has(contents.id) || contents.isDestroyed()) return;
      const webContentsId = contents.id;
      tabs.set(webContentsId, {
        contents,
        ownership: { webContentsId, owner: 'user', sharedWith: null, paused: false },
      });
      contents.once('destroyed', () => {
        const tab = tabs.get(webContentsId);
        if (!tab) return;
        tabs.delete(webContentsId);
        agentClicks.delete(webContentsId);
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
    claim: (webContentsId, client) => update(webContentsId, { owner: { ...client } }),
    share: (webContentsId, on) => update(webContentsId, { sharedWith: on ? 'all' : null }),
    setPaused: (webContentsId, paused) => update(webContentsId, { paused }),
    releaseClient(clientId) {
      for (const { ownership } of tabs.values()) {
        if (ownership.owner !== 'user' && ownership.owner.clientId === clientId) {
          update(ownership.webContentsId, {
            owner: { clientId: `disconnected:${clientId}`, label: DISCONNECTED_LABEL },
          });
        }
      }
    },
    beginAgentInput(webContentsId, point) {
      const click: AgentClick = { ...point };
      agentClicks.set(webContentsId, [...(agentClicks.get(webContentsId) ?? []), click]);
      const end = (): void => {
        clearTimeout(timer);
        const left = (agentClicks.get(webContentsId) ?? []).filter((entry) => entry !== click);
        if (left.length > 0) agentClicks.set(webContentsId, left);
        else agentClicks.delete(webContentsId);
      };
      const timer = setTimeout(end, AGENT_INPUT_TTL_MS);
      timer.unref?.();
      return end;
    },
    noteUserInput(webContentsId, input) {
      const ownership = tabs.get(webContentsId)?.ownership;
      if (!ownership || ownership.paused) return;
      if (ownership.owner === 'user' && ownership.sharedWith === null) return;
      if (input.kind === 'mouse') {
        // Electron fires before-mouse-event for the relay's own CDP mousePressed (measured on 37.10.3);
        // that one report is consumed instead of pausing. Keys are never suppressed.
        const clicks = agentClicks.get(webContentsId) ?? [];
        const own = clicks.find(
          (c) =>
            Math.abs(c.x - input.x) <= AGENT_CLICK_TOLERANCE_PX && Math.abs(c.y - input.y) <= AGENT_CLICK_TOLERANCE_PX
        );
        if (own) {
          agentClicks.set(
            webContentsId,
            clicks.filter((c) => c !== own)
          );
          return;
        }
      }
      update(webContentsId, { paused: true });
    },
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
