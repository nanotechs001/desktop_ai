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
  /** The browser partition asking; its remembered decisions are its own. */
  partition: string;
  /** That partition's profile, so the prompt can say whose browser asks. */
  profile: BrowserTabProfile;
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

/**
 * Which browser profile (Electron session) a tab lives in: the user's own, one Agent's (VA Bot,
 * persistent), or a regular chat's temporary in-memory session (gone when its tabs close or the
 * app restarts).
 */
export type BrowserTabProfile =
  | { kind: 'personal' }
  | { kind: 'agent'; agentId: string }
  | { kind: 'temporary'; conversationId: string };

/** A Chromium browser on this Mac whose cookies can be imported into a browser profile. */
export type CookieSourceBrowser = 'chrome' | 'brave' | 'edge' | 'arc' | 'vivaldi';

/** One of that browser's own profiles, as the renderer sees it: names only, no file paths. */
export type CookieImportSource = { browser: CookieSourceBrowser; profileDir: string; profileName: string };

/** Import the cookies of a source profile into `target`; `domains` null means every site. */
export type CookieImportRequest = {
  browser: CookieSourceBrowser;
  profileDir: string;
  target: BrowserTabProfile;
  domains: string[] | null;
};

/** What an import did, in counts only: cookie values never leave main. */
export type CookieImportResult = {
  imported: number;
  sites: number;
  skipped: Record<'expired' | 'undecryptable' | 'rejected', number>;
};

/** Why an import did nothing; the renderer words it, so main never sends paths or English text. */
export type CookieImportErrorCode =
  | 'keychain_denied'
  | 'keychain_missing'
  | 'keychain_timeout'
  | 'source_not_found'
  | 'read_failed'
  | 'busy';

/** An import's answer: its counts, or the reason it imported nothing. */
export type CookieImportOutcome =
  | ({ ok: true } & CookieImportResult)
  | { ok: false; code: CookieImportErrorCode; browser: CookieSourceBrowser };

/** Who may drive a browser tab through the agent relay. */
export type TabOwnership = {
  webContentsId: number;
  /** 'user' for tabs the user opened; an agent client for tabs it opened through the relay. */
  owner: 'user' | { clientId: string; label: string; conversationId?: string };
  /** 'all' once the user clicked "Share with agent": agent clients of the tab's profile may act on it (see mayAct). */
  sharedWith: 'all' | null;
  /** The browser profile the tab lives in; sharing an Agent-profile tab reaches only that Agent's clients. */
  profile: BrowserTabProfile;
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
  /**
   * The origin of the frame the control sits in, looked up by main; equal to `origin` for the top frame. Null for an
   * opaque-origin frame (sandboxed): it has no identity to remember, so it is asked about every time.
   */
  frameOrigin: string | null;
  /** The control's label as the page names it (or a script preview), sanitized and bounded. Untrusted text: show it as text only. */
  label: string;
  clientLabel: string;
  /** The asking agent's chat, else the chat that owns the tab; the ask also shows in that chat. Absent when neither is known. */
  conversationId?: string;
  /**
   * `leave`: not an agent action but a page's "Leave site?" (its beforeunload blocked a navigation); Allow means
   * Leave. The desktop asks it in a native box, so only the chat shows it. `script`: the agent wants to run a script in
   * the page's own JS world (run_script); `label` is then a preview of its code, and "Always allow" is remembered
   * apart from risky clicks. Absent for a risky agent action.
   */
  kind?: 'leave' | 'script';
};
