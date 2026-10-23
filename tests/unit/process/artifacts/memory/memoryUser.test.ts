/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The user's side of memory: the store methods only the Memory panel uses (confirm, CORE.md, the folder, a deleted
 * Pixebot's vault) and the renderer's `agentMemory` IPC handlers, which never trust what the renderer sends.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryNote, MemoryNoteInput, MemoryResult, MemoryVaultRef } from '@/common/types/agent/memory';
import { createMemoryIpcHandlers } from '@process/artifacts';
import { createMemoryStore } from '@process/artifacts/memory/memoryStore';

vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: vi.fn(), isBackendHttpError: () => false }));

const BOT: MemoryVaultRef = { kind: 'agent', agentId: 'bot-1' };
const SHARED: MemoryVaultRef = { kind: 'shared' };

const input = (overrides: Partial<MemoryNoteInput> = {}): MemoryNoteInput => ({
  type: 'fact',
  title: 'Client uses GoHighLevel',
  summary: 'Their CRM is GoHighLevel.',
  source: 'agent',
  ...overrides,
});

const ok = <T>(result: MemoryResult<T>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}: ${result.message}`);
  return result.value;
};

const errorOf = <T>(result: MemoryResult<T>) => (result.ok ? 'ok' : result.error);

let root: string;
const clock = Date.parse('2026-10-23T10:00:00Z');

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-user-'));
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(root, { recursive: true, force: true });
});

describe('memory store: the user side', () => {
  it('confirm makes an agent note the user’s, and refuses a stale version', async () => {
    const onChange = vi.fn();
    const store = createMemoryStore(root, { now: () => new Date(clock), onChange });
    const note = ok(await store.create(SHARED, input()));

    expect(errorOf(await store.confirm(SHARED, note.id, 'old'))).toBe('stale');
    const confirmed = ok(await store.confirm(SHARED, note.id, note.version));

    expect(confirmed).toMatchObject({ id: note.id, source: 'user', title: note.title });
    expect(ok(await store.get(SHARED, note.id)).source).toBe('user');
    expect(onChange).toHaveBeenLastCalledWith(SHARED);
  });

  it('setCore writes CORE.md, caps it at 1500 characters, tells listeners and refuses a symlink', async () => {
    const onChange = vi.fn();
    const store = createMemoryStore(root, { onChange });

    ok(await store.setCore(BOT, 'Always check the staging site first.'));
    expect(ok(await store.core(BOT))).toBe('Always check the staging site first.');
    expect(await fs.readFile(path.join(root, 'agents', 'bot-1', 'CORE.md'), 'utf8')).toBe(
      'Always check the staging site first.'
    );
    expect(onChange).toHaveBeenCalledWith(BOT);

    expect(errorOf(await store.setCore(BOT, 'x'.repeat(1501)))).toBe('invalid');
    expect(errorOf(await store.setCore(BOT, 42 as unknown as string))).toBe('invalid');

    const outside = path.join(root, 'outside.md');
    await fs.writeFile(outside, 'secret');
    await fs.rm(path.join(root, 'agents', 'bot-1', 'CORE.md'));
    await fs.symlink(outside, path.join(root, 'agents', 'bot-1', 'CORE.md'));
    expect(errorOf(await store.setCore(BOT, 'planted'))).toBe('conflict');
    expect(await fs.readFile(outside, 'utf8')).toBe('secret');
  });

  it('folder creates a missing vault and returns where it is', async () => {
    const store = createMemoryStore(root);

    const dir = ok(await store.folder({ kind: 'agent', agentId: 'bare:abc' }));

    expect(dir).toBe(path.join(root, 'agents', 'bare%3Aabc'));
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
    expect(ok(await store.folder(SHARED))).toBe(path.join(root, 'shared'));
  });

  it('removeAgent moves the vault to the memory trash; the agent then starts empty', async () => {
    const store = createMemoryStore(root, { now: () => new Date(clock) });
    ok(await store.create(BOT, input()));
    ok(await store.create({ kind: 'agent', agentId: 'keep' }, input()));

    ok(await store.removeAgent('bot-1'));

    const trashed = await fs.readdir(path.join(root, '_trash', 'agents'));
    expect(trashed).toHaveLength(1);
    expect(trashed[0]).toMatch(/^bot-1\.2026-10-23T10-00-00-000Z/);
    expect(await fs.readdir(path.join(root, '_trash', 'agents', trashed[0], 'notes'))).toHaveLength(1);
    expect(await fs.readdir(path.join(root, 'agents'))).toEqual(['keep']);
    // The cached vault is dropped: a read sees nothing, a new note starts a fresh vault.
    expect(ok(await store.list(BOT))).toEqual([]);
    ok(await store.create(BOT, input()));
    expect(ok(await store.list(BOT))).toHaveLength(1);
    // Nothing to remove is fine.
    ok(await store.removeAgent('never-existed'));
  });

  it('removeAgent refuses a folder that belongs to another agent (a case-insensitive disk)', async () => {
    const store = createMemoryStore(root);
    const dir = path.join(root, 'agents', 'bot-1');
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, '.owner.json'), JSON.stringify({ agentId: 'BOT-1' }));

    expect(errorOf(await store.removeAgent('bot-1'))).toBe('conflict');
    expect((await fs.stat(dir)).isDirectory()).toBe(true);
  });

  it('remembers that an agent’s old notebook was migrated', async () => {
    const onChange = vi.fn();
    const store = createMemoryStore(root, { onChange });

    expect(ok(await store.isMigrated(BOT))).toBe(false);
    ok(await store.markMigrated(BOT));

    expect(ok(await store.isMigrated(BOT))).toBe(true);
    expect(onChange).toHaveBeenCalledWith(BOT);
    expect(ok(await createMemoryStore(root).isMigrated(BOT))).toBe(true);
  });
});

describe('agentMemory IPC handlers', () => {
  const setup = () => {
    const store = createMemoryStore(root, { now: () => new Date(clock) });
    const openPath = vi.fn(async (_dir: string) => '');
    const forgetAgent = vi.fn();
    const removeNotebook = vi.fn(async (_agentId: string) => undefined);
    const handlers = createMemoryIpcHandlers(store, { openPath, forgetAgent, removeNotebook });
    return { store, openPath, forgetAgent, removeNotebook, handlers };
  };

  it('refuses a bad vault or bad fields with "invalid"', async () => {
    const { handlers } = setup();
    for (const vault of [undefined, null, {}, { kind: 'agent' }, { kind: 'agent', agentId: '' }]) {
      expect(await handlers.list({ vault })).toEqual({ success: false, msg: 'invalid' });
    }
    expect(await handlers.list({ vault: { kind: 'agent', agentId: 'a'.repeat(129) } })).toMatchObject({
      success: false,
    });
    expect(await handlers.list({ vault: { kind: 'agent', agentId: '../x' } })).toMatchObject({ success: false });
    expect(await handlers.get({ vault: SHARED, id: 7 })).toEqual({ success: false, msg: 'invalid' });
    expect(await handlers.create({ vault: SHARED })).toEqual({ success: false, msg: 'invalid' });
    expect(await handlers.update({ vault: SHARED, id: 'x', patch: {} })).toEqual({ success: false, msg: 'invalid' });
    expect(await handlers.confirm({ vault: SHARED, id: 'x' })).toEqual({ success: false, msg: 'invalid' });
    expect(await handlers.setCore({ vault: SHARED, text: 5 })).toEqual({ success: false, msg: 'invalid' });
    expect(await handlers.list(null)).toEqual({ success: false, msg: 'invalid' });
  });

  it('creates notes as the user’s, instructions included; a source in the request is ignored', async () => {
    const { handlers } = setup();
    const created = await handlers.create({
      vault: BOT,
      input: { type: 'instructions', title: 'Answer in French', summary: 'Always answer in French.', source: 'page' },
    });

    expect(created).toMatchObject({ success: true, data: { type: 'instructions', source: 'user' } });
    const listed = await handlers.list({ vault: BOT });
    expect(listed).toMatchObject({ success: true, data: [{ title: 'Answer in French', source: 'user' }] });
    const id = (created.data as MemoryNote).id;
    expect(await handlers.get({ vault: BOT, id })).toMatchObject({ success: true, data: { id, body: '' } });
    expect(await handlers.get({ vault: BOT, id: 'nope' })).toEqual({ success: false, msg: 'not-found' });
    expect(await handlers.create({ vault: BOT, input: { type: 'fact', title: '', summary: 'x' } })).toEqual({
      success: false,
      msg: 'invalid',
    });
  });

  it('updates any note but keeps its source; a stale version answers "stale"', async () => {
    const { store, handlers } = setup();
    const note = ok(await store.create(BOT, input()));

    expect(await handlers.update({ vault: BOT, id: note.id, patch: { title: 'Changed' }, version: 'old' })).toEqual({
      success: false,
      msg: 'stale',
    });
    const updated = await handlers.update({
      vault: BOT,
      id: note.id,
      patch: { title: 'Uses GHL', body: 'Since 2025.', source: 'user', fromChat: 'c9' },
      version: note.version,
    });

    expect(updated).toMatchObject({ success: true, data: { title: 'Uses GHL', body: 'Since 2025.', source: 'agent' } });
    expect((updated.data as MemoryNote).fromChats).toEqual([]);
  });

  it('confirm, retire and the core round-trip', async () => {
    const { store, handlers } = setup();
    const note = ok(await store.create(SHARED, input()));

    expect(await handlers.confirm({ vault: SHARED, id: note.id, version: note.version })).toMatchObject({
      success: true,
      data: { source: 'user' },
    });
    expect(await handlers.retire({ vault: SHARED, id: note.id, reason: 'Wrong' })).toEqual({ success: true });
    expect(ok(await store.list(SHARED))).toEqual([]);
    expect(await handlers.retire({ vault: SHARED, id: note.id, reason: 'Wrong' })).toEqual({
      success: false,
      msg: 'not-found',
    });

    expect(await handlers.getCore({ vault: SHARED })).toEqual({ success: true, data: '' });
    expect(await handlers.setCore({ vault: SHARED, text: 'Name: Kurl' })).toEqual({ success: true });
    expect(await handlers.getCore({ vault: SHARED })).toEqual({ success: true, data: 'Name: Kurl' });
  });

  it('openFolder creates the vault and opens it; a failed open is reported', async () => {
    const { handlers, openPath } = setup();

    expect(await handlers.openFolder({ vault: BOT })).toEqual({ success: true });
    expect(openPath).toHaveBeenCalledWith(path.join(root, 'agents', 'bot-1'));

    openPath.mockResolvedValueOnce('No application');
    expect(await handlers.openFolder({ vault: SHARED })).toEqual({ success: false, msg: 'io' });
  });

  it('removeAgent trashes the vault and forgets the agent’s chats, never the main agent’s', async () => {
    const { store, handlers, forgetAgent, removeNotebook } = setup();
    ok(await store.create(BOT, input()));

    expect(await handlers.removeAgent({ agentId: 'bot-1' })).toEqual({ success: true });
    expect(forgetAgent).toHaveBeenCalledWith('bot-1');
    // Its old notebook goes too, or the next start would migrate it into a new vault.
    expect(removeNotebook).toHaveBeenCalledWith('bot-1');
    expect(ok(await store.list(BOT))).toEqual([]);

    expect(await handlers.removeAgent({ agentId: 'aion-default-agent' })).toEqual({ success: false, msg: 'forbidden' });
    expect(await handlers.removeAgent({ agentId: 7 })).toEqual({ success: false, msg: 'invalid' });
    expect(forgetAgent).toHaveBeenCalledTimes(1);
    expect(removeNotebook).toHaveBeenCalledTimes(1);
  });
});
