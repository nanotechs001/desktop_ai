/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Trash and log retention: a vault keeps its newest 200 retired notes and 90 days of log, pruned when it is opened
 * and after a retire or a log line; nothing else in the vault, and nothing behind a symlink, is ever deleted.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryNoteInput, MemoryResult, MemoryVaultRef } from '@/common/types/agent/memory';
import { createMemoryStore } from '@process/artifacts/memory/memoryStore';
import { LOG_KEEP_DAYS, MAX_TRASHED_NOTES } from '@process/artifacts/memory/memoryRetention';

const BOT: MemoryVaultRef = { kind: 'agent', agentId: 'bot-1' };
const NOW = Date.parse('2026-10-23T10:00:00Z');

const input = (title: string): MemoryNoteInput => ({ type: 'fact', title, summary: 'A fact.', source: 'agent' });

const ok = <T>(result: MemoryResult<T>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}: ${result.message}`);
  return result.value;
};

let root: string;
let vaultDir: string;
const trashDir = () => path.join(vaultDir, '_trash');
const logDir = () => path.join(vaultDir, 'log');
const store = () => createMemoryStore(root, { now: () => new Date(NOW) });

/** `count` retired-note files, `old-0` the oldest; their modification times are a minute apart, in the past. */
const seedTrash = async (dir: string, count: number) => {
  await fs.mkdir(dir, { recursive: true });
  for (let i = 0; i < count; i += 1) {
    const file = path.join(dir, `old-${i}.md`);
    // eslint-disable-next-line no-await-in-loop -- a few hundred tiny files
    await fs.writeFile(file, 'retired', 'utf8');
    const time = (NOW - 365 * 86_400_000 + i * 60_000) / 1000;
    // eslint-disable-next-line no-await-in-loop -- a few hundred tiny files
    await fs.utimes(file, time, time);
  }
};

const seedLogs = async (dir: string, names: string[]) => {
  await fs.mkdir(dir, { recursive: true });
  await Promise.all(names.map((name) => fs.writeFile(path.join(dir, name), '- 10:00 entry\n', 'utf8')));
};

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-retention-'));
  vaultDir = path.join(root, 'agents', 'bot-1');
  // The vault exists (owner file, a note) before each test seeds its trash and log.
  ok(await store().create(BOT, input('Keep me')));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('memory retention', () => {
  it('keeps the limits the plan settled on', () => {
    expect(MAX_TRASHED_NOTES).toBe(200);
    expect(LOG_KEEP_DAYS).toBe(90);
  });

  it('prunes the trash to the newest 200 and the log to 90 days when a vault is opened, leaving notes alone', async () => {
    await seedTrash(trashDir(), 205);
    await fs.mkdir(path.join(trashDir(), 'a-folder'));
    // 90 days before 2026-10-23 is 2026-07-25: that day is kept, the one before is not.
    await seedLogs(logDir(), ['2026-07-24.md', '2026-07-25.md', '2026-10-23.md', '2020-01-01.md', 'notes.txt']);

    const notes = ok(await store().list(BOT));

    expect(notes.map((note) => note.title)).toEqual(['Keep me']);
    const trash = await fs.readdir(trashDir());
    expect(trash.filter((name) => name.endsWith('.md'))).toHaveLength(200);
    expect(trash).toContain('a-folder');
    for (const gone of ['old-0.md', 'old-4.md']) expect(trash).not.toContain(gone);
    expect(trash).toContain('old-5.md');
    expect((await fs.readdir(logDir())).toSorted()).toEqual(['2026-07-25.md', '2026-10-23.md', 'notes.txt']);
  });

  it('prunes the trash after a retire, dropping the oldest', async () => {
    await seedTrash(trashDir(), 200);
    const memory = store();
    const note = ok(await memory.create(BOT, input('Retire me')));

    ok(await memory.retire(BOT, note.id, 'wrong'));

    const trash = await fs.readdir(trashDir());
    expect(trash).toHaveLength(200);
    expect(trash).not.toContain('old-0.md');
    expect(trash.some((name) => name.startsWith(`${note.id}.`))).toBe(true);
  });

  it('prunes old logs after a log line', async () => {
    const memory = store();
    ok(await memory.list(BOT));
    await seedLogs(logDir(), ['2026-01-01.md']);

    ok(await memory.appendLog(BOT, 'Finished the audit.'));

    expect(await fs.readdir(logDir())).toEqual(['2026-10-23.md']);
  });

  it('never deletes through a symlinked trash or log folder, or a symlinked file', async () => {
    const outside = path.join(root, 'outside');
    await seedTrash(path.join(outside, 'trash'), 205);
    await seedLogs(path.join(outside, 'log'), ['2020-01-01.md']);
    await fs.symlink(path.join(outside, 'trash'), trashDir());
    await fs.symlink(path.join(outside, 'log'), logDir());

    ok(await store().list(BOT));

    expect(await fs.readdir(path.join(outside, 'trash'))).toHaveLength(205);
    expect(await fs.readdir(path.join(outside, 'log'))).toEqual(['2020-01-01.md']);

    await fs.rm(logDir());
    await fs.mkdir(logDir());
    await fs.symlink(path.join(outside, 'log', '2020-01-01.md'), path.join(logDir(), '2020-01-02.md'));
    ok(await store().list(BOT));

    expect(await fs.readdir(logDir())).toEqual(['2020-01-02.md']);
    expect(await fs.readdir(path.join(outside, 'log'))).toEqual(['2020-01-01.md']);
  });

  it('a failed prune never fails the write that landed', async () => {
    const memory = store();
    ok(await memory.list(BOT));
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(fs, 'readdir').mockRejectedValueOnce(new Error('disk'));

    ok(await memory.appendLog(BOT, 'Still logged.'));

    expect(await fs.readFile(path.join(logDir(), '2026-10-23.md'), 'utf8')).toContain('Still logged.');
    expect(warn).toHaveBeenCalled();
  });
});
