/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';
import { app, session, webContents } from 'electron';
import { ipcBridge } from '@/common';
import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';
import { installContextMenu } from './contextMenu/contextMenuInstall';
import { installDownloads } from './downloads';
import { initBrowserExtensions, installExtensionProtocols, type BrowserExtensions } from './extensions';
import { installPermissions } from './permissions';
import {
  isTemporaryPartition,
  partitionOfSession,
  profileOfPartition,
  rememberBrowserSession,
} from './profiles/browserProfiles';
import { installBrowserShortcuts } from './shortcuts';
import {
  installChallengeFallback,
  installRequestUserAgent,
  installSiteUserAgent,
  toBrowserUserAgent,
} from './userAgent';
import { installBeforeUnloadDialog, installWindowOpenHandler } from './windowOpen';

export type BrowserSessionDeps = { getMainWindow: () => Electron.BrowserWindow | null };

/** May be async: the dispatch does not await it, and a rejection is logged rather than thrown. */
type BrowserContentsListener = (contents: Electron.WebContents) => void | Promise<void>;

/** An Agent profile's Web Store extensions live in its own partition folder, so deleting the profile removes them. */
const AGENT_EXTENSIONS_DIR = 'WebStoreExtensions';

const listeners = new Set<BrowserContentsListener>();
let initDeps: BrowserSessionDeps | null = null;
/** Every browser session set up so far, by partition. */
const sessions = new Map<string, Electron.Session>();
/** Set per session once its extensions start; missing if they fail, and that profile works without them. */
const extensionsBySession = new Map<Electron.Session, BrowserExtensions>();
/** Per partition: settles once its extensions started or failed to. */
const extensionsSettled = new Map<string, Promise<void>>();

const logListenerError = (error: unknown): void => {
  console.error('[BrowserSession] onBrowserContentsCreated listener failed:', error);
};

/**
 * True for webviews and popup windows living in a browser session: Personal or an Agent profile (see
 * {@link ensureBrowserSession}). The AionUi main window and every other webview (e.g. HTML preview) are excluded.
 */
export function isBrowserContents(contents: Electron.WebContents, mainWindow: Electron.BrowserWindow | null): boolean {
  const type = contents.getType();
  if (type !== 'webview' && type !== 'window') return false;
  if (mainWindow && !mainWindow.isDestroyed() && contents === mainWindow.webContents) return false;
  return partitionOfSession(contents.session) !== null;
}

/**
 * Registers per-contents setup for the in-app browser (permissions, popups, shortcuts, …).
 * A listener runs for browser webContents created after it is registered; existing contents are
 * not replayed, so register during startup, before the renderer loads. Do not rely on listener
 * order. Registering the same function twice shares one slot. Dispatch is synchronous, so a
 * listener's synchronous part runs before the contents' first navigation; a returned promise is
 * not awaited, and its rejection is logged.
 * @returns a function that removes the listener
 */
export function onBrowserContentsCreated(listener: BrowserContentsListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

const extensionsOf = (contents: Electron.WebContents): BrowserExtensions | null =>
  extensionsBySession.get(contents.session) ?? null;

/** Not awaited by the setup: a failure is logged and browsing in that profile carries on without extensions. */
const startExtensions = (
  partition: string,
  browserSession: Electron.Session,
  deps: BrowserSessionDeps
): Promise<void> => {
  const profile = profileOfPartition(partition) ?? undefined;
  const extensionsPath =
    partition === BROWSER_SESSION_PARTITION || !browserSession.storagePath
      ? undefined
      : path.join(browserSession.storagePath, AGENT_EXTENSIONS_DIR);
  return initBrowserExtensions({
    session: browserSession,
    getMainWindow: deps.getMainWindow,
    // An extension's new tab opens in the profile the extension lives in.
    openTab: (url) => ipcBridge.browser.openTabRequested.emit({ url, background: false, profile }),
    closeTab: (webContentsId) => ipcBridge.browser.closeTabRequested.emit({ webContentsId }),
    extensionsPath,
  }).then(
    (ready) => {
      extensionsBySession.set(browserSession, ready);
    },
    (error: unknown) => {
      console.error('[BrowserSession] Chrome extensions are unavailable:', error);
    }
  );
};

/**
 * The browser session of `partition` (Personal, or an Agent partition from `agentPartition`), set up on first use
 * with everything Personal gets: the user agent without the app name, the permission prompt, downloads and extensions;
 * its tabs and popups get the context menu, shortcuts and window-open rules. Lazy, idempotent and cached per
 * partition. Throws before {@link initBrowserSession}, and for any other partition.
 */
export function ensureBrowserSession(partition: string): Electron.Session {
  const existing = sessions.get(partition);
  if (existing) return existing;
  const deps = initDeps;
  if (!deps) throw new Error('The browser session is not initialized yet');
  if (profileOfPartition(partition) === null) throw new Error(`Not a browser profile partition: ${partition}`);

  const browserSession = session.fromPartition(partition);
  sessions.set(partition, browserSession);
  rememberBrowserSession(partition, browserSession);
  browserSession.setUserAgent(toBrowserUserAgent(app.userAgentFallback));
  installRequestUserAgent(browserSession, app.userAgentFallback);
  installChallengeFallback(browserSession, (webContentsId, url) => {
    // Deferred a tick: loading from inside the response's own handling would race it.
    setImmediate(() => {
      const contents = webContents.fromId(webContentsId);
      if (contents && !contents.isDestroyed()) contents.loadURL(url).catch(() => {});
    });
  });
  installDownloads(browserSession);
  installPermissions(browserSession, partition);
  extensionsSettled.set(partition, startExtensions(partition, browserSession, deps));
  return browserSession;
}

/** Forgets a deleted profile's session: the next {@link ensureBrowserSession} for it starts from scratch (or refuses). */
export function forgetBrowserSession(partition: string): void {
  const known = sessions.get(partition);
  if (known) extensionsBySession.delete(known);
  sessions.delete(partition);
  extensionsSettled.delete(partition);
}

/**
 * Resolves once the extensions of a set-up partition have started (or failed to): tabs created after it are known
 * to `chrome.tabs`. Resolves at once for a partition that was never set up.
 */
export const browserExtensionsSettled = (partition: string): Promise<void> =>
  extensionsSettled.get(partition) ?? Promise.resolve();

/**
 * Sets up the Personal browser session (see {@link ensureBrowserSession}) and starts dispatching
 * `onBrowserContentsCreated` listeners for every browser session. Idempotent: only the first call has an effect.
 */
export function initBrowserSession(deps: BrowserSessionDeps): void {
  if (initDeps) return;
  initDeps = deps;

  installExtensionProtocols({
    getMainWindow: deps.getMainWindow,
    resolveSession: (partition) => sessions.get(partition) ?? null,
  });
  ensureBrowserSession(BROWSER_SESSION_PARTITION);

  // Popups are browser contents too, so they get the same window-open rules as the webview that opened them.
  onBrowserContentsCreated((contents) => installWindowOpenHandler(contents, deps.getMainWindow));
  onBrowserContentsCreated((contents) =>
    installContextMenu(
      contents,
      deps.getMainWindow,
      (params) => extensionsOf(contents)?.getContextMenuItems(contents, params) ?? []
    )
  );
  onBrowserContentsCreated((contents) => installBrowserShortcuts(contents));
  // Plain Chrome on sites other than Google's: Electron-detecting sites (Firebase Auth apps) break on the token.
  onBrowserContentsCreated((contents) => installSiteUserAgent(contents, app.userAgentFallback));
  onBrowserContentsCreated((contents) => installBeforeUnloadDialog(contents, deps.getMainWindow));
  // Tabs are webviews; popups stay windows of the page that opened them, not chrome.tabs entries.
  onBrowserContentsCreated((contents) => {
    if (contents.getType() === 'webview') extensionsOf(contents)?.addTab(contents);
  });

  onBrowserContentsCreated(wipeTemporarySessionWhenClosed);

  app.on('web-contents-created', (_event, contents) => {
    if (!isBrowserContents(contents, deps.getMainWindow())) return;
    // Snapshot: registering or unsubscribing during dispatch only affects later contents.
    for (const listener of Array.from(listeners)) {
      try {
        const result = listener(contents);
        if (result instanceof Promise) result.catch(logListenerError);
      } catch (error) {
        logListenerError(error);
      }
    }
  });
}

/** Open tabs/popups per regular-chat temporary partition. */
const liveTemporaryContents = new Map<string, number>();

/**
 * A regular chat's temporary browser lives only while its tabs do: when its last tab or popup closes, its cookies,
 * storage and cache are wiped (the in-memory session is gone on restart anyway). The session itself stays
 * registered, so reopening a tab reuses it, empty, without installing its handlers twice.
 */
function wipeTemporarySessionWhenClosed(contents: Electron.WebContents): void {
  const partition = partitionOfSession(contents.session);
  if (!partition || !isTemporaryPartition(partition)) return;
  const browserSession = contents.session;
  liveTemporaryContents.set(partition, (liveTemporaryContents.get(partition) ?? 0) + 1);
  contents.once('destroyed', () => {
    const left = (liveTemporaryContents.get(partition) ?? 1) - 1;
    if (left > 0) {
      liveTemporaryContents.set(partition, left);
      return;
    }
    liveTemporaryContents.delete(partition);
    Promise.all([browserSession.clearStorageData(), browserSession.clearCache()]).catch((error: unknown) => {
      console.warn('[BrowserSession] could not wipe a temporary chat browser:', error);
    });
  });
}

/** The browser tab the pane last reported on screen. */
let shownTabId: number | null = null;

/** The browser tab the pane last reported on screen (see {@link selectBrowserTab}); null before any report. */
export const shownBrowserTab = (): number | null => shownTabId;

/**
 * Tells extensions which browser tab the user is looking at (`chrome.tabs.onActivated`), and remembers it so agent
 * tab cleanup never closes it. Ids that are gone or not on a browser session are ignored, so a misreported id cannot
 * reach extensions.
 */
export function selectBrowserTab(webContentsId: number): void {
  const contents = webContents.fromId(webContentsId);
  if (!contents || contents.isDestroyed()) return;
  const previous = shownTabId;
  shownTabId = webContentsId;
  extensionsOf(contents)?.selectTab(contents);
  for (const listener of shownListeners) listener(webContentsId, previous);
}

const shownListeners = new Set<(shown: number, previous: number | null) => void>();

/** Called when the pane reports another tab on screen, with the one it replaces. Returns the unsubscribe. */
export function onBrowserTabShown(listener: (shown: number, previous: number | null) => void): () => void {
  shownListeners.add(listener);
  return () => shownListeners.delete(listener);
}
