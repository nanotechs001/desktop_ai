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
const UNSAFE_FILENAME_CHARS = /[\u0000-\u001f\u007f/\\<>:"|?*]/g;
const WINDOWS_DEVICE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;
const COMPOUND_EXTENSION = /\.tar\.(gz|bz2|xz|zst)$/i;
const MAX_FILENAME_BYTES = 200;

const byteLength = (text: string): number => Buffer.byteLength(text, 'utf8');

/** Longest prefix of `text` within `maxBytes` UTF-8 bytes, never splitting a code point. */
const truncateBytes = (text: string, maxBytes: number): string => {
  let out = '';
  for (const char of text) {
    if (byteLength(out + char) > maxBytes) break;
    out += char;
  }
  return out;
};

/** Extension including the dot; `.tar.gz`-style archives count as one. Dotfiles have none. */
const extensionOf = (filename: string): string => COMPOUND_EXTENSION.exec(filename)?.[0] ?? path.extname(filename);

/**
 * Makes a server-supplied name safe to save: no path separators, `..`, control or Windows-illegal
 * characters, trailing dots/spaces or device names; at most 200 UTF-8 bytes (extension kept).
 * Returns `download` when nothing is left.
 */
export function sanitizeFilename(name: string): string {
  const cleaned = name
    .replace(UNSAFE_FILENAME_CHARS, '')
    .replace(/\.\./g, '')
    .replace(/[. ]+$/, '')
    .trim();
  if (/^\.*$/.test(cleaned)) return FALLBACK_FILENAME;
  const named = WINDOWS_DEVICE_NAME.test(cleaned) ? `_${cleaned}` : cleaned;
  if (byteLength(named) <= MAX_FILENAME_BYTES) return named;
  const ext = extensionOf(named);
  const keepExt = byteLength(ext) < MAX_FILENAME_BYTES / 2;
  const stem = keepExt ? named.slice(0, named.length - ext.length) : named;
  const suffix = keepExt ? ext : '';
  return truncateBytes(stem, MAX_FILENAME_BYTES - byteLength(suffix)) + suffix;
}

/** `dir/name.ext`, or the first free `dir/name (n).ext` (n >= 1). Dotfiles count as having no extension. */
export function uniqueDownloadPath(dir: string, filename: string, exists: (p: string) => boolean): string {
  const ext = extensionOf(filename);
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
/** Save paths chosen for downloads still in flight; `existsSync` cannot see them yet. */
const reservedPaths = new Set<string>();

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
  const savePath = uniqueDownloadPath(
    downloadsDir(),
    sanitizeFilename(item.getFilename()),
    (p) => existsSync(p) || reservedPaths.has(p)
  );
  reservedPaths.add(savePath);
  try {
    item.setSavePath(savePath);
    activeItems.set(id, item);
    trackDownload(item, id, savePath);
  } catch (error) {
    // No `done` will release this path if setup failed, so free it here.
    reservedPaths.delete(savePath);
    activeItems.delete(id);
    throw error;
  }
}

const trackDownload = (item: Electron.DownloadItem, id: string, savePath: string): void => {
  const snapshot = (state: DownloadItem['state']): DownloadItem => ({
    id,
    url: item.getURL(),
    filename: path.basename(savePath),
    savePath,
    state,
    receivedBytes: item.getReceivedBytes(),
    totalBytes: item.getTotalBytes(),
  });

  item.on('done', (_event, state) => {
    activeItems.delete(id);
    reservedPaths.delete(savePath);
    apply({ type: 'done', item: snapshot(state) });
    if (state === 'cancelled') removePartialFile(savePath);
  });

  let lastUpdateEmit = 0;
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

  apply({ type: 'started', item: snapshot('progressing') });
};

/** Current download list, oldest first. */
export function getDownloads(): DownloadItem[] {
  return downloads;
}

const find = (id: string): DownloadItem | undefined => downloads.find((i) => i.id === id);
const unknown: ActionResult = { success: false, msg: 'Unknown download' };
const notCompleted: ActionResult = { success: false, msg: 'Download is not completed' };

/** Opens a completed download with the system default app. */
export async function openDownload(id: string): Promise<ActionResult> {
  const found = find(id);
  if (!found) return unknown;
  if (found.state !== 'completed') return notCompleted;
  try {
    const error = await shell.openPath(found.savePath);
    return error ? { success: false, msg: error } : { success: true };
  } catch (error) {
    return { success: false, msg: error instanceof Error ? error.message : String(error) };
  }
}

/** Reveals a completed download in the system file manager. */
export function showDownloadInFolder(id: string): ActionResult {
  const found = find(id);
  if (!found) return unknown;
  if (found.state !== 'completed') return notCompleted;
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

/** Test-only: forget all tracked downloads and reserved paths. */
export function __resetDownloadsForTests(): void {
  downloads = [];
  activeItems.clear();
  reservedPaths.clear();
}
