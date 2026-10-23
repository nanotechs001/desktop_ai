/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Agent memory vaults: `<root>/agents/<agentId>/` for what one agent learned, `<root>/shared/` for what every agent
 * knows about the user. Each vault holds `notes/<id>.md`, a generated `index.md` and a `_trash/` for retired notes.
 * Every path comes from a validated id, never from file contents; symlinks are refused (checked again before each
 * write); a write must send the version it read, so an edit made elsewhere (another write, Obsidian) is never lost.
 */

import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  MEMORY_LIMITS,
  MEMORY_NOTE_TYPES,
  type MemoryError,
  type MemoryHygieneReport,
  type MemoryNote,
  type MemoryNoteInput,
  type MemoryNoteMeta,
  type MemoryNotePatch,
  type MemoryResult,
  type MemoryVaultRef,
} from '@/common/types/agent/memory';
import {
  checkInput,
  charCount,
  checkReason,
  isChatId,
  oneLine,
  scoreNote,
  tokenize,
  extraKeysOf,
  neutralise,
  NOTE_ID_RE,
  numberedId,
  parseNote,
  serialiseNote,
  slugify,
  type CheckedInput,
  type NoteFields,
} from './memoryNote';
import { createSerialiser, writeAtomic } from '../store';
import { hygieneReport } from './memoryHygiene';
import { pruneLogs, pruneTrash } from './memoryRetention';

const OWNER_FILE = '.owner.json';
const NOTES_DIR = 'notes';
const TRASH_DIR = '_trash';
const LOG_DIR = 'log';
const CORE_FILE = 'CORE.md';
/** Written once an agent's old one-line notebook has been copied into its vault. */
const MIGRATED_FILE = '.migrated-notebook';
const MAX_CORE_CHARS = 1500;
const MAX_LOG_LINE_CHARS = 500;
/** One day's log; past it the agent is told to stop logging for the day. */
const MAX_LOG_BYTES = 256 * 1024;
const INDEX_FILE = 'index.md';
/** Encoded agent ids stay well under the 255-byte file name limit. */
const MAX_VAULT_NAME_CHARS = 200;

export type MemoryStore = {
  /** Every note in the vault (active and superseded), last updated first, without bodies. Empty for a new vault. */
  list(vault: MemoryVaultRef): Promise<MemoryResult<MemoryNoteMeta[]>>;
  get(vault: MemoryVaultRef, id: string): Promise<MemoryResult<MemoryNote>>;
  create(vault: MemoryVaultRef, input: MemoryNoteInput): Promise<MemoryResult<MemoryNote>>;
  update(vault: MemoryVaultRef, id: string, patch: MemoryNotePatch, version: string): Promise<MemoryResult<MemoryNote>>;
  /** Saves the new state of a fact as its own note and marks the old one superseded, linked to it. */
  supersede(
    vault: MemoryVaultRef,
    id: string,
    input: MemoryNoteInput,
    version: string
  ): Promise<MemoryResult<MemoryNote>>;
  /** Moves a note to the vault's trash (restorable by hand), with the reason in its frontmatter. */
  retire(vault: MemoryVaultRef, id: string, reason: string): Promise<MemoryResult<void>>;
  /** The best matches for `query`, active notes before superseded ones; empty for an empty query. */
  search(vault: MemoryVaultRef, query: string, limit: number): Promise<MemoryResult<MemoryNoteMeta[]>>;
  /** Adds one line to today's log (`log/YYYY-MM-DD.md`). */
  appendLog(vault: MemoryVaultRef, text: string, fromChat?: string): Promise<MemoryResult<void>>;
  /** `CORE.md`, the user's pinned facts, capped; empty when there is none. */
  core(vault: MemoryVaultRef): Promise<MemoryResult<string>>;
  /** Replaces `CORE.md` (the user's edit), refused past its cap. */
  setCore(vault: MemoryVaultRef, text: string): Promise<MemoryResult<void>>;
  /** The user vouches for a note: it becomes theirs (`source: user`), so agents can no longer change it. */
  confirm(vault: MemoryVaultRef, id: string, version: string): Promise<MemoryResult<MemoryNote>>;
  /** The vault's folder, created when missing (to open it in the file manager). */
  folder(vault: MemoryVaultRef): Promise<MemoryResult<string>>;
  /** A deleted agent's vault moves to `<root>/_trash/agents/<name>.<time>/`; nothing to do when it has none. */
  removeAgent(agentId: string): Promise<MemoryResult<void>>;
  isMigrated(vault: MemoryVaultRef): Promise<MemoryResult<boolean>>;
  /** What needs tidying (duplicates, links to missing notes, stale notes) and how full the vault is; empty when new. */
  hygiene(vault: MemoryVaultRef): Promise<MemoryResult<MemoryHygieneReport>>;
  markMigrated(vault: MemoryVaultRef): Promise<MemoryResult<void>>;
};

export type MemoryStoreOptions = {
  now?: () => Date;
  maxNotesPerVault?: number;
  /** Called after every write that landed, e.g. to refresh the agents' rules. */
  onChange?: (vault: MemoryVaultRef) => void;
};

type Vault = { dir: string; notes: Map<string, MemoryNoteMeta> };
type OnDisk = { note: MemoryNote; extra: Record<string, unknown> };

class MemoryFailure extends Error {
  constructor(
    readonly error: MemoryError,
    message: string
  ) {
    super(message);
  }
}

const fail = (error: MemoryError, message: string): never => {
  throw new MemoryFailure(error, message);
};

const stripBody = ({ body: _body, ...meta }: MemoryNote): MemoryNoteMeta => meta;
const fieldsOf = ({ id: _id, version: _version, ...fields }: MemoryNote): NoteFields => fields;

const vaultDirOf = (root: string, vault: MemoryVaultRef): string => {
  if (vault.kind === 'shared') return path.join(root, 'shared');
  const { agentId } = vault;
  let name = '';
  try {
    name = typeof agentId === 'string' && agentId.trim() ? encodeURIComponent(agentId) : '';
  } catch {
    // A lone surrogate cannot be encoded: not a usable id.
  }
  if (!name || name === '.' || name === '..' || name.length > MAX_VAULT_NAME_CHARS) fail('invalid', 'Bad agent id');
  return path.join(root, 'agents', name);
};

const ownerOf = (vault: MemoryVaultRef): string =>
  JSON.stringify(vault.kind === 'shared' ? { shared: true } : { agentId: vault.agentId });

const lstatOrNull = (file: string) =>
  fs.lstat(file).catch((e: NodeJS.ErrnoException) => (e.code === 'ENOENT' ? null : Promise.reject(e)));

/** Refuses anything other than a real directory at `dir`; creates it when missing and `create` is set. */
const ensureRealDir = async (dir: string, create: boolean): Promise<boolean> => {
  let stat = await lstatOrNull(dir);
  if (!stat) {
    if (!create) return false;
    // Another vault may create the same parent folder at the same moment: that is fine, as long as it is a real one.
    await fs.mkdir(dir).catch((e: NodeJS.ErrnoException) => (e.code === 'EEXIST' ? undefined : Promise.reject(e)));
    stat = await lstatOrNull(dir);
  }
  if (!stat?.isDirectory()) fail('conflict', 'Not a memory folder');
  return true;
};

/** Refuses a folder made for another agent (a case-insensitive disk); false when it has no owner file yet. */
const checkOwner = async (dir: string, owner: string): Promise<boolean> => {
  const ownerFile = path.join(dir, OWNER_FILE);
  const stat = await lstatOrNull(ownerFile);
  if (!stat) return false;
  const stored = stat.isFile() ? await fs.readFile(ownerFile, 'utf8') : '';
  if (stored.trim() !== owner) fail('conflict', 'This memory folder belongs to another agent');
  return true;
};

/** The folder must be this vault's; a folder without an owner yet becomes this vault's. */
const claimOwnership = async (dir: string, owner: string): Promise<void> => {
  if (!(await checkOwner(dir, owner))) await writeAtomic(path.join(dir, OWNER_FILE), owner);
};

const trashOf = (dir: string): string => path.join(dir, TRASH_DIR);
const logOf = (dir: string): string => path.join(dir, LOG_DIR);

/** Retention housekeeping; a failure is only logged, so it never fails the open or the write that ran it. */
const prune = async (state: Vault, task: () => Promise<unknown>): Promise<void> => {
  await task().catch((error: unknown) => console.warn('[memory] could not prune the trash or log', state.dir, error));
};

const isPlainFile = async (file: string): Promise<boolean> => Boolean((await lstatOrNull(file))?.isFile());

/** One note as it is on disk; null when missing, not a plain file, or not a valid note. Disk errors throw. */
const readNoteFile = async (dir: string, id: string): Promise<OnDisk | null> => {
  const file = path.join(dir, NOTES_DIR, `${id}.md`);
  const stat = await lstatOrNull(file);
  if (!stat?.isFile()) return null;
  const text = await fs.readFile(file, 'utf8');
  try {
    const note = parseNote(id, text);
    return note ? { note, extra: extraKeysOf(text) } : null;
  } catch (error) {
    console.warn('[memory] skipping a note with broken frontmatter', id, error);
    return null;
  }
};

const scanNotes = async (dir: string): Promise<Map<string, MemoryNoteMeta>> => {
  const entries = await fs.readdir(path.join(dir, NOTES_DIR), { withFileTypes: true });
  const ids = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => entry.name.slice(0, -3))
    .filter((id) => NOTE_ID_RE.test(id));
  const notes = (await Promise.all(ids.map((id) => readNoteFile(dir, id)))).filter((read) => read !== null);
  if (notes.length < ids.length)
    console.warn(`[memory] skipped ${ids.length - notes.length} invalid note(s) in ${dir}`);
  return new Map(notes.map(({ note }) => [note.id, stripBody(note)]));
};

const byRecency = (a: MemoryNoteMeta, b: MemoryNoteMeta): number =>
  b.updated.localeCompare(a.updated) || a.title.localeCompare(b.title);

/** The catalog an agent reads first: active notes, grouped by type. Generated, so any hand edit is overwritten. */
const renderIndex = (notes: Iterable<MemoryNoteMeta>): string => {
  const active = [...notes].filter((note) => note.status === 'active').toSorted(byRecency);
  const lines = ['# Memory index', '', '<!-- Generated by Pixebot Browser; edits here are overwritten. -->', ''];
  for (const type of MEMORY_NOTE_TYPES) {
    const ofType = active.filter((note) => note.type === type);
    if (ofType.length === 0) continue;
    lines.push(`## ${type}`, '');
    for (const note of ofType) lines.push(`- [[${note.id}]] ${neutralise(note.title)} — ${neutralise(note.summary)}`);
    lines.push('');
  }
  return lines.join('\n');
};

/** A note's file text, refused when it is too big or would not read back as the same note. */
const noteText = (id: string, fields: NoteFields, extra: Record<string, unknown>): string => {
  const text = serialiseNote(fields, extra);
  if (Buffer.byteLength(text, 'utf8') > MEMORY_LIMITS.maxNoteBytes) {
    fail('invalid', `A note holds at most ${MEMORY_LIMITS.maxNoteBytes} bytes`);
  }
  if (!parseNote(id, text)) fail('invalid', 'The note would not read back');
  return text;
};

export function createMemoryStore(rootDir: string, options: MemoryStoreOptions = {}): MemoryStore {
  const now = options.now ?? (() => new Date());
  const maxNotes = options.maxNotesPerVault ?? MEMORY_LIMITS.maxNotesPerVault;
  const serialised = createSerialiser();
  const opened = new Map<string, Promise<Vault>>();

  /** Opens a vault, scanning its notes once. A read of a vault that doesn't exist yet creates nothing (null). */
  const openVault = async (vault: MemoryVaultRef, create: boolean): Promise<Vault | null> => {
    const dir = vaultDirOf(rootDir, vault);
    const known = opened.get(dir);
    if (known) return known;
    const parent = path.dirname(dir);
    if (create) await fs.mkdir(rootDir, { recursive: true });
    if (!(await ensureRealDir(parent, create)) || !(await ensureRealDir(dir, create))) return null;
    let pending = opened.get(dir);
    if (!pending) {
      pending = (async () => {
        await claimOwnership(dir, ownerOf(vault));
        await ensureRealDir(path.join(dir, NOTES_DIR), true);
        const state = { dir, notes: await scanNotes(dir) };
        await writeAtomic(path.join(dir, INDEX_FILE), renderIndex(state.notes.values()));
        await prune(state, () => Promise.all([pruneTrash(trashOf(dir)), pruneLogs(logOf(dir), now())]));
        return state;
      })();
      // A failed open is retried on the next call instead of being remembered.
      pending.catch(() => opened.delete(dir));
      opened.set(dir, pending);
    }
    return pending;
  };

  const settle = <T>(error: unknown): MemoryResult<T> => {
    if (error instanceof MemoryFailure) return { ok: false, error: error.error, message: error.message };
    console.error('[memory] storage error', error);
    return { ok: false, error: 'io', message: "Couldn't read or save the memory" };
  };

  const read = async <T>(
    vault: MemoryVaultRef,
    task: (state: Vault | null) => Promise<T>
  ): Promise<MemoryResult<T>> => {
    try {
      return { ok: true, value: await task(await openVault(vault, false)) };
    } catch (error) {
      return settle(error);
    }
  };

  /** One write at a time per vault; the folders are checked again first, so a symlink swapped in later is refused. */
  const write = async <T>(
    vault: MemoryVaultRef,
    task: (state: Vault) => Promise<T>,
    notify = true
  ): Promise<MemoryResult<T>> => {
    try {
      const state = (await openVault(vault, true)) as Vault;
      const value = await serialised(state.dir, async () => {
        for (const dir of [path.dirname(state.dir), state.dir, path.join(state.dir, NOTES_DIR)]) {
          // eslint-disable-next-line no-await-in-loop -- three folders, in order
          await ensureRealDir(dir, false);
        }
        return task(state);
      });
      try {
        if (notify) options.onChange?.(vault);
      } catch (error) {
        console.warn('[memory] change listener failed', error);
      }
      return { ok: true, value };
    } catch (error) {
      return settle(error);
    }
  };

  /** The index is a cache an agent reads; failing to refresh it never fails a write that already landed. */
  const refreshIndex = async (state: Vault): Promise<void> => {
    await writeAtomic(path.join(state.dir, INDEX_FILE), renderIndex(state.notes.values())).catch((error: unknown) =>
      console.warn('[memory] could not refresh index.md; it is rebuilt on the next start', error)
    );
  };

  const writeNote = async (state: Vault, id: string, text: string): Promise<MemoryNote> => {
    await writeAtomic(path.join(state.dir, NOTES_DIR, `${id}.md`), text);
    const note = parseNote(id, text) as MemoryNote;
    state.notes.set(id, stripBody(note));
    return note;
  };

  const checked = (vault: MemoryVaultRef, input: MemoryNoteInput): CheckedInput => {
    const result = checkInput(input);
    if (typeof result === 'string') return fail('invalid', result);
    if (vault.kind === 'shared' && result.source === 'page') {
      fail('invalid', 'Web page text cannot go into the shared memory');
    }
    return result;
  };

  const freeId = async (state: Vault, title: string): Promise<string> => {
    const base = slugify(title);
    for (let n = 1; ; n += 1) {
      const id = numberedId(base, n);
      // eslint-disable-next-line no-await-in-loop -- a handful of probes at most
      if (!state.notes.has(id) && !(await lstatOrNull(path.join(state.dir, NOTES_DIR, `${id}.md`)))) return id;
    }
  };

  /** A new note's id and file text, checked before anything is written. */
  const prepareNew = async (state: Vault, vault: MemoryVaultRef, input: MemoryNoteInput) => {
    const { fromChat, ...fields } = checked(vault, input);
    if (state.notes.size >= maxNotes) fail('limit-reached', `A memory holds at most ${maxNotes} notes`);
    const stamp = now().toISOString();
    const id = await freeId(state, fields.title);
    const note = {
      ...fields,
      status: 'active' as const,
      created: stamp,
      updated: stamp,
      fromChats: fromChat ? [fromChat] : [],
    };
    return { id, text: noteText(id, note, {}) };
  };

  /** The note as it is on disk now, refused unless `version` is the one the caller read. */
  const current = async (state: Vault, id: unknown, version: unknown, needsVersion: boolean): Promise<OnDisk> => {
    if (needsVersion && typeof version !== 'string') fail('invalid', 'Send the version of the note you read');
    const onDisk = typeof id === 'string' && NOTE_ID_RE.test(id) ? await readNoteFile(state.dir, id) : null;
    if (!onDisk) {
      if (typeof id === 'string') state.notes.delete(id);
      return fail('not-found', 'No such note');
    }
    if (needsVersion && onDisk.note.version !== version) fail('stale', 'The note changed since it was read');
    return onDisk;
  };

  return {
    list: (vault) => read(vault, async (state) => (state ? [...state.notes.values()].toSorted(byRecency) : [])),
    get: (vault, id) =>
      read(vault, async (state) =>
        state ? (await current(state, id, undefined, false)).note : fail('not-found', 'No such note')
      ),
    create: (vault, input) =>
      write(vault, async (state) => {
        const { id, text } = await prepareNew(state, vault, input);
        const note = await writeNote(state, id, text);
        await refreshIndex(state);
        return note;
      }),
    update: (vault, id, patch, version) =>
      write(vault, async (state) => {
        const { note, extra } = await current(state, id, version, true);
        const { fromChat, ...changed } = checked(vault, { ...note, ...patch, source: note.source });
        const fromChats =
          fromChat && !note.fromChats.includes(fromChat) ? [...note.fromChats, fromChat] : note.fromChats;
        const fields = { ...fieldsOf(note), ...changed, fromChats, updated: now().toISOString() };
        const saved = await writeNote(state, note.id, noteText(note.id, fields, extra));
        await refreshIndex(state);
        return saved;
      }),
    supersede: (vault, id, input, version) =>
      write(vault, async (state) => {
        const { note: old, extra } = await current(state, id, version, true);
        // Both files are checked before either is written, so a failure never leaves half a supersede behind.
        const next = await prepareNew(state, vault, input);
        const retired = {
          ...fieldsOf(old),
          status: 'superseded' as const,
          supersededBy: next.id,
          updated: now().toISOString(),
        };
        const oldText = noteText(old.id, retired, extra);
        const saved = await writeNote(state, next.id, next.text);
        await writeNote(state, old.id, oldText);
        await refreshIndex(state);
        return saved;
      }),
    retire: (vault, id, reason) =>
      write(vault, async (state) => {
        const why = checkReason(reason) ?? fail('invalid', 'Say why the note is retired (one line)');
        const { note, extra } = await current(state, id, undefined, false);
        const stamp = now().toISOString();
        await ensureRealDir(path.join(state.dir, TRASH_DIR), true);
        const trashName = `${note.id}.${stamp.replace(/[:.]/g, '-')}.${randomBytes(3).toString('hex')}.md`;
        await writeAtomic(
          path.join(state.dir, TRASH_DIR, trashName),
          serialiseNote(fieldsOf(note), { ...extra, retired_reason: why, retired_at: stamp })
        );
        await fs.rm(path.join(state.dir, NOTES_DIR, `${note.id}.md`));
        state.notes.delete(note.id);
        await refreshIndex(state);
        await prune(state, () => pruneTrash(trashOf(state.dir)));
      }),
    search: (vault, query, limit) =>
      read(vault, async (state) => {
        const tokens = tokenize(typeof query === 'string' ? query : '');
        if (!state || tokens.length === 0) return [];
        return [...state.notes.values()]
          .map((note) => ({ note, score: scoreNote(note, tokens) }))
          .filter(({ score }) => score > 0)
          .toSorted(
            (a, b) =>
              Number(b.note.status === 'active') - Number(a.note.status === 'active') ||
              b.score - a.score ||
              byRecency(a.note, b.note)
          )
          .slice(0, Math.max(0, limit))
          .map(({ note }) => note);
      }),
    appendLog: (vault, text, fromChat) =>
      write(
        vault,
        async (state) => {
          const entry = typeof text === 'string' ? oneLine(text) : '';
          if (!entry || charCount(entry) > MAX_LOG_LINE_CHARS)
            fail('invalid', `A log entry is 1-${MAX_LOG_LINE_CHARS} characters`);
          const stamp = now().toISOString();
          await ensureRealDir(path.join(state.dir, LOG_DIR), true);
          const file = path.join(state.dir, LOG_DIR, `${stamp.slice(0, 10)}.md`);
          const stat = await lstatOrNull(file);
          if (stat && !stat.isFile()) fail('conflict', 'Not a log file');
          if (stat && stat.size > MAX_LOG_BYTES) fail('limit-reached', "Today's log is full");
          const chat = isChatId(fromChat) ? ` (chat ${fromChat})` : '';
          await fs.appendFile(file, `- ${stamp.slice(11, 16)}${chat} ${neutralise(entry)}\n`, 'utf8');
          await prune(state, () => pruneLogs(logOf(state.dir), now()));
        },
        false
      ),
    core: (vault) =>
      read(vault, async (state) => {
        const file = state ? path.join(state.dir, CORE_FILE) : null;
        const stat = file ? await lstatOrNull(file) : null;
        if (!file || !stat?.isFile()) return '';
        const raw = (await fs.readFile(file, 'utf8')).replace(/<!--/g, '< !--').replace(/-->/g, '-- >');
        return Array.from(raw.trim()).slice(0, MAX_CORE_CHARS).join('');
      }),
    setCore: (vault, text) =>
      write(vault, async (state) => {
        if (typeof text !== 'string' || charCount(text) > MAX_CORE_CHARS) {
          fail('invalid', `The core holds at most ${MAX_CORE_CHARS} characters`);
        }
        const file = path.join(state.dir, CORE_FILE);
        const stat = await lstatOrNull(file);
        if (stat && !stat.isFile()) fail('conflict', 'CORE.md is not a plain file');
        await writeAtomic(file, text.trim());
      }),
    confirm: (vault, id, version) =>
      write(vault, async (state) => {
        const { note, extra } = await current(state, id, version, true);
        const fields = { ...fieldsOf(note), source: 'user' as const, updated: now().toISOString() };
        const saved = await writeNote(state, note.id, noteText(note.id, fields, extra));
        await refreshIndex(state);
        return saved;
      }),
    folder: (vault) => write(vault, async (state) => state.dir, false),
    removeAgent: async (agentId) => {
      try {
        const vault = { kind: 'agent', agentId } as const;
        const dir = vaultDirOf(rootDir, vault);
        // In the vault's write queue, so no write lands in a folder that is being moved.
        await serialised(dir, async () => {
          if (!(await ensureRealDir(path.dirname(dir), false)) || !(await ensureRealDir(dir, false))) return;
          await checkOwner(dir, ownerOf(vault));
          const trash = path.join(rootDir, TRASH_DIR, 'agents');
          await fs.mkdir(rootDir, { recursive: true });
          await ensureRealDir(path.join(rootDir, TRASH_DIR), true);
          await ensureRealDir(trash, true);
          const stamp = now().toISOString().replace(/[:.]/g, '-');
          await fs.rename(dir, path.join(trash, `${path.basename(dir)}.${stamp}.${randomBytes(3).toString('hex')}`));
          opened.delete(dir);
        });
        return { ok: true, value: undefined };
      } catch (error) {
        return settle(error);
      }
    },
    hygiene: (vault) =>
      read(vault, async (state) => {
        if (!state) return hygieneReport({ notes: [], trash: 0, maxNotes, now: now() });
        // Bodies through the same checked read as `get`; a note gone or broken since the scan is left out.
        const onDisk = await Promise.all([...state.notes.keys()].map((id) => readNoteFile(state.dir, id)));
        const notes = onDisk.filter((file) => file !== null).map(({ note }) => note);
        const trashStat = await lstatOrNull(trashOf(state.dir));
        const trash = trashStat?.isDirectory()
          ? (await fs.readdir(trashOf(state.dir), { withFileTypes: true })).filter((entry) => entry.isFile()).length
          : 0;
        return hygieneReport({ notes, trash, maxNotes, now: now() });
      }),
    isMigrated: (vault) =>
      read(vault, async (state) => (state ? isPlainFile(path.join(state.dir, MIGRATED_FILE)) : false)),
    // Tells listeners, so the agent's rule is rewritten without the old notebook block.
    markMigrated: (vault) =>
      write(vault, (state) => writeAtomic(path.join(state.dir, MIGRATED_FILE), now().toISOString())),
  };
}
