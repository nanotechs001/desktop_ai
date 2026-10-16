/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import type { Dirent } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  ARTIFACT_KINDS,
  ARTIFACT_LIMITS,
  type ArtifactError,
  type ArtifactKind,
  type ArtifactMeta,
  type ArtifactResult,
  type ArtifactVersion,
} from '@/common/types/agent/artifacts';

export type ArtifactStore = {
  create(
    conversationId: string,
    input: { title: string; kind: ArtifactKind; content: string }
  ): Promise<ArtifactResult<ArtifactVersion>>;
  update(
    conversationId: string,
    id: string,
    input: { content: string; title?: string }
  ): Promise<ArtifactResult<ArtifactVersion>>;
  get(conversationId: string, id: string, version?: number): Promise<ArtifactResult<ArtifactVersion>>;
  /** Looks an artifact up by id alone. For the page server only; agent-facing calls must use `get`. */
  getById(id: string, version?: number): Promise<ArtifactResult<ArtifactVersion>>;
  /**
   * Removes the folders of conversations that are not in `liveConversationIds` and returns how many
   * were removed. An empty set deletes nothing unless `allowEmpty` is true: callers must pass the real
   * set of live conversations and must never reach this with an empty set produced by a failed fetch.
   * Run it once at startup, before any `create`: a folder is only skipped while its mtime is within the
   * last 10 minutes, so a conversation created in the same session must not rely on that grace period.
   */
  cleanup(liveConversationIds: ReadonlySet<string>, options?: { allowEmpty?: boolean }): Promise<number>;
};

const EXTENSIONS: Record<ArtifactKind, string> = {
  html: 'html',
  react: 'jsx',
  markdown: 'md',
  mermaid: 'mmd',
  svg: 'svg',
};

const CONVERSATION_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const ARTIFACT_ID_RE = /^[A-Za-z0-9_-]{22}$/;
const META_FILE = 'meta.json';
const NOT_FOUND_MESSAGE = 'Artifact not found';
const IO_MESSAGE = "Couldn't save the artifact";
/** Conversation folders touched more recently than this are never cleaned up (defence in depth). */
const CLEANUP_GRACE_MS = 10 * 60 * 1000;

const fail = (error: ArtifactError, message: string): { ok: false; error: ArtifactError; message: string } => ({
  ok: false,
  error,
  message,
});
const notFound = () => fail('not-found', NOT_FOUND_MESSAGE);
const notFoundError = (): Error => Object.assign(new Error(NOT_FOUND_MESSAGE), { code: 'ENOENT' });
/** ENOENT, or ENOTDIR when a stray file sits where a folder should be: both mean "nothing there". */
const isMissing = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
};

/** Lists a directory; a missing directory (or a file in its place) is empty. */
const listDir = async (dir: string): Promise<Dirent[]> => {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (isMissing(e)) return [];
    throw e;
  }
};

const isMeta = (v: unknown): v is ArtifactMeta => {
  const m = v as Partial<ArtifactMeta> | null;
  return (
    typeof m === 'object' &&
    m !== null &&
    typeof m.id === 'string' &&
    typeof m.conversationId === 'string' &&
    typeof m.title === 'string' &&
    ARTIFACT_KINDS.includes(m.kind as ArtifactKind) &&
    typeof m.createdAt === 'number' &&
    typeof m.updatedAt === 'number' &&
    Number.isInteger(m.latest) &&
    m.latest >= 1
  );
};

/** Validates the fields shared by create and update at runtime; `title` is the trimmed title if given. */
const validateInput = (
  content: unknown,
  title: unknown,
  titleRequired: boolean
): { error: ReturnType<typeof fail> } | { title: string | undefined } => {
  if (typeof content !== 'string') return { error: fail('bad-content', 'Content must be a string') };
  if (Buffer.byteLength(content, 'utf8') > ARTIFACT_LIMITS.maxContentBytes) {
    return { error: fail('too-large', `Content exceeds ${ARTIFACT_LIMITS.maxContentBytes} bytes`) };
  }
  if (title === undefined && !titleRequired) return { title: undefined };
  const trimmed = typeof title === 'string' ? title.trim() : '';
  // Code points, not UTF-16 units, so emoji count once.
  const length = Array.from(trimmed).length;
  if (typeof title !== 'string' || length < 1 || length > ARTIFACT_LIMITS.maxTitleChars) {
    return { error: fail('bad-title', `Title must be 1-${ARTIFACT_LIMITS.maxTitleChars} characters`) };
  }
  return { title: trimmed };
};

/** Creates a store that keeps versioned artifacts under `rootDir/<conversationId>/<id>/`. */
export function createArtifactStore(rootDir: string): ArtifactStore {
  const chains = new Map<string, Promise<unknown>>();
  const idIndex = new Map<string, string>();
  let scan: Promise<void> | undefined;

  /** Runs `task` after every earlier task with the same key, and frees the key once idle. */
  const serialised = <T>(key: string, task: () => Promise<T>): Promise<T> => {
    const run = (chains.get(key) ?? Promise.resolve()).then(task);
    const tail = run.catch((): void => undefined);
    chains.set(key, tail);
    void tail.then(() => {
      if (chains.get(key) === tail) chains.delete(key);
    });
    return run;
  };

  const writeAtomic = async (file: string, data: string): Promise<void> => {
    const tmp = `${file}.${randomBytes(6).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, data, 'utf8');
      await fs.rename(tmp, file);
    } catch (e) {
      await fs.rm(tmp, { force: true }).catch((): void => undefined);
      throw e;
    }
  };

  const artifactDir = (conversationId: string, id: string) => path.join(rootDir, conversationId, id);

  /** True when `p` exists as a real directory; a symlink or file there counts as absent. */
  const isRealDir = async (p: string): Promise<boolean> => {
    try {
      return (await fs.lstat(p)).isDirectory();
    } catch (e) {
      if (isMissing(e)) return false;
      throw e;
    }
  };

  /** Reads and checks meta.json. Every path comes from the validated arguments, never from the file's contents. */
  const readMeta = async (conversationId: string, id: string): Promise<ArtifactMeta> => {
    const dir = artifactDir(conversationId, id);
    if (!(await isRealDir(path.join(rootDir, conversationId))) || !(await isRealDir(dir))) throw notFoundError();
    const parsed: unknown = JSON.parse(await fs.readFile(path.join(dir, META_FILE), 'utf8'));
    if (!isMeta(parsed)) throw new Error('Corrupt artifact metadata');
    // A mismatch also catches case-insensitive filesystems answering for a differently-cased name.
    if (parsed.id !== id || parsed.conversationId !== conversationId) throw notFoundError();
    return parsed;
  };

  const versionFile = (conversationId: string, id: string, kind: ArtifactKind, version: number) =>
    path.join(artifactDir(conversationId, id), `v${version}.${EXTENSIONS[kind]}`);

  const toIoFailure = (e: unknown) => {
    if (isMissing(e)) return notFound();
    console.error('[artifacts] storage error', e);
    return fail('io', IO_MESSAGE);
  };

  const readVersion = async (meta: ArtifactMeta, version: number): Promise<ArtifactResult<ArtifactVersion>> => {
    if (!Number.isInteger(version) || version < 1 || version > meta.latest) return notFound();
    const content = await fs.readFile(versionFile(meta.conversationId, meta.id, meta.kind, version), 'utf8');
    return { ok: true, value: { ...meta, version, content } };
  };

  const get: ArtifactStore['get'] = async (conversationId, id, version) => {
    if (!CONVERSATION_ID_RE.test(conversationId) || !ARTIFACT_ID_RE.test(id)) return notFound();
    try {
      const meta = await readMeta(conversationId, id);
      return await readVersion(meta, version ?? meta.latest);
    } catch (e) {
      return toIoFailure(e);
    }
  };

  const scanRoot = async (): Promise<void> => {
    const conversations = (await listDir(rootDir)).filter((c) => c.isDirectory() && CONVERSATION_ID_RE.test(c.name));
    const listings = await Promise.all(
      conversations.map(async (conv) => ({ conv: conv.name, entries: await listDir(path.join(rootDir, conv.name)) }))
    );
    for (const { conv, entries } of listings) {
      for (const entry of entries) {
        if (entry.isDirectory() && ARTIFACT_ID_RE.test(entry.name)) idIndex.set(entry.name, conv);
      }
    }
  };

  const getById: ArtifactStore['getById'] = async (id, version) => {
    if (!ARTIFACT_ID_RE.test(id)) return notFound();
    try {
      scan ??= scanRoot();
      await scan;
    } catch (e) {
      scan = undefined; // retry on the next call
      return toIoFailure(e);
    }
    const conversationId = idIndex.get(id);
    return conversationId ? get(conversationId, id, version) : notFound();
  };

  const create: ArtifactStore['create'] = async (conversationId, input) => {
    if (!CONVERSATION_ID_RE.test(conversationId)) return notFound();
    if (typeof input !== 'object' || input === null) return fail('bad-content', 'Input must be an object');
    if (!ARTIFACT_KINDS.includes(input.kind)) return fail('bad-kind', `Unknown artifact kind: ${String(input.kind)}`);
    const checked = validateInput(input.content, input.title, true);
    if ('error' in checked) return checked.error;
    const { title } = checked;

    // Serialised per conversation so the 200 limit holds under concurrent creates.
    return serialised(`conv:${conversationId}`, async () => {
      const convDir = path.join(rootDir, conversationId);
      let id = '';
      try {
        // A symlink (or file) in the conversation's place is never written through.
        const convState = await fs.lstat(convDir).then(
          (st) => (st.isDirectory() ? 'dir' : 'other'),
          (e: unknown) => {
            if (isMissing(e)) return 'missing';
            throw e;
          }
        );
        if (convState === 'other') return notFound();
        const existing = await listDir(convDir);
        if (
          existing.filter((e) => e.isDirectory() && ARTIFACT_ID_RE.test(e.name)).length >=
          ARTIFACT_LIMITS.maxPerConversation
        ) {
          return fail('limit-reached', `A conversation holds at most ${ARTIFACT_LIMITS.maxPerConversation} artifacts`);
        }
        id = randomBytes(16).toString('base64url');
        const now = Date.now();
        const meta: ArtifactMeta = {
          id,
          conversationId,
          title: title as string,
          kind: input.kind,
          createdAt: now,
          updatedAt: now,
          latest: 1,
        };
        await fs.mkdir(artifactDir(conversationId, id), { recursive: true });
        await writeAtomic(versionFile(conversationId, id, meta.kind, 1), input.content);
        await writeAtomic(path.join(artifactDir(conversationId, id), META_FILE), JSON.stringify(meta));
        idIndex.set(id, conversationId);
        return { ok: true as const, value: { ...meta, version: 1, content: input.content } };
      } catch (e) {
        if (id)
          await fs.rm(artifactDir(conversationId, id), { recursive: true, force: true }).catch((): void => undefined);
        return toIoFailure(e);
      }
    });
  };

  const update: ArtifactStore['update'] = async (conversationId, id, input) => {
    if (!CONVERSATION_ID_RE.test(conversationId) || !ARTIFACT_ID_RE.test(id)) return notFound();
    if (typeof input !== 'object' || input === null) return fail('bad-content', 'Input must be an object');
    const checked = validateInput(input.content, input.title, false);
    if ('error' in checked) return checked.error;

    return serialised(`id:${id}`, async () => {
      try {
        const current = await readMeta(conversationId, id);
        const next: ArtifactMeta = {
          ...current,
          title: checked.title ?? current.title,
          updatedAt: Date.now(),
          latest: current.latest + 1,
        };
        // Version file first, meta second: until meta lands, `latest` still points at the old version.
        await writeAtomic(versionFile(conversationId, id, next.kind, next.latest), input.content);
        await writeAtomic(path.join(artifactDir(conversationId, id), META_FILE), JSON.stringify(next));
        return { ok: true as const, value: { ...next, version: next.latest, content: input.content } };
      } catch (e) {
        return toIoFailure(e);
      }
    });
  };

  const cleanup: ArtifactStore['cleanup'] = async (liveConversationIds, options) => {
    if (liveConversationIds.size === 0 && !options?.allowEmpty) return 0;
    const stale = (await listDir(rootDir)).filter(
      (e) => e.isDirectory() && CONVERSATION_ID_RE.test(e.name) && !liveConversationIds.has(e.name)
    );
    const outcomes = await Promise.all(
      stale.map(async ({ name }): Promise<boolean> => {
        const dir = path.join(rootDir, name);
        try {
          if (Date.now() - (await fs.lstat(dir)).mtimeMs < CLEANUP_GRACE_MS) return false;
          await fs.rm(dir, { recursive: true, force: true });
          return true;
        } catch (e) {
          console.warn(`[artifacts] could not remove conversation folder "${name}"; retrying on the next cleanup`, e);
          return false;
        }
      })
    );
    const removed = new Set(stale.filter((_, i) => outcomes[i]).map((e) => e.name));
    for (const [id, conv] of idIndex) if (removed.has(conv)) idIndex.delete(id);
    return removed.size;
  };

  return { create, update, get, getById, cleanup };
}
