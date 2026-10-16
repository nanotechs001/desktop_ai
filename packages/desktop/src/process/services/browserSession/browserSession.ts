/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { app, session } from 'electron';
import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';
import { installContextMenu } from './contextMenuInstall';
import { installDownloads } from './downloads';
import { installPermissions } from './permissions';
import { installBrowserShortcuts } from './shortcuts';
import { isGoogleHost, rewriteChromeBrands, toChromeUserAgent } from './userAgent';
import { installWindowOpenHandler } from './windowOpen';

export type BrowserSessionDeps = { getMainWindow: () => Electron.BrowserWindow | null };

/** May be async: the dispatch does not await it, and a rejection is logged rather than thrown. */
type BrowserContentsListener = (contents: Electron.WebContents) => void | Promise<void>;

/** Requests whose client-hint headers get a "Google Chrome" brand. Mirrors `isGoogleHost`. */
const GOOGLE_URL_FILTER = ['*://*.google.com/*', '*://google.com/*', '*://*.googleusercontent.com/*'];
const BRAND_HEADERS = new Set(['sec-ch-ua', 'sec-ch-ua-full-version-list']);

const listeners = new Set<BrowserContentsListener>();
let initialized = false;

const getBrowserSession = (): Electron.Session => session.fromPartition(BROWSER_SESSION_PARTITION);

const logListenerError = (error: unknown): void => {
  console.error('[BrowserSession] onBrowserContentsCreated listener failed:', error);
};

/**
 * True for webviews and popup windows living in the in-app browser's session. The
 * AionUi main window and every other webview (e.g. HTML preview) are excluded.
 */
export function isBrowserContents(contents: Electron.WebContents, mainWindow: Electron.BrowserWindow | null): boolean {
  const type = contents.getType();
  if (type !== 'webview' && type !== 'window') return false;
  if (mainWindow && !mainWindow.isDestroyed() && contents === mainWindow.webContents) return false;
  return contents.session === getBrowserSession();
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

/**
 * Makes the in-app browser's session look like Chrome and starts dispatching
 * `onBrowserContentsCreated` listeners. Idempotent: only the first call has an effect.
 *
 * Electron keeps one `webRequest.onBeforeSendHeaders` listener per session, and this is the
 * only one on the browser session; a later module that needs the event must compose with it.
 */
export function initBrowserSession(deps: BrowserSessionDeps): void {
  if (initialized) return;
  initialized = true;

  const browserSession = getBrowserSession();
  browserSession.setUserAgent(toChromeUserAgent(app.userAgentFallback));
  installDownloads(browserSession);
  installPermissions(browserSession);
  browserSession.webRequest.onBeforeSendHeaders({ urls: GOOGLE_URL_FILTER }, (details, callback) => {
    if (!isGoogleHost(details.url)) {
      callback({ requestHeaders: details.requestHeaders });
      return;
    }
    const requestHeaders = Object.fromEntries(
      Object.entries(details.requestHeaders).map(([name, value]) => [
        name,
        BRAND_HEADERS.has(name.toLowerCase()) ? rewriteChromeBrands(value) : value,
      ])
    );
    callback({ requestHeaders });
  });

  // Popups are browser contents too, so they get the same window-open rules as the webview that opened them.
  onBrowserContentsCreated((contents) => installWindowOpenHandler(contents, deps.getMainWindow));
  onBrowserContentsCreated((contents) => installContextMenu(contents, deps.getMainWindow));
  onBrowserContentsCreated((contents) => installBrowserShortcuts(contents));

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
