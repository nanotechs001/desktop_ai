/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The memory hygiene report: duplicates, links to missing notes and stale facts, found without changing anything; the
 * store method that reads a vault for it and the renderer's `agentMemory.hygiene` IPC handler.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryNote, MemoryNoteInput, MemoryResult, MemoryVaultRef } from '@/common/types/agent/memory';
import { MEMORY_LIMITS } from '@/common/types/agent/memory';
import { createMemoryIpcHandlers } from '@process/artifacts';
import { hygieneReport, MEMORY_STALE_AFTER_DAYS } from '@process/artifacts/memory/memoryHygiene';
import { createMemoryStore } from '@process/artifacts/memory/memoryStore';

vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('@/common/adapter/httpBridge', () => ({ httpRequest: vi.fn(), isBackendHttpError: () => false }));

const NOW = new Date('2026-10-23T10:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const daysAgo = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs).toISOString();

const note = (id: string, overrides: Partial<MemoryNote> = {}): MemoryNote => ({
  id,
  type: 'preference',
  title: id,
  summary: '',
  tags: [],
  source: 'agent',
  confidence: 'high',
  status: 'active',
  created: daysAgo(1),
  updated: daysAgo(1),
  fromChats: [],
  version: 'v',
  body: '',
  ...overrides,
});

const report = (notes: MemoryNote[], trash = 0) => hygieneReport({ notes, trash, maxNotes: 2000, now: NOW });

/** 25 distinct words; `swap` replaces the last `swap` of them with `${other}N`, so similarity can be dialled in. */
const words = (swap = 0, other = 'other') =>
  Array.from({ length: 25 }, (_, i) => (i >= 25 - swap ? `${other}${i}` : `word${i}`)).join(' ');

describe('hygieneReport', () => {
  it('reports the counts and an empty issue list for a tidy vault', () => {
    expect(report([note('a'), note('b')], 3)).toEqual({
      notes: 2,
      maxNotes: 2000,
      trash: 3,
      staleAfterDays: 180,
      issues: [],
    });
    expect(MEMORY_STALE_AFTER_DAYS).toBe(180);
  });

  describe('duplicates', () => {
    it('groups active notes whose titles differ only in case, spacing or punctuation, newest first', () => {
      const issues = report([
        note('old', { title: 'Coach Marketing Machine', updated: daysAgo(5) }),
        note('new', { title: 'coach-marketing  machine!', updated: daysAgo(1) }),
        note('mid', { title: 'COACH MARKETING MACHINE', updated: daysAgo(3) }),
        note('gone', { title: 'Coach Marketing Machine', status: 'superseded' }),
        note('other', { title: 'Something else' }),
      ]).issues;

      expect(issues).toEqual([
        {
          kind: 'duplicate',
          notes: [
            { id: 'new', title: 'coach-marketing  machine!', updated: daysAgo(1) },
            { id: 'mid', title: 'COACH MARKETING MACHINE', updated: daysAgo(3) },
            { id: 'old', title: 'Coach Marketing Machine', updated: daysAgo(5) },
          ],
        },
      ]);
    });

    it('groups bodies with a word-set similarity of at least 0.6 when both have 20 words or more', () => {
      // 25 words, 6 swapped: 19 shared of 31 distinct = 0.61; 7 swapped (to other words again): 18 of 32 = 0.56.
      const issues = report([
        note('a', { title: 'A', body: words(), updated: daysAgo(2) }),
        note('b', { title: 'B', body: words(6), updated: daysAgo(1) }),
        note('c', { title: 'C', body: words(7, 'else') }),
      ]).issues;
      const groups = issues.filter((issue) => issue.kind === 'duplicate');

      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ notes: [{ id: 'b' }, { id: 'a' }] });
    });

    it('ignores body similarity when a body has fewer than 20 words', () => {
      const short = 'one two three four five six seven eight nine ten';
      expect(report([note('a', { title: 'A', body: short }), note('b', { title: 'B', body: short })]).issues).toEqual(
        []
      );
    });

    it('puts a note in at most one group', () => {
      const issues = report([
        note('t1', { title: 'Same title', body: words(), updated: daysAgo(1) }),
        note('t2', { title: 'same title', updated: daysAgo(2) }),
        note('b1', { title: 'Different', body: words(), updated: daysAgo(3) }),
        note('b2', { title: 'different!', updated: daysAgo(4) }),
      ]).issues;
      const ids = issues.flatMap((issue) => (issue.kind === 'duplicate' ? issue.notes.map((n) => n.id) : []));

      expect(ids.toSorted()).toEqual(['b1', 'b2', 't1', 't2']);
      expect(new Set(ids).size).toBe(ids.length);
    });
  });

  describe('orphan links', () => {
    it('reports a link that matches no note id or title, once per note, ignoring superseded notes', () => {
      const issues = report([
        note('jane-doe', { title: 'Jane Doe' }),
        note('kept', { title: 'Old plan', status: 'superseded', body: '[[Nobody]]' }),
        note('plan', {
          title: 'Plan',
          body: [
            '[[jane-doe]] and [[JANE DOE]] exist; [[Old Plan]] is superseded but still a note.',
            '[[Jane Doe|Jane]] and [[jane-doe#Contact]] use an alias and a heading.',
            '[[Missing Note]] twice: [[Missing Note|again]]; [[Gone#part]]; [[#local heading]].',
          ].join('\n'),
        }),
      ]).issues;

      expect(issues).toEqual([
        { kind: 'orphan-link', id: 'plan', title: 'Plan', link: 'Missing Note' },
        { kind: 'orphan-link', id: 'plan', title: 'Plan', link: 'Gone' },
      ]);
    });
  });

  describe('stale notes', () => {
    it('reports active facts, projects and people not updated for more than 180 days', () => {
      const issues = report([
        note('fact-old', { type: 'fact', updated: daysAgo(180, 1) }),
        note('fact-edge', { type: 'fact', updated: daysAgo(180) }),
        note('project-old', { type: 'project', updated: daysAgo(400) }),
        note('person-old', { type: 'person', updated: daysAgo(181) }),
        note('pref-old', { type: 'preference', updated: daysAgo(400) }),
        note('fact-superseded', { type: 'fact', status: 'superseded', updated: daysAgo(400) }),
      ]).issues;

      expect(issues).toEqual([
        { kind: 'stale', id: 'fact-old', title: 'fact-old', updated: daysAgo(180, 1) },
        { kind: 'stale', id: 'person-old', title: 'person-old', updated: daysAgo(181) },
        { kind: 'stale', id: 'project-old', title: 'project-old', updated: daysAgo(400) },
      ]);
    });
  });
});

const BOT: MemoryVaultRef = { kind: 'agent', agentId: 'bot-1' };

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

describe('memory store: hygiene', () => {
  let root: string;
  let clock: number;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-hygiene-'));
    clock = Date.parse('2026-01-01T10:00:00Z');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('gives an empty report for a vault that does not exist, and creates nothing', async () => {
    const store = createMemoryStore(root);

    expect(ok(await store.hygiene(BOT))).toEqual({
      notes: 0,
      maxNotes: MEMORY_LIMITS.maxNotesPerVault,
      trash: 0,
      staleAfterDays: 180,
      issues: [],
    });
    await expect(fs.readdir(root)).resolves.toEqual([]);
  });

  it('finds seeded duplicates, orphan links and stale facts, and counts the trash', async () => {
    const store = createMemoryStore(root, { now: () => new Date(clock), maxNotesPerVault: 50 });
    const stale = ok(await store.create(BOT, input({ title: 'Old fact' })));
    clock = Date.parse('2026-10-20T10:00:00Z');
    const first = ok(await store.create(BOT, input({ type: 'preference', body: 'See [[Nowhere]].' })));
    clock += 1000;
    const second = ok(await store.create(BOT, input({ type: 'preference', title: 'client uses gohighlevel!' })));
    const retired = ok(await store.create(BOT, input({ type: 'decision', title: 'To retire' })));
    ok(await store.retire(BOT, retired.id, 'no longer true'));
    clock = Date.parse('2026-10-23T10:00:00Z');

    const result = ok(await store.hygiene(BOT));

    expect(result).toMatchObject({ notes: 3, maxNotes: 50, trash: 1, staleAfterDays: 180 });
    expect(result.issues).toEqual([
      {
        kind: 'duplicate',
        notes: [
          { id: second.id, title: second.title, updated: second.updated },
          { id: first.id, title: first.title, updated: first.updated },
        ],
      },
      { kind: 'orphan-link', id: first.id, title: first.title, link: 'Nowhere' },
      { kind: 'stale', id: stale.id, title: 'Old fact', updated: stale.updated },
    ]);
  });

  it('skips a note file that is a symlink instead of reading through it', async () => {
    const store = createMemoryStore(root);
    ok(await store.create(BOT, input()));
    const outside = path.join(root, 'outside.md');
    await fs.writeFile(outside, '---\ntitle: x\n---\n[[Secret]]', 'utf8');
    await fs.symlink(outside, path.join(root, 'agents', 'bot-1', 'notes', 'evil.md'));

    expect(ok(await createMemoryStore(root).hygiene(BOT))).toMatchObject({ notes: 1, issues: [] });
  });
});

describe('agentMemory.hygiene IPC', () => {
  const deps = { openPath: vi.fn(async () => '') };

  it('replies with the store report for a valid vault', async () => {
    const empty = { notes: 0, maxNotes: 2000, trash: 0, staleAfterDays: 180, issues: [] };
    const hygiene = vi.fn(async () => ({ ok: true as const, value: empty }));
    const handlers = createMemoryIpcHandlers({ hygiene } as never, deps);

    expect(await handlers.hygiene({ vault: BOT })).toEqual({ success: true, data: empty });
    expect(hygiene).toHaveBeenCalledWith(BOT);
  });

  it('refuses a bad vault with the invalid code, and passes a store error code through', async () => {
    const hygiene = vi.fn(async () => ({ ok: false as const, error: 'io' as const, message: 'disk' }));
    const handlers = createMemoryIpcHandlers({ hygiene } as never, deps);

    expect(await handlers.hygiene({ vault: { kind: 'agent', agentId: '../x' } })).toEqual({
      success: false,
      msg: 'invalid',
    });
    expect(await handlers.hygiene(null)).toEqual({ success: false, msg: 'invalid' });
    expect(hygiene).not.toHaveBeenCalled();
    expect(await handlers.hygiene({ vault: { kind: 'shared' } })).toEqual({ success: false, msg: 'io' });
  });
});
