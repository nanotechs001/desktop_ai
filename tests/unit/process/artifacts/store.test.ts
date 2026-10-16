/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ARTIFACT_LIMITS } from '@/common/types/agent/artifacts';
import { createArtifactStore } from '@process/artifacts/store';

const input = { title: 'Dashboard', kind: 'html' as const, content: '<h1>v1</h1>' };

describe('artifact store', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-store-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  const ok = <T>(r: { ok: boolean; value?: T }): T => {
    expect(r.ok).toBe(true);
    return (r as { value: T }).value;
  };

  /** Backdates conversation folders past the cleanup grace period. */
  const age = async (...names: string[]): Promise<void> => {
    const old = new Date(Date.now() - 60 * 60 * 1000);
    await Promise.all(names.map((n) => fs.utimes(path.join(root, n), old, old)));
  };

  it('create writes v1 and meta; get returns it', async () => {
    const store = createArtifactStore(root);
    const created = ok(await store.create('conv1', input));

    expect(created.id).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(created).toMatchObject({ conversationId: 'conv1', title: 'Dashboard', kind: 'html', latest: 1, version: 1 });
    expect(await fs.readFile(path.join(root, 'conv1', created.id, 'v1.html'), 'utf8')).toBe(input.content);
    expect(JSON.parse(await fs.readFile(path.join(root, 'conv1', created.id, 'meta.json'), 'utf8'))).toMatchObject({
      id: created.id,
      latest: 1,
    });
    expect(ok(await store.get('conv1', created.id))).toEqual(created);
  });

  it.each([
    ['html', 'html'],
    ['react', 'jsx'],
    ['markdown', 'md'],
    ['mermaid', 'mmd'],
    ['svg', 'svg'],
  ] as const)('stores %s content in a .%s file', async (kind, ext) => {
    const store = createArtifactStore(root);
    const created = ok(await store.create('conv1', { ...input, kind }));
    await expect(fs.stat(path.join(root, 'conv1', created.id, `v1.${ext}`))).resolves.toBeTruthy();
  });

  it('update writes v2, keeps v1 readable, bumps latest and updatedAt', async () => {
    const store = createArtifactStore(root);
    const created = ok(await store.create('conv1', input));
    await new Promise((r) => setTimeout(r, 5));
    const updated = ok(await store.update('conv1', created.id, { content: '<h1>v2</h1>', title: 'Renamed' }));

    expect(updated).toMatchObject({ version: 2, latest: 2, title: 'Renamed', content: '<h1>v2</h1>' });
    expect(updated.createdAt).toBe(created.createdAt);
    expect(updated.updatedAt).toBeGreaterThan(created.updatedAt);
    expect(ok(await store.get('conv1', created.id, 1)).content).toBe('<h1>v1</h1>');
    expect(ok(await store.get('conv1', created.id)).content).toBe('<h1>v2</h1>');
  });

  it('get of a missing version returns not-found', async () => {
    const store = createArtifactStore(root);
    const created = ok(await store.create('conv1', input));
    const results = await Promise.all([0, 2, -1, 1.5].map((v) => store.get('conv1', created.id, v)));
    for (const r of results) expect(r).toMatchObject({ ok: false, error: 'not-found' });
  });

  it('get with another conversation id returns not-found (same message as unknown id)', async () => {
    const store = createArtifactStore(root);
    const created = ok(await store.create('conv1', input));
    const foreign = await store.get('conv2', created.id);
    const unknown = await store.get('conv1', 'A'.repeat(22));

    expect(foreign).toMatchObject({ ok: false, error: 'not-found' });
    expect(unknown).toEqual(foreign);
    expect(await store.update('conv2', created.id, { content: 'x' })).toEqual(foreign);
  });

  it('rejects content over 2 MB, empty or >120-char title, unknown kind; nothing written', async () => {
    const store = createArtifactStore(root);
    const big = 'x'.repeat(ARTIFACT_LIMITS.maxContentBytes + 1);
    // 3-byte chars: under the limit by length, over it in UTF-8 bytes
    const wide = '€'.repeat(Math.ceil(ARTIFACT_LIMITS.maxContentBytes / 3) + 1);

    expect(await store.create('conv1', { ...input, content: big })).toMatchObject({ ok: false, error: 'too-large' });
    expect(await store.create('conv1', { ...input, content: wide })).toMatchObject({ ok: false, error: 'too-large' });
    expect(await store.create('conv1', { ...input, title: '' })).toMatchObject({ ok: false, error: 'bad-title' });
    expect(await store.create('conv1', { ...input, title: '   ' })).toMatchObject({ ok: false, error: 'bad-title' });
    expect(await store.create('conv1', { ...input, title: 'x'.repeat(121) })).toMatchObject({
      ok: false,
      error: 'bad-title',
    });
    expect(await store.create('conv1', { ...input, kind: 'pdf' as never })).toMatchObject({
      ok: false,
      error: 'bad-kind',
    });
    expect(await fs.readdir(root)).toEqual([]);

    const created = ok(await store.create('conv1', input));
    expect(await store.update('conv1', created.id, { content: big })).toMatchObject({ error: 'too-large' });
    expect(await store.update('conv1', created.id, { content: 'ok', title: '' })).toMatchObject({
      error: 'bad-title',
    });
    expect(ok(await store.get('conv1', created.id)).latest).toBe(1);
  });

  it('accepts exactly the limits', async () => {
    const store = createArtifactStore(root);
    const r = await store.create('conv1', {
      ...input,
      title: 'x'.repeat(120),
      content: 'x'.repeat(ARTIFACT_LIMITS.maxContentBytes),
    });
    expect(r.ok).toBe(true);
  });

  it('201st artifact in a conversation returns limit-reached', async () => {
    const store = createArtifactStore(root);
    await Promise.all(Array.from({ length: ARTIFACT_LIMITS.maxPerConversation }, () => store.create('conv1', input)));

    expect(await store.create('conv1', input)).toMatchObject({ ok: false, error: 'limit-reached' });
    expect((await store.create('conv2', input)).ok).toBe(true);
  });

  it.each(['../x', 'a/b', 'a\\b', '..', '', 'a'.repeat(65)])('a conversation id %j is rejected', async (bad) => {
    const store = createArtifactStore(root);
    expect(await store.create(bad, input)).toMatchObject({ ok: false, error: 'not-found' });
    expect(await store.get(bad, 'A'.repeat(22))).toMatchObject({ ok: false, error: 'not-found' });
    expect(await fs.readdir(root)).toEqual([]);
  });

  it.each(['../../etc', 'short', 'A'.repeat(23)])('an artifact id %j is rejected', async (bad) => {
    const store = createArtifactStore(root);
    expect(await store.get('conv1', bad)).toMatchObject({ ok: false, error: 'not-found' });
    expect(await store.getById(bad)).toMatchObject({ ok: false, error: 'not-found' });
  });

  it('concurrent updates to one id produce consecutive versions with no lost write', async () => {
    const store = createArtifactStore(root);
    const created = ok(await store.create('conv1', input));
    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => store.update('conv1', created.id, { content: `c${i}` }))
    );

    expect(results.map((r) => ok(r).version).toSorted((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(ok(await store.get('conv1', created.id)).latest).toBe(11);
    const versions = await Promise.all(Array.from({ length: 10 }, (_, i) => store.get('conv1', created.id, i + 2)));
    expect(new Set(versions.map((r) => ok(r).content)).size).toBe(10);
  });

  it('a failed write leaves the previous version intact', async () => {
    const store = createArtifactStore(root);
    const created = ok(await store.create('conv1', input));
    const dir = path.join(root, 'conv1', created.id);

    const spy = vi.spyOn(fs, 'rename').mockRejectedValueOnce(new Error('disk full'));
    expect(await store.update('conv1', created.id, { content: 'v2' })).toMatchObject({ ok: false, error: 'io' });
    spy.mockRestore();

    expect(ok(await store.get('conv1', created.id))).toMatchObject({ latest: 1, content: input.content });
    expect((await fs.readdir(dir)).toSorted()).toEqual(['meta.json', 'v1.html']);
    expect(ok(await store.update('conv1', created.id, { content: 'v2' })).version).toBe(2);
  });

  it('a failed meta write after the version file leaves latest unchanged', async () => {
    const store = createArtifactStore(root);
    const created = ok(await store.create('conv1', input));

    // 1st rename = version file, 2nd = meta.json
    const real = fs.rename.bind(fs);
    let calls = 0;
    vi.spyOn(fs, 'rename').mockImplementation((from, to) => {
      calls += 1;
      return calls === 2 ? Promise.reject(new Error('boom')) : real(from, to);
    });
    expect(await store.update('conv1', created.id, { content: 'v2' })).toMatchObject({ ok: false, error: 'io' });
    vi.restoreAllMocks();

    expect(ok(await store.get('conv1', created.id)).latest).toBe(1);
    expect(ok(await store.update('conv1', created.id, { content: 'v2b' })).content).toBe('v2b');
  });

  it('a failed create leaves no folder behind', async () => {
    const store = createArtifactStore(root);
    vi.spyOn(fs, 'rename').mockRejectedValue(new Error('disk full'));
    expect(await store.create('conv1', input)).toMatchObject({ ok: false, error: 'io' });
    vi.restoreAllMocks();
    expect(await fs.readdir(path.join(root, 'conv1'))).toEqual([]);
    expect((await store.create('conv1', input)).ok).toBe(true);
  });

  it('cleanup removes folders of conversations not in the live set and keeps the rest', async () => {
    const store = createArtifactStore(root);
    const keep = ok(await store.create('keep', input));
    await store.create('gone1', input);
    await store.create('gone2', input);
    await age('keep', 'gone1', 'gone2');

    expect(await store.cleanup(new Set(['keep']))).toBe(2);
    expect((await fs.readdir(root)).toSorted()).toEqual(['keep']);
    expect(ok(await store.getById(keep.id)).id).toBe(keep.id);
  });

  it('cleanup drops removed artifacts from the id index', async () => {
    const store = createArtifactStore(root);
    const gone = ok(await store.create('gone', input));
    await store.create('keep', input);
    await age('gone', 'keep');
    await store.cleanup(new Set(['keep']));
    expect(await store.getById(gone.id)).toMatchObject({ ok: false, error: 'not-found' });
  });

  it('cleanup(new Set()) deletes nothing unless allowEmpty is set', async () => {
    const store = createArtifactStore(root);
    await store.create('a', input);
    await store.create('b', input);
    await age('a', 'b');

    expect(await store.cleanup(new Set())).toBe(0);
    expect(await store.cleanup(new Set(), { allowEmpty: false })).toBe(0);
    expect((await fs.readdir(root)).toSorted()).toEqual(['a', 'b']);

    expect(await store.cleanup(new Set(), { allowEmpty: true })).toBe(2);
    expect(await fs.readdir(root)).toEqual([]);
  });

  it('cleanup leaves entries that are not conversation folders alone', async () => {
    const store = createArtifactStore(root);
    await fs.writeFile(path.join(root, 'notes.txt'), 'x');
    await fs.mkdir(path.join(root, 'bad name'));
    await store.create('a', input);
    await age('a');
    expect(await store.cleanup(new Set(['other']))).toBe(1);
    expect((await fs.readdir(root)).toSorted()).toEqual(['bad name', 'notes.txt']);
  });

  it('getById finds an artifact after a restart (fresh store over the same dir)', async () => {
    const created = ok(await createArtifactStore(root).create('conv1', input));
    const fresh = createArtifactStore(root);

    expect(ok(await fresh.getById(created.id))).toEqual(created);
    expect(ok(await fresh.getById(created.id, 1)).content).toBe(input.content);
    expect(await fresh.getById('A'.repeat(22))).toMatchObject({ ok: false, error: 'not-found' });
  });

  it('getById finds artifacts created by this store before any scan', async () => {
    const store = createArtifactStore(root);
    const created = ok(await store.create('conv1', input));
    expect(ok(await store.getById(created.id)).conversationId).toBe('conv1');
  });

  describe('runtime validation', () => {
    it.each([
      ['missing', undefined],
      ['null', null],
      ['a number', 42],
      ['an object', {}],
    ])('create with %s title returns bad-title', async (_label, title) => {
      const store = createArtifactStore(root);
      expect(await store.create('conv1', { ...input, title: title as never })).toMatchObject({
        ok: false,
        error: 'bad-title',
      });
      expect(await fs.readdir(root)).toEqual([]);
    });

    it.each([
      ['missing', undefined],
      ['null', null],
      ['a number', 42],
      ['a buffer', Buffer.from('x')],
    ])('create with %s content returns bad-content', async (_label, content) => {
      const store = createArtifactStore(root);
      expect(await store.create('conv1', { ...input, content: content as never })).toMatchObject({
        ok: false,
        error: 'bad-content',
      });
      expect(await fs.readdir(root)).toEqual([]);
    });

    it('create with a missing input object returns a typed failure instead of throwing', async () => {
      const store = createArtifactStore(root);
      expect((await store.create('conv1', undefined as never)).ok).toBe(false);
    });

    it('update validates content and the optional title the same way', async () => {
      const store = createArtifactStore(root);
      const created = ok(await store.create('conv1', input));
      const badContent = await Promise.all(
        [undefined, null, 7].map((content) => store.update('conv1', created.id, { content: content as never }))
      );
      for (const r of badContent) expect(r).toMatchObject({ ok: false, error: 'bad-content' });
      const badTitle = await Promise.all(
        [null, 7, '', '   '].map((title) => store.update('conv1', created.id, { content: 'x', title: title as never }))
      );
      for (const r of badTitle) expect(r).toMatchObject({ ok: false, error: 'bad-title' });
      expect(await store.update('conv1', created.id, { content: 'x', title: undefined })).toMatchObject({ ok: true });
      expect(ok(await store.get('conv1', created.id)).latest).toBe(2);
    });

    it('counts the title limit in code points, not UTF-16 units', async () => {
      const store = createArtifactStore(root);
      expect((await store.create('conv1', { ...input, title: '😀'.repeat(120) })).ok).toBe(true);
      expect(await store.create('conv1', { ...input, title: '😀'.repeat(121) })).toMatchObject({
        ok: false,
        error: 'bad-title',
      });
    });
  });

  describe('stored metadata is not trusted', () => {
    const rewriteMeta = async (conv: string, id: string, patch: Record<string, unknown>) => {
      const file = path.join(root, conv, id, 'meta.json');
      const meta = JSON.parse(await fs.readFile(file, 'utf8')) as Record<string, unknown>;
      await fs.writeFile(file, JSON.stringify({ ...meta, ...patch }));
    };

    it('a conversation id differing only in case is not-found', async () => {
      const store = createArtifactStore(root);
      const created = ok(await store.create('conv1', input));
      const notFound = { ok: false, error: 'not-found' };
      expect(await store.get('CONV1', created.id)).toMatchObject(notFound);
      expect(await store.update('CONV1', created.id, { content: 'x' })).toMatchObject(notFound);
      expect(ok(await store.get('conv1', created.id)).latest).toBe(1);
    });

    it('an artifact id differing only in case is not-found', async () => {
      const store = createArtifactStore(root);
      const created = ok(await store.create('conv1', input));
      const flipped = [...created.id].map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join('');
      expect(flipped).not.toBe(created.id);
      expect(await store.get('conv1', flipped)).toMatchObject({ ok: false, error: 'not-found' });
      expect(await store.update('conv1', flipped, { content: 'x' })).toMatchObject({ ok: false, error: 'not-found' });
    });

    it('meta whose id or conversationId disagree with the arguments is rejected', async () => {
      const store = createArtifactStore(root);
      const a = ok(await store.create('conv1', input));
      await rewriteMeta('conv1', a.id, { conversationId: 'victim' });
      expect(await store.get('conv1', a.id)).toMatchObject({ ok: false });
      const b = ok(await store.create('conv1', input));
      await rewriteMeta('conv1', b.id, { id: 'B'.repeat(22) });
      expect(await store.get('conv1', b.id)).toMatchObject({ ok: false });
      expect(await store.update('conv1', b.id, { content: 'x' })).toMatchObject({ ok: false });
    });

    it.each([0, -1, 1.5, '2', null])('meta with latest %j is rejected', async (latest) => {
      const store = createArtifactStore(root);
      const created = ok(await store.create('conv1', input));
      await rewriteMeta('conv1', created.id, { latest });
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      expect(await store.get('conv1', created.id)).toMatchObject({ ok: false });
      expect(await store.update('conv1', created.id, { content: 'x' })).toMatchObject({ ok: false });
    });
  });

  it('210 concurrent creates in one conversation yield exactly 200 ok and 10 limit-reached', async () => {
    const store = createArtifactStore(root);
    const results = await Promise.all(Array.from({ length: 210 }, () => store.create('conv1', input)));

    expect(results.filter((r) => r.ok)).toHaveLength(ARTIFACT_LIMITS.maxPerConversation);
    expect(results.filter((r) => !r.ok && r.error === 'limit-reached')).toHaveLength(10);
    expect(await fs.readdir(path.join(root, 'conv1'))).toHaveLength(ARTIFACT_LIMITS.maxPerConversation);
  });

  describe('failure reporting', () => {
    it('io results carry a generic message and the detail goes to console.error', async () => {
      const store = createArtifactStore(root);
      const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      vi.spyOn(fs, 'rename').mockRejectedValue(new Error(`ENOSPC: no space left, rename '${root}/secret/path'`));

      const r = await store.create('conv1', input);

      expect(r).toEqual({ ok: false, error: 'io', message: "Couldn't save the artifact" });
      expect(JSON.stringify(r)).not.toContain(root);
      expect(logged).toHaveBeenCalledTimes(1);
      expect(logged.mock.calls[0]?.some((arg) => arg instanceof Error && arg.message.includes('ENOSPC'))).toBe(true);
    });

    it('cleanup logs a folder it could not remove and does not count it', async () => {
      const store = createArtifactStore(root);
      await store.create('gone', input);
      await age('gone');
      const warned = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      vi.spyOn(fs, 'rm').mockRejectedValue(new Error('EBUSY'));

      expect(await store.cleanup(new Set(['keep']))).toBe(0);

      expect(warned).toHaveBeenCalledTimes(1);
      expect(String(warned.mock.calls[0]?.[0])).toContain('gone');
      vi.restoreAllMocks();
      expect(await fs.readdir(root)).toEqual(['gone']);
    });
  });

  describe('cleanup grace period', () => {
    it('skips folders modified within the last 10 minutes', async () => {
      const store = createArtifactStore(root);
      await store.create('fresh', input);
      await store.create('stale', input);
      await age('stale');

      expect(await store.cleanup(new Set(['keep']))).toBe(1);
      expect(await fs.readdir(root)).toEqual(['fresh']);
    });

    it('removes a folder once it is older than the grace period', async () => {
      const store = createArtifactStore(root);
      await store.create('edge', input);
      const justInside = new Date(Date.now() - 9 * 60 * 1000);
      await fs.utimes(path.join(root, 'edge'), justInside, justInside);
      expect(await store.cleanup(new Set(['keep']))).toBe(0);
      const justOutside = new Date(Date.now() - 11 * 60 * 1000);
      await fs.utimes(path.join(root, 'edge'), justOutside, justOutside);
      expect(await store.cleanup(new Set(['keep']))).toBe(1);
    });
  });

  describe('hostile directory entries', () => {
    const notFound = { ok: false, error: 'not-found' };

    it('a stray file under a valid conversation id gives not-found, not io', async () => {
      const store = createArtifactStore(root);
      await fs.writeFile(path.join(root, 'conv1'), 'stray');
      expect(await store.get('conv1', 'A'.repeat(22))).toMatchObject(notFound);
      expect(await store.update('conv1', 'A'.repeat(22), { content: 'x' })).toMatchObject(notFound);
      expect(await store.getById('A'.repeat(22))).toMatchObject(notFound);
    });

    it('a stray file under a valid artifact id gives not-found, not io', async () => {
      const store = createArtifactStore(root);
      await fs.mkdir(path.join(root, 'conv1'));
      await fs.writeFile(path.join(root, 'conv1', 'A'.repeat(22)), 'stray');
      expect(await store.get('conv1', 'A'.repeat(22))).toMatchObject(notFound);
      expect(await store.update('conv1', 'A'.repeat(22), { content: 'x' })).toMatchObject(notFound);
    });

    describe('with a symlinked conversation folder', () => {
      let outside: string;
      let id: string;

      beforeEach(async () => {
        outside = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-outside-'));
        id = ok(await createArtifactStore(outside).create('real', input)).id;
        await fs.symlink(path.join(outside, 'real'), path.join(root, 'link'));
      });

      afterEach(async () => {
        await fs.rm(outside, { recursive: true, force: true });
      });

      it('is not followed by get, update, create or getById', async () => {
        const store = createArtifactStore(root);
        expect(await store.get('link', id)).toMatchObject(notFound);
        expect(await store.update('link', id, { content: 'x' })).toMatchObject(notFound);
        expect(await store.create('link', input)).toMatchObject(notFound);
        expect(await store.getById(id)).toMatchObject(notFound);
        expect(await fs.readdir(path.join(outside, 'real'))).toEqual([id]);
        expect((await fs.readdir(path.join(outside, 'real', id))).toSorted()).toEqual(['meta.json', 'v1.html']);
      });

      it('is neither followed nor deleted by cleanup', async () => {
        const store = createArtifactStore(root);
        await age('link').catch(() => undefined); // utimes follows the link; irrelevant to the outcome
        expect(await store.cleanup(new Set(['keep']))).toBe(0);
        expect((await fs.lstat(path.join(root, 'link'))).isSymbolicLink()).toBe(true);
        expect(await fs.readdir(path.join(outside, 'real', id))).toHaveLength(2);
      });
    });
  });
});
