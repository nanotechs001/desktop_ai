/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * How long a vault keeps what it no longer uses: the newest retired notes in `_trash/` and the last months of `log/`.
 * Only plain files directly inside those two folders are ever deleted, never a vault's notes; a folder or file that is
 * a symlink is left alone, so nothing outside the vault can be reached.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/** Retired notes a vault keeps; older ones are deleted. */
export const MAX_TRASHED_NOTES = 200;
/** Days of episodic log a vault keeps. */
export const LOG_KEEP_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const LOG_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/** The plain files directly in `dir`; none when it is missing or not a real folder (a symlink is refused). */
const plainFiles = async (dir: string): Promise<string[]> => {
  const stat = await fs
    .lstat(dir)
    .catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  if (!stat) return [];
  if (!stat.isDirectory()) {
    console.warn('[memory] not pruning a folder that is not a real one', dir);
    return [];
  }
  const entries = await fs.readdir(dir, { withFileTypes: true });
  return entries.filter((entry) => entry.isFile()).map((entry) => entry.name);
};

/** Keeps the newest `MAX_TRASHED_NOTES` files in a vault's trash (by modification time, the moment it was retired). */
export async function pruneTrash(trashDir: string): Promise<void> {
  const names = await plainFiles(trashDir);
  if (names.length <= MAX_TRASHED_NOTES) return;
  const files = await Promise.all(
    names.map(async (name) => ({ name, mtime: (await fs.lstat(path.join(trashDir, name))).mtimeMs }))
  );
  const oldest = files.toSorted((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name)).slice(MAX_TRASHED_NOTES);
  await Promise.all(oldest.map(({ name }) => fs.rm(path.join(trashDir, name), { force: true })));
}

/** Deletes the day logs (`YYYY-MM-DD.md`) older than `LOG_KEEP_DAYS`; any other file is left alone. */
export async function pruneLogs(logDir: string, now: Date): Promise<void> {
  const cutoff = new Date(now.getTime() - LOG_KEEP_DAYS * DAY_MS).toISOString().slice(0, 10);
  const old = (await plainFiles(logDir)).filter((name) => {
    const day = LOG_FILE_RE.exec(name)?.[1];
    return day !== undefined && day < cutoff;
  });
  await Promise.all(old.map((name) => fs.rm(path.join(logDir, name), { force: true })));
}
