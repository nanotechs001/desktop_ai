/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { ipcBridge } from '@/common';
import { getEnvAwareName } from '@/common/config/appEnv';
import { isBackendHttpError } from '@/common/adapter/httpBridge';
import { renderArtifactPage } from './pages';
import { startArtifactServer, type ArtifactServer } from './server';
import { createArtifactStore, type ArtifactStore } from './store';

/**
 * `~/.aionui/artifacts` in release, `~/.aionui-dev/artifacts` in dev. Dev and release run separate
 * backends, so a shared folder would let one instance's cleanup delete the other's artifacts.
 */
export const artifactsRoot = (): string => path.join(homedir(), getEnvAwareName('.aionui'), 'artifacts');

const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PAGE_SIZE = 500;
/** 500 x 1000 conversations; past this the list is treated as unreliable. */
const MAX_PAGES = 1000;

/**
 * `out/main/artifact-libs`, where scripts/build-mcp-servers.js puts the bundled libraries: next to the main
 * entry, inside app.asar once packaged (Electron's fs reads it there). Null outside the bundled main process.
 */
const artifactLibsDir = (): string | null =>
  typeof require !== 'undefined' && require.main
    ? path.join(path.dirname(require.main.filename), 'artifact-libs')
    : null;

/**
 * Starts the artifact store and its loopback server with a fresh per-launch token.
 * Returns null (and logs) when it can't start, e.g. the port can't be bound; the rest of the app runs
 * without artifacts.
 */
export async function startArtifacts(
  opts: { rootDir?: string; port?: number } = {}
): Promise<{ server: ArtifactServer; token: string; store: ArtifactStore } | null> {
  try {
    const store = createArtifactStore(opts.rootDir ?? artifactsRoot());
    const token = randomBytes(32).toString('base64url');
    const server = await startArtifactServer({
      store,
      token,
      renderPage: renderArtifactPage,
      libsDir: artifactLibsDir(),
      port: opts.port,
    });
    return { server, token, store };
  } catch (error) {
    console.error('[artifacts] could not start the local server; artifacts are unavailable', error);
    return null;
  }
}

type ConversationPage = { items: { id: string }[]; total: number; has_more: boolean };

export type BackendConversations = {
  /** One page of `GET /api/conversations`; the cursor is the last id of the previous page. */
  listPage(cursor?: string): Promise<ConversationPage>;
  /** Whether the backend still has this conversation (archived ones are not in the list). */
  exists(id: string): Promise<boolean>;
};

/**
 * Every conversation id the backend lists, across all pages. Null when a page fails, is malformed,
 * or the pages don't add up to the reported total: a partial set must never reach cleanup.
 */
export async function fetchLiveConversationIds(
  listPage: BackendConversations['listPage']
): Promise<Set<string> | null> {
  try {
    const ids = new Set<string>();
    let cursor: string | undefined;
    for (let i = 0; i < MAX_PAGES; i++) {
      // eslint-disable-next-line no-await-in-loop -- each cursor comes from the previous page
      const page = await listPage(cursor);
      if (!Array.isArray(page?.items) || page.items.some((c) => typeof c?.id !== 'string')) return null;
      for (const c of page.items) ids.add(c.id);
      if (!page.has_more) return ids.size === page.total ? ids : null;
      if (page.items.length === 0) return null;
      cursor = page.items[page.items.length - 1].id;
    }
    return null;
  } catch {
    return null;
  }
}

const backendConversations: BackendConversations = {
  listPage: (cursor) => ipcBridge.database.getUserConversations.invoke({ cursor, limit: PAGE_SIZE }),
  exists: async (id) => {
    try {
      await ipcBridge.conversation.get.invoke({ id });
      return true;
    } catch (e) {
      if (isBackendHttpError(e) && e.status === 404) return false;
      throw e;
    }
  },
};

/**
 * Deletes the artifact folders of conversations the backend no longer has. Run once at startup, after
 * the backend is up and before any artifact can be created. Any doubt (a failed or partial list, a
 * failed existence check) skips cleanup entirely.
 */
export async function cleanupArtifacts(
  store: ArtifactStore,
  rootDir: string = artifactsRoot(),
  backend: BackendConversations = backendConversations
): Promise<void> {
  try {
    const listed = await fetchLiveConversationIds(backend.listPage);
    if (!listed) {
      console.warn('[artifacts] conversation list unavailable or incomplete; skipping cleanup');
      return;
    }
    const folders = await fs.readdir(rootDir, { withFileTypes: true }).catch((e: NodeJS.ErrnoException): Dirent[] => {
      if (e.code === 'ENOENT') return [];
      throw e;
    });
    const unlisted = folders.filter((f) => f.isDirectory() && CONVERSATION_ID_RE.test(f.name) && !listed.has(f.name));
    const stillThere = await Promise.all(unlisted.map((f) => backend.exists(f.name)));
    const live = new Set([...listed, ...unlisted.filter((_, i) => stillThere[i]).map((f) => f.name)]);
    const removed = await store.cleanup(live, { allowEmpty: false });
    if (removed > 0) console.log(`[artifacts] removed artifacts of ${removed} deleted conversation(s)`);
  } catch (error) {
    console.warn('[artifacts] cleanup skipped', error);
  }
}
