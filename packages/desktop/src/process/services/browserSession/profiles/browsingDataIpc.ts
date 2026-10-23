/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Wires the browser's bookmarks and visit history (see ./browsingData) to the panes and agents: the IPC the address
 * bar and bookmarks menu use, visits recorded as browser tabs load pages, and {@link listBookmarks} for the agent relay.
 */
import path from 'node:path';
import { app } from 'electron';
import { ipcBridge } from '@/common';
import type { Bookmark } from '@/common/types/browser';
import { onBrowserContentsCreated } from '../browserSession';
import { createBookmarkStore, createVisitHistory, suggestUrls } from './browsingData';

const BOOKMARKS_FILE = 'browser-bookmarks.json';
const HISTORY_FILE = 'browser-history.json';
const SUGGESTION_LIMIT = 8;
const MAX_QUERY_LENGTH = 200;

let bookmarkStore: ReturnType<typeof createBookmarkStore> | null = null;

/** The user's bookmarks, for agents (read-only); empty before {@link registerBrowsingDataIpc} ran. */
export const listBookmarks = (): Bookmark[] => bookmarkStore?.list() ?? [];

const failure = (error: unknown) => {
  console.warn('[BrowsingData] IPC handler failed:', error);
  return { success: false as const, msg: error instanceof Error ? error.message : String(error) };
};

const textOf = (value: unknown, max: number): string => (typeof value === 'string' ? value.slice(0, max) : '');

export function registerBrowsingDataIpc(): void {
  const userData = app.getPath('userData');
  const store = createBookmarkStore(path.join(userData, BOOKMARKS_FILE));
  const history = createVisitHistory(path.join(userData, HISTORY_FILE));
  bookmarkStore = store;
  const announce = () => ipcBridge.browser.bookmarks.changed.emit(store.list());

  ipcBridge.browser.bookmarks.list.provider(async () => store.list());
  ipcBridge.browser.bookmarks.add.provider(async (request) => {
    try {
      await store.add(textOf(request?.url, 4096), textOf(request?.title, 1000));
      announce();
      return { success: true };
    } catch (error) {
      return failure(error);
    }
  });
  ipcBridge.browser.bookmarks.remove.provider(async (request) => {
    try {
      await store.remove(textOf(request?.url, 4096));
      announce();
      return { success: true };
    } catch (error) {
      return failure(error);
    }
  });
  ipcBridge.browser.suggestUrls.provider(async (request) =>
    suggestUrls(textOf(request?.query, MAX_QUERY_LENGTH), store.list(), history.entries(), SUGGESTION_LIMIT)
  );

  // Tabs on a saved profile only: a regular chat's temporary browser keeps no history, like its wiped cookies.
  onBrowserContentsCreated((contents) => {
    if (contents.getType() !== 'webview' || !contents.session.isPersistent()) return;
    contents.on('did-navigate', (_event, url) => history.record(url, contents.getTitle()));
    contents.on('page-title-updated', (_event, title) => history.setTitle(contents.getURL(), title));
  });
  app.on('before-quit', () => void history.flush());
}
