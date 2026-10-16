/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { dialog, session as electronSession } from 'electron';
import { ElectronChromeExtensions, setSessionPartitionResolver } from 'electron-chrome-extensions';
import { installChromeWebStore } from 'electron-chrome-web-store';
import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';
import { loadTranslate } from './contextMenuInstall';
import { CreateTabWaiter, offerNewTab } from '@process/services/agentBrowser/tabWaiter';
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

type BeforeInstall = NonNullable<NonNullable<Parameters<typeof installChromeWebStore>[0]>['beforeInstall']>;
type InstallDetails = Parameters<BeforeInstall>[0];

/** What an extension asks for, as shown in the install dialog. */
export type InstallSummary = { permissions: string[]; hostPermissions: string[] };
/** The install dialog's content: the extension's name plus what it asks for. */
export type InstallPrompt = InstallSummary & { name: string };

const TAB_CREATE_TIMEOUT_MS = 10_000;
const EXTENSION_PAGE_PREFIX = 'chrome-extension://';
const WEB_STORE_HOST = 'chromewebstore.google.com';
const CRX_PREFIX = 'crx:';
const INSTALL_KEY = 'preview.browserChrome.extensions';
/** Button order in the install dialog; Cancel is also what Esc / closing the dialog returns. */
const ADD_BUTTON = 0;
const CANCEL_BUTTON = 1;

/** True only for https://chromewebstore.google.com pages: exact host, no lookalikes, no other port. */
export const isWebStoreUrl = (url: string): boolean => {
  try {
    const { protocol, host } = new URL(url);
    return protocol === 'https:' && host === WEB_STORE_HOST;
  } catch {
    return false;
  }
};

/** MV2 lists host patterns among `permissions`; these are the patterns Chrome treats as site access. */
const isHostPattern = (permission: string): boolean => permission === '<all_urls>' || permission.includes('://');

/** Splits a manifest's requests into API permissions and site access, as Chrome's install prompt does. */
export function describeInstall(manifest: chrome.runtime.Manifest): InstallSummary {
  const declared = (manifest.permissions ?? []).filter((p): p is string => typeof p === 'string');
  const hostPermissions = 'host_permissions' in manifest ? (manifest.host_permissions ?? []) : [];
  const scriptMatches = (manifest.content_scripts ?? []).flatMap((script) => script.matches ?? []);
  return {
    permissions: [...new Set(declared.filter((p) => !isHostPattern(p)))],
    hostPermissions: [...new Set([...declared.filter(isHostPattern), ...hostPermissions, ...scriptMatches])],
  };
}

/**
 * The Web Store `beforeInstall` hook: re-checks that the request comes from the real Web Store page
 * (the library's own origin gate is patched to an exact host match too), then installs only if the
 * user confirms.
 */
export function createBeforeInstall(confirm: (prompt: InstallPrompt) => Promise<boolean>): BeforeInstall {
  return async ({ frame, localizedName, manifest }: InstallDetails) => {
    if (frame.isDestroyed() || !isWebStoreUrl(frame.url)) return { action: 'deny' };
    const allowed = await confirm({ name: localizedName, ...describeInstall(manifest) });
    return { action: allowed ? 'allow' : 'deny' };
  };
}

/** Native "Add “name”?" dialog on the main window; resolves true only for Add. */
const confirmInstall = async (parent: Electron.BrowserWindow | null, prompt: InstallPrompt): Promise<boolean> => {
  if (!parent) return false;
  const t = await loadTranslate();
  const sections = [
    prompt.permissions.length > 0 ? `${t(`${INSTALL_KEY}.permissions`)}\n${prompt.permissions.join('\n')}` : '',
    prompt.hostPermissions.length > 0 ? `${t(`${INSTALL_KEY}.sites`)}\n${prompt.hostPermissions.join('\n')}` : '',
  ].filter(Boolean);
  const { response } = await dialog.showMessageBox(parent, {
    type: 'question',
    message: t(`${INSTALL_KEY}.addTitle`, { name: prompt.name }),
    detail: sections.join('\n\n'),
    buttons: [t(`${INSTALL_KEY}.add`), t(`${INSTALL_KEY}.cancel`)],
    defaultId: CANCEL_BUTTON,
    cancelId: CANCEL_BUTTON,
    noLink: true,
  });
  return response === ADD_BUTTON;
};

/**
 * Adds Chrome extension support to the in-app browser session: `chrome.tabs` mapped onto AionUi's
 * browser tabs, action icons/popups for `<browser-action-list>`, context-menu items, and installs
 * from the Chrome Web Store with auto-update. Throws if the extensions library cannot start; a
 * failed web store setup is only logged, so extensions already loaded keep working.
 */
export async function initBrowserExtensions(deps: ExtensionsDeps): Promise<BrowserExtensions> {
  const { session, getMainWindow, openTab, closeTab } = deps;
  const waiter = new CreateTabWaiter<Electron.WebContents>();
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

  // <browser-action-list> lives in the main window, whose pages use the default session. Only the
  // browser partition resolves (no partition is created on request), and only the main window may
  // load crx:// at all, so other default-session pages cannot probe which extensions are installed.
  setSessionPartitionResolver((partition) => {
    if (partition !== BROWSER_SESSION_PARTITION) throw new Error(`unknown extensions partition: ${partition}`);
    return session;
  });
  ElectronChromeExtensions.handleCRXProtocol(electronSession.defaultSession);
  // Unfiltered: webRequest URL patterns reject custom schemes ("Wrong scheme type"), so crx:// is
  // matched here. This is the default session's only onBeforeRequest listener (Electron keeps one).
  electronSession.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    if (!details.url.startsWith(CRX_PREFIX)) return callback({});
    callback({
      cancel: details.webContentsId === undefined || details.webContentsId !== liveMainWindow()?.webContents.id,
    });
  });

  // Not awaited: loading installed extensions from disk must not delay tracking tabs.
  const beforeInstall = createBeforeInstall((prompt) => confirmInstall(liveMainWindow(), prompt));
  installChromeWebStore({ session, autoUpdate: true, beforeInstall }).catch((error: unknown) => {
    console.error('[BrowserExtensions] Chrome Web Store setup failed:', error);
  });

  return {
    addTab: (contents) => {
      const mainWindow = liveMainWindow();
      if (!mainWindow) return;
      extensions.addTab(contents, mainWindow);
      offerNewTab(waiter, contents);
    },
    selectTab: (contents) => extensions.selectTab(contents),
    getContextMenuItems: (contents, params) => extensions.getContextMenuItems(contents, params),
  };
}
