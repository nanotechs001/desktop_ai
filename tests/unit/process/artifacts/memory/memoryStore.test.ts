/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The agent memory store: one markdown vault per agent plus a shared "about me" vault, with safe ids, stale-write
 * protection, soft delete and a generated index.
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MemoryNoteInput, MemoryResult, MemoryVaultRef } from '@/common/types/agent/memory';
import { MEMORY_LIMITS } from '@/common/types/agent/memory';
import { createMemoryStore } from '@process/artifacts/memory/memoryStore';

const BOT: MemoryVaultRef = { kind: 'agent', agentId: 'bot-1' };
const SHARED: MemoryVaultRef = { kind: 'shared' };

const input = (overrides: Partial<MemoryNoteInput> = {}): MemoryNoteInput => ({
  type: 'project',
  title: 'Coach Marketing Machine',
  summary: 'Client funnel product; owner Jane.',
  body: 'Launch planned for November. See [[Jane Doe]].',
  tags: ['client'],
  source: 'agent',
  fromChat: 'c1',
  ...overrides,
});

const ok = <T>(result: MemoryResult<T>): T => {
  if (!result.ok) throw new Error(`expected ok, got ${result.error}: ${result.message}`);
  return result.value;
};

const errorOf = <T>(result: MemoryResult<T>) => (result.ok ? 'ok' : result.error);

describe('memory store', () => {
  let root: string;
  let clock: number;
  const store = () => createMemoryStore(root, { now: () => new Date(clock) });

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-store-'));
    clock = Date.parse('2026-10-23T10:00:00Z');
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  const notePath = (vaultDir: string, id: string) => path.join(root, vaultDir, 'notes', `${id}.md`);

  describe('create and read', () => {
    it('writes a markdown note with frontmatter and returns it on get and list', async () => {
      const memory = store();
      const note = ok(await memory.create(BOT, input()));

      expect(note).toMatchObject({
        id: 'coach-marketing-machine',
        type: 'project',
        title: 'Coach Marketing Machine',
        status: 'active',
        confidence: 'medium',
        created: '2026-10-23T10:00:00.000Z',
        updated: '2026-10-23T10:00:00.000Z',
        fromChats: ['c1'],
      });
      const file = await fs.readFile(notePath('agents/bot-1', note.id), 'utf8');
      expect(file.startsWith('---\n')).toBe(true);
      expect(file).toContain('title: Coach Marketing Machine');
      expect(file.trimEnd().endsWith('Launch planned for November. See [[Jane Doe]].')).toBe(true);

      expect(ok(await memory.get(BOT, note.id))).toEqual(note);
      expect(ok(await memory.list(BOT)).map((meta) => meta.id)).toEqual([note.id]);
    });

    it('gives a second note with the same title its own id', async () => {
      const memory = store();
      ok(await memory.create(BOT, input()));
      const second = ok(await memory.create(BOT, input({ summary: 'Another' })));

      expect(second.id).toBe('coach-marketing-machine-2');
    });

    it('keeps the shared vault and each agent vault apart', async () => {
      const memory = store();
      ok(
        await memory.create(SHARED, input({ type: 'preference', title: 'Prefers short replies', summary: 'Be brief.' }))
      );
      ok(await memory.create({ kind: 'agent', agentId: 'shared' }, input()));

      expect(ok(await memory.list(SHARED)).map((meta) => meta.title)).toEqual(['Prefers short replies']);
      expect(ok(await memory.list({ kind: 'agent', agentId: 'shared' })).map((meta) => meta.title)).toEqual([
        'Coach Marketing Machine',
      ]);
      expect(ok(await memory.list(BOT))).toEqual([]);
    });

    it('lists last updated first', async () => {
      const memory = store();
      ok(await memory.create(BOT, input({ title: 'Older' })));
      clock += 1000;
      ok(await memory.create(BOT, input({ title: 'Newer' })));

      expect(ok(await memory.list(BOT)).map((meta) => meta.title)).toEqual(['Newer', 'Older']);
    });

    it('finds notes written while the app was closed, and skips a corrupt one', async () => {
      const first = store();
      const note = ok(await first.create(BOT, input()));
      await fs.writeFile(notePath('agents/bot-1', 'broken'), '---\ntype: [unclosed\n---\n');
      vi.spyOn(console, 'warn').mockImplementation(() => {});

      const later = store();

      expect(ok(await later.list(BOT)).map((meta) => meta.id)).toEqual([note.id]);
    });
  });

  describe('updates', () => {
    it('updates a note when the version matches, and refuses a stale write', async () => {
      const memory = store();
      const note = ok(await memory.create(BOT, input()));
      clock += 60_000;

      const updated = ok(await memory.update(BOT, note.id, { summary: 'Launch moved to December.' }, note.version));

      expect(updated.summary).toBe('Launch moved to December.');
      expect(updated.updated).toBe('2026-10-23T10:01:00.000Z');
      expect(updated.created).toBe(note.created);
      expect(updated.version).not.toBe(note.version);
      expect(errorOf(await memory.update(BOT, note.id, { summary: 'Lost update' }, note.version))).toBe('stale');
    });

    it('refuses a write over an edit made outside the app (e.g. in Obsidian)', async () => {
      const memory = store();
      const note = ok(await memory.create(BOT, input()));
      const file = notePath('agents/bot-1', note.id);
      await fs.writeFile(file, (await fs.readFile(file, 'utf8')).replace('Launch planned', 'Launch confirmed'));

      expect(errorOf(await memory.update(BOT, note.id, { summary: 'x' }, note.version))).toBe('stale');
      expect(ok(await memory.get(BOT, note.id)).body).toContain('Launch confirmed');
    });

    it('records the chats a note came from without repeats', async () => {
      const memory = store();
      const note = ok(await memory.create(BOT, input({ fromChat: 'c1' })));
      const again = ok(await memory.update(BOT, note.id, { fromChat: 'c1' }, note.version));
      const third = ok(await memory.update(BOT, note.id, { fromChat: 'c2' }, again.version));

      expect(third.fromChats).toEqual(['c1', 'c2']);
    });

    it('supersedes a changed fact: a new note, and the old one marked and linked', async () => {
      const memory = store();
      const old = ok(await memory.create(BOT, input()));

      const next = ok(
        await memory.supersede(
          BOT,
          old.id,
          input({ title: 'Coach Marketing Machine v2', summary: 'Launch in December.' }),
          old.version
        )
      );

      expect(next.status).toBe('active');
      const marked = ok(await memory.get(BOT, old.id));
      expect(marked).toMatchObject({ status: 'superseded', supersededBy: next.id });
    });

    it('retires a note to the trash: gone from the vault, kept on disk', async () => {
      const memory = store();
      const note = ok(await memory.create(BOT, input()));

      ok(await memory.retire(BOT, note.id, 'duplicate of another note'));

      expect(errorOf(await memory.get(BOT, note.id))).toBe('not-found');
      expect(ok(await memory.list(BOT))).toEqual([]);
      const trash = await fs.readdir(path.join(root, 'agents/bot-1/_trash'));
      expect(trash).toHaveLength(1);
      expect(await fs.readFile(path.join(root, 'agents/bot-1/_trash', trash[0]), 'utf8')).toContain(
        'retired_reason: duplicate of another note'
      );
    });
  });

  describe('index', () => {
    it('keeps index.md as a catalog of active notes by type, neutralising comment markers', async () => {
      const memory = store();
      const kept = ok(await memory.create(BOT, input({ summary: 'Owner Jane <!-- not a block --> ok' })));
      const old = ok(await memory.create(BOT, input({ type: 'fact', title: 'Old fact', summary: 'Outdated' })));
      ok(
        await memory.supersede(BOT, old.id, input({ type: 'fact', title: 'New fact', summary: 'Current' }), old.version)
      );

      const index = await fs.readFile(path.join(root, 'agents/bot-1/index.md'), 'utf8');

      expect(index).toContain(`[[${kept.id}]] Coach Marketing Machine`);
      expect(index).toContain('New fact');
      expect(index).not.toContain('Old fact');
      expect(index).not.toContain('<!-- not a block -->');
      expect(index.indexOf('## fact')).toBeGreaterThan(-1);
    });
  });

  describe('validation and limits', () => {
    it.each([
      ['an unknown type', { type: 'secret' }],
      ['an empty title', { title: '   ' }],
      ['a summary over the limit', { summary: 'x'.repeat(MEMORY_LIMITS.maxSummaryChars + 1) }],
      ['too many tags', { tags: Array.from({ length: MEMORY_LIMITS.maxTags + 1 }, (_, i) => `t${i}`) }],
      ['an unknown source', { source: 'robot' }],
      ['a note over the size limit', { body: 'x'.repeat(MEMORY_LIMITS.maxNoteBytes) }],
    ])('refuses %s', async (_label, overrides) => {
      expect(errorOf(await store().create(BOT, input(overrides as Partial<MemoryNoteInput>)))).toBe('invalid');
    });

    it('never saves web-page text to the shared vault about the user', async () => {
      expect(errorOf(await store().create(SHARED, input({ source: 'page' })))).toBe('invalid');
    });

    it('stops at the per-vault note limit', async () => {
      const memory = createMemoryStore(root, { now: () => new Date(clock), maxNotesPerVault: 2 });
      ok(await memory.create(BOT, input({ title: 'One' })));
      ok(await memory.create(BOT, input({ title: 'Two' })));

      expect(errorOf(await memory.create(BOT, input({ title: 'Three' })))).toBe('limit-reached');
    });
  });

  describe('path safety', () => {
    it('treats an id that is not a plain slug as not found', async () => {
      const memory = store();
      ok(await memory.create(BOT, input()));

      for (const id of ['../index', '..', 'a/b', 'UPPER', '', 'x.md']) {
        // eslint-disable-next-line no-await-in-loop -- one id at a time
        expect(errorOf(await memory.get(BOT, id))).toBe('not-found');
      }
    });

    it.each(['', '.', '..'])('refuses the agent id %j', async (agentId) => {
      expect(errorOf(await store().list({ kind: 'agent', agentId }))).toBe('invalid');
    });

    it('refuses a vault folder that belongs to another agent (case-insensitive disks)', async () => {
      const memory = store();
      ok(await memory.create(BOT, input()));
      await fs.writeFile(path.join(root, 'agents/bot-1/.owner.json'), JSON.stringify({ agentId: 'BOT-1' }));

      expect(errorOf(await store().list(BOT))).toBe('conflict');
    });

    it('does not follow a symlinked vault or note', async () => {
      const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'memory-outside-'));
      try {
        await fs.mkdir(path.join(root, 'agents'), { recursive: true });
        await fs.symlink(outside, path.join(root, 'agents', 'evil'));
        expect(errorOf(await store().list({ kind: 'agent', agentId: 'evil' }))).toBe('conflict');

        const memory = store();
        ok(await memory.create(BOT, input()));
        // A fully valid note: only the symlink check can keep it out.
        const valid = await fs.readFile(notePath('agents/bot-1', 'coach-marketing-machine'), 'utf8');
        await fs.writeFile(path.join(outside, 'secret.md'), valid.replace('Coach Marketing Machine', 'Secret'));
        await fs.symlink(path.join(outside, 'secret.md'), notePath('agents/bot-1', 'secret'));
        vi.spyOn(console, 'warn').mockImplementation(() => {});

        expect(errorOf(await store().get(BOT, 'secret'))).toBe('not-found');
        expect(ok(await store().list(BOT)).map((meta) => meta.id)).not.toContain('secret');
      } finally {
        await fs.rm(outside, { recursive: true, force: true });
      }
    });
  });

  describe('untrusted input', () => {
    it('refuses a chat id that is not a string, and leaves the note as it was', async () => {
      const memory = store();
      const note = ok(await memory.create(BOT, input()));
      const bad = { fromChat: 123 } as unknown as { fromChat: string };

      expect(errorOf(await memory.update(BOT, note.id, bad, note.version))).toBe('invalid');
      expect(errorOf(await memory.create(BOT, input(bad)))).toBe('invalid');
      expect(ok(await memory.get(BOT, note.id))).toEqual(note);
      expect(ok(await memory.list(BOT))).toHaveLength(1);
    });

    it('refuses an update or a supersede that sends no version', async () => {
      const memory = store();
      const note = ok(await memory.create(BOT, input()));
      const noVersion = undefined as unknown as string;

      expect(errorOf(await memory.update(BOT, note.id, { summary: 'x' }, noVersion))).toBe('invalid');
      expect(errorOf(await memory.supersede(BOT, note.id, input({ title: 'Next' }), noVersion))).toBe('invalid');
    });

    it('refuses a stale supersede and writes nothing', async () => {
      const memory = store();
      const note = ok(await memory.create(BOT, input()));
      ok(await memory.update(BOT, note.id, { summary: 'Changed' }, note.version));

      expect(errorOf(await memory.supersede(BOT, note.id, input({ title: 'Next' }), note.version))).toBe('stale');
      expect(ok(await memory.list(BOT)).map((meta) => meta.title)).toEqual(['Coach Marketing Machine']);
    });

    it('keeps a body with frontmatter-like lines intact through a save and a read', async () => {
      const memory = store();
      const body = 'Line one\n---\ntype: fact\n---\nLine two';
      const note = ok(await memory.create(BOT, input({ body, title: 'Has --- inside' })));

      expect(ok(await store().get(BOT, note.id))).toMatchObject({ body, type: 'project', title: 'Has --- inside' });
    });
  });

  describe('edits made outside the app', () => {
    it('keeps frontmatter keys added in Obsidian when the agent updates the note', async () => {
      const memory = store();
      const note = ok(await memory.create(BOT, input()));
      const file = notePath('agents/bot-1', note.id);
      await fs.writeFile(
        file,
        (await fs.readFile(file, 'utf8')).replace('---\ntype:', '---\naliases:\n  - CMM\ntype:')
      );
      const fresh = ok(await memory.get(BOT, note.id));

      ok(await memory.update(BOT, note.id, { summary: 'Updated' }, fresh.version));

      expect(await fs.readFile(file, 'utf8')).toContain('aliases:\n  - CMM');
    });

    it('creates nothing on disk when a vault that does not exist is only read', async () => {
      const memory = store();

      expect(ok(await memory.list({ kind: 'agent', agentId: 'never-used' }))).toEqual([]);
      expect(errorOf(await memory.get({ kind: 'agent', agentId: 'never-used' }, 'x'))).toBe('not-found');
      await expect(fs.readdir(root)).resolves.toEqual([]);
    });

    it('keeps both copies when the same note id is retired twice in one millisecond', async () => {
      const memory = store();
      ok(await memory.create(BOT, input()));
      ok(await memory.retire(BOT, 'coach-marketing-machine', 'first'));
      ok(await memory.create(BOT, input()));
      ok(await memory.retire(BOT, 'coach-marketing-machine', 'second'));

      expect(await fs.readdir(path.join(root, 'agents/bot-1/_trash'))).toHaveLength(2);
    });

    it('keeps long titles addressable when numbered', async () => {
      const memory = store();
      const title = 'A very long title that keeps going well past the slug limit of sixty characters';
      ok(await memory.create(BOT, input({ title })));
      const second = ok(await memory.create(BOT, input({ title })));

      expect(second.id.length).toBeLessThanOrEqual(64);
      expect(ok(await memory.get(BOT, second.id)).id).toBe(second.id);
    });
  });

  describe('search, log and core', () => {
    it('finds notes by title, tags and summary, best match first, superseded ones last', async () => {
      const memory = store();
      ok(
        await memory.create(
          BOT,
          input({ title: 'Jane Doe', type: 'person', summary: 'Owner of the funnel client.', tags: [] })
        )
      );
      ok(
        await memory.create(
          BOT,
          input({ title: 'Weekly report', type: 'procedure', summary: 'Mentions the funnel once.', tags: [] })
        )
      );
      const old = ok(
        await memory.create(
          BOT,
          input({ title: 'Funnel launch date', type: 'fact', summary: 'October.', tags: ['funnel'] })
        )
      );
      ok(
        await memory.supersede(
          BOT,
          old.id,
          input({ title: 'Funnel launch', type: 'fact', summary: 'November.', tags: ['funnel'] }),
          old.version
        )
      );

      const hits = ok(await memory.search(BOT, 'funnel launch', 10)).map((hit) => hit.title);

      expect(hits[0]).toBe('Funnel launch');
      expect(hits.at(-1)).toBe('Funnel launch date');
      expect(hits).toContain('Weekly report');
    });

    it('finds nothing for an empty query or no match, and caps the result count', async () => {
      const memory = store();
      ok(await memory.create(BOT, input({ title: 'Alpha one', summary: 'x', tags: [] })));
      ok(await memory.create(BOT, input({ title: 'Alpha two', summary: 'x', tags: [] })));

      expect(ok(await memory.search(BOT, '   ', 5))).toEqual([]);
      expect(ok(await memory.search(BOT, 'zebra', 5))).toEqual([]);
      expect(ok(await memory.search(BOT, 'alpha', 1))).toHaveLength(1);
    });

    it("appends to the day's log, one line per entry", async () => {
      const memory = store();
      ok(await memory.appendLog(BOT, 'Set up the BugHerd MCP\nfor the user', 'c1'));
      clock += 60_000;
      ok(await memory.appendLog(BOT, 'Second entry'));

      const log = await fs.readFile(path.join(root, 'agents/bot-1/log/2026-10-23.md'), 'utf8');
      expect(log.trim().split('\n')).toEqual([
        '- 10:00 (chat c1) Set up the BugHerd MCP for the user',
        '- 10:01 Second entry',
      ]);
      expect(errorOf(await memory.appendLog(BOT, '   '))).toBe('invalid');
    });

    it('reads CORE.md, capped, with comment markers neutralised; empty when there is none', async () => {
      const memory = store();
      expect(ok(await memory.core(BOT))).toBe('');
      ok(await memory.create(BOT, input()));
      await fs.writeFile(path.join(root, 'agents/bot-1/CORE.md'), `Line one <!-- x -->\n${'y'.repeat(3000)}`);

      const core = ok(await memory.core(BOT));
      expect(core.startsWith('Line one < !-- x -- >\n')).toBe(true);
      expect(core.length).toBeLessThanOrEqual(1500);
    });

    it('tells the listener which vault changed after each write', async () => {
      const changed: MemoryVaultRef[] = [];
      const memory = createMemoryStore(root, { now: () => new Date(clock), onChange: (vault) => changed.push(vault) });
      const note = ok(await memory.create(BOT, input()));
      ok(await memory.update(BOT, note.id, { summary: 'x' }, note.version));
      ok(await memory.create(SHARED, input({ type: 'preference', title: 'Short replies', summary: 'Be brief.' })));
      await memory.create(BOT, input({ type: 'nope' as never }));
      // The log is not in any rule, so it changes nothing an agent reads up front.
      ok(await memory.appendLog(BOT, 'Did a thing'));

      expect(changed).toEqual([BOT, BOT, SHARED]);
    });
  });

  it('creates several new vaults at once on a fresh disk (the shared agents/ folder is made only once)', async () => {
    const memory = store();
    const results = await Promise.all(
      ['a1', 'a2', 'a3', 'a4'].map((agentId) => memory.create({ kind: 'agent', agentId }, input()))
    );

    expect(results.map(errorOf)).toEqual(['ok', 'ok', 'ok', 'ok']);
  });
});
