/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The old one-line notebook moving into memory: the startup migration, the old `add` tool saving into memory, and
 * the old `# Notebook` rule block going away once an agent's notebook is migrated.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryResult, MemoryVaultRef } from '@/common/types/agent/memory';
import { createMemoryNotesAdd, migrateNotebooks, notebookForRule } from '@process/artifacts/memory/memoryNotebook';
import { createMemoryStore } from '@process/artifacts/memory/memoryStore';
import { createNotesStore, renderNotesBlock } from '@process/artifacts/notes';

const ok = <T>(result: MemoryResult<T>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}: ${result.message}`);
  return result.value;
};

const vault = (agentId: string): MemoryVaultRef => ({ kind: 'agent', agentId });

let root: string;
let notesDir: string;
let memoryDir: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-notebook-'));
  notesDir = path.join(root, 'agent-notes');
  memoryDir = path.join(root, 'agent-memory');
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('migrateNotebooks', () => {
  it('moves each source to its note type, leaves the JSON untouched and marks the vault', async () => {
    const notes = createNotesStore(notesDir);
    const long = `Always answer in French, ${'and keep it short '.repeat(15)}`.trim();
    await notes.add('bare:abc', long, 'user');
    await notes.add('bare:abc', 'The client uses GoHighLevel', 'agent');
    await notes.add('bare:abc', 'Checkout needs a login', 'page');
    const json = await fs.readFile(path.join(notesDir, 'bare%3Aabc.json'), 'utf8');
    const store = createMemoryStore(memoryDir);

    await migrateNotebooks(notesDir, store);

    const migrated = ok(await store.list(vault('bare:abc')));
    const bySource = Object.fromEntries(migrated.map((note) => [note.source, note]));
    expect(bySource.user).toMatchObject({ type: 'instructions', source: 'user' });
    expect(bySource.agent).toMatchObject({ type: 'fact', title: 'The client uses GoHighLevel' });
    expect(bySource.page).toMatchObject({ type: 'source', summary: 'Checkout needs a login' });
    expect(Array.from(bySource.user.title)).toHaveLength(60);
    expect(Array.from(bySource.user.summary)).toHaveLength(200);
    expect(ok(await store.get(vault('bare:abc'), bySource.user.id)).body).toBe(long);
    expect(ok(await store.isMigrated(vault('bare:abc')))).toBe(true);
    expect(await fs.readFile(path.join(notesDir, 'bare%3Aabc.json'), 'utf8')).toBe(json);
  });

  it('runs once: a second start adds nothing', async () => {
    await createNotesStore(notesDir).add('agent-1', 'Prefers tables', 'agent');
    const store = createMemoryStore(memoryDir);

    await migrateNotebooks(notesDir, store);
    await migrateNotebooks(notesDir, createMemoryStore(memoryDir));

    expect(ok(await store.list(vault('agent-1')))).toHaveLength(1);
  });

  it('an interrupted run picks up without duplicating what it already saved', async () => {
    const notes = createNotesStore(notesDir);
    await notes.add('agent-1', 'Prefers tables', 'agent');
    await notes.add('agent-1', 'Works in Manila', 'agent');
    const store = createMemoryStore(memoryDir);
    ok(
      await store.create(vault('agent-1'), {
        type: 'fact',
        title: 'Prefers tables',
        summary: 'Prefers tables',
        source: 'agent',
      })
    );

    await migrateNotebooks(notesDir, store);

    expect(
      ok(await store.list(vault('agent-1')))
        .map((note) => note.title)
        .toSorted()
    ).toEqual(['Prefers tables', 'Works in Manila']);
  });

  it('a note that fails does not stop the rest; a corrupt or foreign file is skipped and not marked', async () => {
    await createNotesStore(notesDir).add('good', 'Prefers tables', 'agent');
    await fs.writeFile(path.join(notesDir, 'broken.json'), '{nope');
    await fs.writeFile(path.join(notesDir, 'other.json'), JSON.stringify({ agentId: 'OTHER', notes: [] }));
    await fs.writeFile(path.join(notesDir, '..%2Fx.json'), '{}');
    const store = createMemoryStore(memoryDir);
    const real = store.create.bind(store);
    let calls = 0;
    vi.spyOn(store, 'create').mockImplementation(async (v, input) =>
      (calls += 1) === 1 ? { ok: false, error: 'invalid', message: 'refused' } : real(v, input)
    );
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await createNotesStore(notesDir).add('good', 'Works in Manila', 'agent');

    await migrateNotebooks(notesDir, store);

    expect(ok(await store.list(vault('good')))).toHaveLength(1);
    expect(ok(await store.isMigrated(vault('good')))).toBe(true);
    expect(ok(await store.isMigrated(vault('broken')))).toBe(false);
    expect(ok(await store.isMigrated(vault('other')))).toBe(false);
  });

  it('a storage error leaves the vault unmarked, so the next start tries again', async () => {
    await createNotesStore(notesDir).add('agent-1', 'Prefers tables', 'agent');
    const store = createMemoryStore(memoryDir);
    vi.spyOn(store, 'create').mockResolvedValue({ ok: false, error: 'io', message: 'disk' });
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await migrateNotebooks(notesDir, store);

    expect(ok(await store.isMigrated(vault('agent-1')))).toBe(false);
  });

  it('no notebook folder is nothing to do', async () => {
    await expect(migrateNotebooks(path.join(root, 'missing'), createMemoryStore(memoryDir))).resolves.toBeUndefined();
  });
});

describe('notebookForRule', () => {
  it('is the old notebook until the agent is migrated, then empty, so the # Notebook block goes', async () => {
    await createNotesStore(notesDir).add('agent-1', 'Prefers tables', 'agent');
    const store = createMemoryStore(memoryDir);

    expect(await notebookForRule(store, notesDir, 'agent-1')).toHaveLength(1);
    await migrateNotebooks(notesDir, store);

    expect(await notebookForRule(store, notesDir, 'agent-1')).toEqual([]);
    expect(renderNotesBlock([])).toBeNull();
  });
});

describe('createMemoryNotesAdd (the old add tool)', () => {
  it('saves into the agent’s memory and answers in the old note shape', async () => {
    const store = createMemoryStore(memoryDir);
    const add = createMemoryNotesAdd(store);

    const fact = await add('agent-1', 'The user likes bullet lists', 'agent');
    const page = await add('agent-1', 'Checkout needs a login', 'page');

    expect(fact).toMatchObject({ ok: true, value: { text: 'The user likes bullet lists', source: 'agent' } });
    expect(page).toMatchObject({ ok: true, value: { source: 'page' } });
    const value = 'value' in fact ? fact.value : null;
    expect(typeof value?.id).toBe('string');
    expect(typeof value?.at).toBe('number');
    const saved = ok(await store.list(vault('agent-1')));
    expect(saved.map((note) => [note.type, note.source]).toSorted()).toEqual([
      ['fact', 'agent'],
      ['source', 'page'],
    ]);
    expect(await add('agent-1', '   ', 'agent')).toMatchObject({ ok: false });
  });
});
