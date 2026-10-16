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

    expect(await store.cleanup(new Set(['keep']))).toBe(2);
    expect((await fs.readdir(root)).toSorted()).toEqual(['keep']);
    expect(ok(await store.getById(keep.id)).id).toBe(keep.id);
  });

  it('cleanup drops removed artifacts from the id index', async () => {
    const store = createArtifactStore(root);
    const gone = ok(await store.create('gone', input));
    await store.create('keep', input);
    await store.cleanup(new Set(['keep']));
    expect(await store.getById(gone.id)).toMatchObject({ ok: false, error: 'not-found' });
  });

  it('cleanup(new Set()) deletes nothing unless allowEmpty is set', async () => {
    const store = createArtifactStore(root);
    await store.create('a', input);
    await store.create('b', input);

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
});
