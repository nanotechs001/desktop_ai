/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { session as electronSession } from 'electron';
import { ElectronChromeExtensions } from 'electron-chrome-extensions';
import { installChromeWebStore } from 'electron-chrome-web-store';
import { isSafeUrl } from './urlSafety';

export type ExtensionsDeps = {
  session: Electron.Session;
  getMainWindow: () => Electron.BrowserWindow | null;
  openTab: (url: string) => void;
  closeTab: (webContentsId: number) => void;
};

export type BrowserExtensions = {
  addTab(contents: Electron.WebContents): void;
  selectTab(contents: Electron.WebContents): void;
  getContextMenuItems(contents: Electron.WebContents, params: Electron.ContextMenuParams): Electron.MenuItem[];
};

type Waiter = { resolve: (contents: Electron.WebContents) => void };

const TAB_CREATE_TIMEOUT_MS = 10_000;
const EXTENSION_PAGE_PREFIX = 'chrome-extension://';

/**
 * Pairs `chrome.tabs.create` calls with the browser webviews that attach afterwards. The renderer
 * opens tabs asynchronously and reports no request id back, so the oldest waiter takes the next tab.
 */
export class CreateTabWaiter {
  private pending: Waiter[] = [];

  /** Resolves with the next attached tab, or rejects with 'tab-create-timeout' after `timeoutMs`. */
  wait(url: string, timeoutMs: number): Promise<Electron.WebContents> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        resolve: (contents) => {
          clearTimeout(timer);
          resolve(contents);
        },
      };
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((entry) => entry !== waiter);
        console.warn(`[BrowserExtensions] no browser tab attached for ${url}`);
        reject(new Error('tab-create-timeout'));
      }, timeoutMs);
      this.pending = [...this.pending, waiter];
    });
  }

  /** Hands a newly attached browser tab to the oldest waiter, if any. */
  onAttached(contents: Electron.WebContents): void {
    const [next, ...rest] = this.pending;
    this.pending = rest;
    next?.resolve(contents);
  }
}

/**
 * Adds Chrome extension support to the in-app browser session: `chrome.tabs` mapped onto AionUi's
 * browser tabs, action icons/popups for `<browser-action-list>`, context-menu items, and installs
 * from the Chrome Web Store with auto-update. Throws if the extensions library cannot start; a
 * failed web store setup is only logged, so extensions already loaded keep working.
 */
export async function initBrowserExtensions(deps: ExtensionsDeps): Promise<BrowserExtensions> {
  const { session, getMainWindow, openTab, closeTab } = deps;
  const waiter = new CreateTabWaiter();
  const liveMainWindow = (): Electron.BrowserWindow | null => {
    const mainWindow = getMainWindow();
    return mainWindow && !mainWindow.isDestroyed() ? mainWindow : null;
  };

  const extensions = new ElectronChromeExtensions({
    license: 'GPL-3.0',
    session,
    createTab: async (details) => {
      const url = details.url ?? 'about:blank';
      // chrome-extension:// is allowed for extension-created tabs only (options and onboarding pages);
      // every other new-tab path stays limited to isSafeUrl.
      if (!isSafeUrl(url) && !url.startsWith(EXTENSION_PAGE_PREFIX)) throw new Error(`unsafe tab url: ${url}`);
      const mainWindow = liveMainWindow();
      if (!mainWindow) throw new Error('no main window to open a tab in');
      const attached = waiter.wait(url, TAB_CREATE_TIMEOUT_MS);
      openTab(url);
      return [await attached, mainWindow];
    },
    // Also called when a tracked tab is destroyed; the renderer then finds no matching tab and ignores it.
    removeTab: (tab) => closeTab(tab.id),
  });

  // <browser-action-list> lives in the main window, whose pages use the default session.
  ElectronChromeExtensions.handleCRXProtocol(electronSession.defaultSession);

  // Not awaited: loading installed extensions from disk must not delay tracking tabs.
  installChromeWebStore({ session, autoUpdate: true }).catch((error: unknown) => {
    console.error('[BrowserExtensions] Chrome Web Store setup failed:', error);
  });

  return {
    addTab: (contents) => {
      const mainWindow = liveMainWindow();
      if (!mainWindow) return;
      extensions.addTab(contents, mainWindow);
      waiter.onAttached(contents);
    },
    selectTab: (contents) => extensions.selectTab(contents),
    getContextMenuItems: (contents, params) => extensions.getContextMenuItems(contents, params),
  };
}
