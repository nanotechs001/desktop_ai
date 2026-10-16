/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** A file download started from the in-app browser. */
export type DownloadItem = {
  id: string;
  url: string;
  filename: string;
  savePath: string;
  state: 'progressing' | 'completed' | 'cancelled' | 'interrupted';
  receivedBytes: number;
  /** 0 when the server did not announce a length. */
  totalBytes: number;
};

/** The only permissions that ever prompt the user; every other one is allowed or denied by policy. */
export type PromptPermission = 'media' | 'geolocation' | 'notifications' | 'clipboard-read' | 'midi' | 'midiSysex';

/** A site permission prompt waiting for the user's answer. */
export type PermissionRequest = {
  id: string;
  origin: string;
  permission: PromptPermission;
  /** `'video'` / `'audio'` for `media` requests; empty otherwise. */
  mediaTypes: string[];
};

/** A keyboard shortcut the in-app browser recognises on a page. */
export type BrowserShortcutAction =
  | 'find'
  | 'focus-address'
  | 'new-tab'
  | 'close-tab'
  | 'reload'
  | 'hard-reload'
  | 'back'
  | 'forward'
  | 'zoom-in'
  | 'zoom-out'
  | 'zoom-reset'
  | 'print'
  | 'escape';

/** The shortcuts main cannot finish itself; the renderer acts on the tab whose webContents id matches. */
export type BrowserShortcutRequest = {
  webContentsId: number;
  action: Extract<BrowserShortcutAction, 'find' | 'focus-address' | 'new-tab' | 'close-tab' | 'escape'>;
};

/** Who may drive a browser tab through the agent relay. */
export type TabOwnership = {
  webContentsId: number;
  /** 'user' for tabs the user opened; an agent client for tabs it opened through the relay. */
  owner: 'user' | { clientId: string; label: string };
  /** 'all' once the user clicked "Share with agent": every agent client may act on the tab. */
  sharedWith: 'all' | null;
  /** The user took over (typed or clicked) an agent or shared tab; agent input is refused until resume. */
  paused: boolean;
};

/** One agent action, reported by the agent's MCP server, for the pane's highlight overlay and action feed. */
export type AgentActionEvent = {
  webContentsId: number;
  clientLabel: string;
  op: string;
  label: string;
  rect: { x: number; y: number; width: number; height: number } | null;
  at: number;
};

/** A risky agent action waiting for the user's Allow or Deny (see agentBrowser/confirmGate). */
export type ConfirmRequest = {
  id: string;
  /** The tab's page origin, derived by main from the tab's committed url, never taken from the agent. */
  origin: string;
  /** The origin of the frame the control sits in, looked up by main; equal to `origin` for the top frame. */
  frameOrigin: string;
  /** The control's label as the page names it, sanitized and bounded. Untrusted text: show it as text only. */
  label: string;
  clientLabel: string;
};
