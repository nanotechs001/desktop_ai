/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserWindow, Menu, clipboard } from 'electron';
import { ipcBridge } from '@/common';
import { buildContextMenuEntries, type MenuEntry, type MenuTranslate } from './contextMenu';
import { isSafeUrl } from './windowOpen';

const GOOGLE_SEARCH_URL = 'https://www.google.com/search?q=';
const MAX_SEARCH_CHARS = 500;

type ActionEntry = Exclude<MenuEntry, { separator: true }>;
type ContextMenuEvent = Electron.ContextMenuParams;

/** Lazily loads i18n to avoid pulling the initStorage chain in at module load (same as updateBridge). */
const loadTranslate = async (): Promise<MenuTranslate> => {
  const { default: i18n, i18nReady } = await import('@process/services/i18n');
  await i18nReady;
  return (key, options) => String(i18n.t(key, options));
};

const openTab = (url: string): void => {
  if (isSafeUrl(url)) ipcBridge.browser.openTabRequested.emit({ url, background: false });
};

/** Trimmed and capped by code point, so the encoded query never contains a lone surrogate. */
const toSearchUrl = (selection: string): string =>
  GOOGLE_SEARCH_URL + encodeURIComponent(Array.from(selection.trim()).slice(0, MAX_SEARCH_CHARS).join(''));

const runAction = (entry: ActionEntry, contents: Electron.WebContents, params: ContextMenuEvent): void => {
  const arg = entry.arg ?? '';
  switch (entry.action) {
    case 'back':
      return contents.navigationHistory.goBack();
    case 'forward':
      return contents.navigationHistory.goForward();
    case 'reload':
      return contents.reload();
    case 'openLinkInNewTab':
    case 'openImageInNewTab':
      return openTab(arg);
    case 'copyLink':
      return clipboard.writeText(arg);
    case 'copyImage':
      return contents.copyImageAt(params.x, params.y);
    case 'saveImageAs':
      return contents.downloadURL(arg);
    case 'copy':
      return contents.copy();
    case 'cut':
      return contents.cut();
    case 'paste':
      return contents.paste();
    case 'selectAll':
      return contents.selectAll();
    case 'searchSelection':
      return openTab(toSearchUrl(arg));
    case 'replaceMisspelling':
      return contents.replaceMisspelling(arg);
    case 'addToDictionary':
      contents.session.addWordToSpellCheckerDictionary(arg);
      return;
    case 'inspect':
      return contents.inspectElement(params.x, params.y);
  }
};

const toTemplate = (
  entries: MenuEntry[],
  contents: Electron.WebContents,
  params: ContextMenuEvent
): Electron.MenuItemConstructorOptions[] =>
  entries.map((entry) => {
    if ('separator' in entry) return { type: 'separator' };
    return {
      label: entry.label,
      enabled: entry.enabled,
      click: () => {
        try {
          runAction(entry, contents, params);
        } catch (error) {
          console.error(`[BrowserSession] context menu action "${entry.action}" failed:`, error);
        }
      },
    };
  });

/** The window that owns the contents: the host window for a webview guest, itself for a popup. */
const resolveOwner = (
  contents: Electron.WebContents,
  getMainWindow: () => Electron.BrowserWindow | null
): Electron.BrowserWindow | undefined => {
  const owner = BrowserWindow.fromWebContents(contents.hostWebContents ?? contents) ?? getMainWindow();
  return owner && !owner.isDestroyed() ? owner : undefined;
};

const showMenu = async (
  contents: Electron.WebContents,
  params: ContextMenuEvent,
  getMainWindow: () => Electron.BrowserWindow | null,
  extraItems: () => Electron.MenuItemConstructorOptions[]
): Promise<void> => {
  const t = await loadTranslate();
  if (contents.isDestroyed()) return;
  const { navigationHistory } = contents;
  const entries = buildContextMenuEntries(
    params,
    { canGoBack: navigationHistory.canGoBack(), canGoForward: navigationHistory.canGoForward() },
    t
  );
  const extra = extraItems();
  const template = [
    ...toTemplate(entries, contents, params),
    ...(extra.length > 0 ? [{ type: 'separator' as const }, ...extra] : []),
  ];
  Menu.buildFromTemplate(template).popup({ window: resolveOwner(contents, getMainWindow) });
};

/**
 * Gives a browser page a Chrome-style right-click menu (webviews have none by default).
 * @param extraItems extension point: returns items appended after the built-in ones
 */
export function installContextMenu(
  contents: Electron.WebContents,
  getMainWindow: () => Electron.BrowserWindow | null,
  extraItems: () => Electron.MenuItemConstructorOptions[] = () => []
): void {
  contents.on('context-menu', (_event, params) => {
    showMenu(contents, params, getMainWindow, extraItems).catch((error) => {
      console.error('[BrowserSession] failed to show the context menu:', error);
    });
  });
}
