/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { app, session } from 'electron';
import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';
import { isGoogleHost, rewriteChromeBrands, toChromeUserAgent } from './userAgent';

export type BrowserSessionDeps = { getMainWindow: () => Electron.BrowserWindow | null };

type BrowserContentsListener = (contents: Electron.WebContents) => void;

/** Requests whose client-hint headers get a "Google Chrome" brand. Mirrors `isGoogleHost`. */
const GOOGLE_URL_FILTER = ['*://*.google.com/*', '*://google.com/*', '*://*.googleusercontent.com/*'];
const BRAND_HEADERS = new Set(['sec-ch-ua', 'sec-ch-ua-full-version-list']);

const listeners = new Set<BrowserContentsListener>();
let initialized = false;

const getBrowserSession = (): Electron.Session => session.fromPartition(BROWSER_SESSION_PARTITION);

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
 * Listeners run for every browser webContents created after `initBrowserSession`.
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

  app.on('web-contents-created', (_event, contents) => {
    if (!isBrowserContents(contents, deps.getMainWindow())) return;
    for (const listener of listeners) {
      try {
        listener(contents);
      } catch (error) {
        console.error('[BrowserSession] onBrowserContentsCreated listener failed:', error);
      }
    }
  });
}
