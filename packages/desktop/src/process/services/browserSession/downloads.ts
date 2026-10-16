/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { app, shell } from 'electron';
import { existsSync, promises as fsp } from 'fs';
import path from 'path';
import { randomUUID } from 'crypto';
import { ipcBridge } from '@/common';
import type { DownloadItem } from '@/common/types/browser';

const MAX_DOWNLOADS = 50;
/** At most 4 `updated` emits per second per item. */
const UPDATE_EMIT_INTERVAL_MS = 250;
const FALLBACK_FILENAME = 'download';

type DownloadEvent = { type: 'started' | 'updated' | 'done'; item: DownloadItem };
type ActionResult = { success: boolean; msg?: string };

// eslint-disable-next-line no-control-regex -- stripping control characters is the point
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f/\\]|\.\./g;

/** Removes path separators, `..` and control characters; `download` when nothing is left. */
export function sanitizeFilename(name: string): string {
  const cleaned = name.replace(UNSAFE_FILENAME_CHARS, '').trim();
  return /^\.*$/.test(cleaned) ? FALLBACK_FILENAME : cleaned;
}

/** `dir/name.ext`, or the first free `dir/name (n).ext` (n >= 1). Dotfiles count as having no extension. */
export function uniqueDownloadPath(dir: string, filename: string, exists: (p: string) => boolean): string {
  const ext = path.extname(filename);
  const base = filename.slice(0, filename.length - ext.length);
  let candidate = path.join(dir, filename);
  for (let n = 1; exists(candidate); n++) candidate = path.join(dir, `${base} (${n})${ext}`);
  return candidate;
}

/** Pure list update: `started` appends, `updated`/`done` replace by id; keeps the 50 newest. */
export function reduceDownloads(items: DownloadItem[], event: DownloadEvent): DownloadItem[] {
  const known = items.some((i) => i.id === event.item.id);
  if (event.type === 'started') {
    const next = known ? items.map((i) => (i.id === event.item.id ? event.item : i)) : [...items, event.item];
    return next.slice(-MAX_DOWNLOADS);
  }
  return known ? items.map((i) => (i.id === event.item.id ? event.item : i)) : [...items];
}

let downloads: DownloadItem[] = [];
/** Live Electron items, kept only while a download is in progress (needed for cancel). */
const activeItems = new Map<string, Electron.DownloadItem>();

const downloadsDir = (): string => process.env.AIONUI_BROWSER_DOWNLOADS_DIR || app.getPath('downloads');

const apply = (event: DownloadEvent): void => {
  downloads = reduceDownloads(downloads, event);
  ipcBridge.browser.downloadsChanged.emit(downloads);
};

const removePartialFile = (savePath: string): void => {
  fsp.unlink(savePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') console.error('[BrowserSession] failed to delete cancelled download:', error);
  });
};

/** Saves a `will-download` item into the downloads folder and tracks it until it finishes. */
export function handleWillDownload(item: Electron.DownloadItem): void {
  const id = randomUUID();
  const savePath = uniqueDownloadPath(downloadsDir(), sanitizeFilename(item.getFilename()), existsSync);
  item.setSavePath(savePath);
  activeItems.set(id, item);

  const snapshot = (state: DownloadItem['state']): DownloadItem => ({
    id,
    url: item.getURL(),
    filename: path.basename(savePath),
    savePath,
    state,
    receivedBytes: item.getReceivedBytes(),
    totalBytes: item.getTotalBytes(),
  });

  let lastUpdateEmit = 0;
  apply({ type: 'started', item: snapshot('progressing') });

  item.on('updated', (_event, state) => {
    const nextItem = snapshot(state);
    const now = Date.now();
    if (now - lastUpdateEmit < UPDATE_EMIT_INTERVAL_MS) {
      // Keep the list fresh for getDownloads without emitting.
      downloads = reduceDownloads(downloads, { type: 'updated', item: nextItem });
      return;
    }
    lastUpdateEmit = now;
    apply({ type: 'updated', item: nextItem });
  });

  item.on('done', (_event, state) => {
    activeItems.delete(id);
    apply({ type: 'done', item: snapshot(state) });
    if (state === 'cancelled') removePartialFile(savePath);
  });
}

/** Current download list, oldest first. */
export function getDownloads(): DownloadItem[] {
  return downloads;
}

const find = (id: string): DownloadItem | undefined => downloads.find((i) => i.id === id);
const unknown: ActionResult = { success: false, msg: 'Unknown download' };

/** Opens a downloaded file with the system default app. */
export async function openDownload(id: string): Promise<ActionResult> {
  const found = find(id);
  if (!found) return unknown;
  try {
    const error = await shell.openPath(found.savePath);
    return error ? { success: false, msg: error } : { success: true };
  } catch (error) {
    return { success: false, msg: error instanceof Error ? error.message : String(error) };
  }
}

/** Reveals a downloaded file in the system file manager. */
export function showDownloadInFolder(id: string): ActionResult {
  const found = find(id);
  if (!found) return unknown;
  try {
    shell.showItemInFolder(found.savePath);
    return { success: true };
  } catch (error) {
    return { success: false, msg: error instanceof Error ? error.message : String(error) };
  }
}

/** Cancels an in-progress download; its partial file is removed when Electron reports `done`. */
export function cancelDownload(id: string): ActionResult {
  const item = activeItems.get(id);
  if (!item) return unknown;
  try {
    item.cancel();
    return { success: true };
  } catch (error) {
    return { success: false, msg: error instanceof Error ? error.message : String(error) };
  }
}

/** Starts saving every download from the given session. */
export function installDownloads(browserSession: Electron.Session): void {
  browserSession.on('will-download', (_event, item) => handleWillDownload(item));
}
