/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactKind, ArtifactVersion } from '@/common/types/agent/artifacts';
import { artifactsRoot, cleanupArtifacts, fetchLiveConversationIds, startArtifacts } from '@process/artifacts';
import { renderArtifactPage } from '@process/artifacts/server';
import type { ArtifactStore } from '@process/artifacts/store';

vi.mock('@/common', () => ({ ipcBridge: {} }));

const version = (kind: ArtifactKind, content: string, title = 'T'): ArtifactVersion => ({
  id: 'AAAAAAAAAAAAAAAAAAAAAA',
  conversationId: 'conv1',
  title,
  kind,
  createdAt: 1,
  updatedAt: 1,
  latest: 1,
  version: 1,
  content,
});

describe('renderArtifactPage', () => {
  it('serves html as written', () => {
    expect(renderArtifactPage(version('html', '<h1>x</h1>'))).toBe('<h1>x</h1>');
  });

  it('wraps svg in an <img> data url and escapes the title', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
    const html = renderArtifactPage(version('svg', svg, '"><script>'));
    expect(html).toContain(`<img src="data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}"`);
    expect(html).not.toContain('<svg');
    expect(html).not.toContain('"><script>');
  });

  it.each(['react', 'markdown', 'mermaid'] as const)('shows a "kind not available yet" page for %s', (kind) => {
    const html = renderArtifactPage(version(kind, '<script>alert(1)</script>'));
    expect(html).toContain('not available yet');
    expect(html).not.toContain('<script>alert(1)</script>');
  });
});

describe('artifactsRoot', () => {
  it('keeps dev artifacts apart from release ones (separate backends must not clean each other up)', () => {
    expect(artifactsRoot()).toBe(path.join(os.homedir(), '.aionui-dev', 'artifacts'));
  });
});

describe('startArtifacts', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifacts-start-'));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  it('starts a server with a 32-byte base64url token', async () => {
    const started = await startArtifacts({ rootDir: root });
    try {
      expect(started?.token).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(started?.server.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    } finally {
      await started?.server.close();
    }
  });

  it('startArtifacts returns null and logs when the port bind fails', async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(0, '127.0.0.1', resolve));
    const { port } = blocker.address() as net.AddressInfo;
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      expect(await startArtifacts({ rootDir: root, port })).toBeNull();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('[artifacts]'), expect.anything());
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });
});

type Page = { items: { id: string }[]; total: number; has_more: boolean };

describe('fetchLiveConversationIds', () => {
  const pages = (all: string[], size: number) =>
    vi.fn(async (cursor?: string): Promise<Page> => {
      const start = cursor ? all.indexOf(cursor) + 1 : 0;
      const items = all.slice(start, start + size).map((id) => ({ id }));
      return { items, total: all.length, has_more: start + size < all.length };
    });

  it('pages through every page, using the last id as the cursor', async () => {
    const listPage = pages(['a', 'b', 'c', 'd', 'e'], 2);
    expect(await fetchLiveConversationIds(listPage)).toEqual(new Set(['a', 'b', 'c', 'd', 'e']));
    expect(listPage.mock.calls).toEqual([[undefined], ['b'], ['d']]);
  });

  it('returns null when a page fails', async () => {
    const listPage = vi.fn().mockResolvedValueOnce({ items: [{ id: 'a' }], total: 2, has_more: true });
    listPage.mockRejectedValueOnce(new Error('down'));
    expect(await fetchLiveConversationIds(listPage)).toBeNull();
  });

  it('returns null when the pages do not add up to the total', async () => {
    expect(
      await fetchLiveConversationIds(async () => ({ items: [{ id: 'a' }], total: 2, has_more: false }))
    ).toBeNull();
    // A page that claims more but is empty would loop forever.
    expect(await fetchLiveConversationIds(async () => ({ items: [], total: 1, has_more: true }))).toBeNull();
  });

  it('returns null on a malformed page', async () => {
    expect(await fetchLiveConversationIds(async () => ({}) as Page)).toBeNull();
  });
});

describe('cleanupArtifacts', () => {
  let root: string;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifacts-cleanup-'));
    await Promise.all(['live', 'archived', 'gone'].map((n) => fs.mkdir(path.join(root, n))));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(root, { recursive: true, force: true });
  });

  const storeSpy = () => {
    const cleanup = vi.fn(async () => 1);
    return { store: { cleanup } as unknown as ArtifactStore, cleanup };
  };

  it('keeps listed and still-existing (archived) conversations, removes the rest', async () => {
    const { store, cleanup } = storeSpy();
    const exists = vi.fn(async (id: string) => id === 'archived');
    await cleanupArtifacts(store, root, {
      listPage: async () => ({ items: [{ id: 'live' }], total: 1, has_more: false }),
      exists,
    });
    expect(exists.mock.calls.map(([id]) => id).toSorted()).toEqual(['archived', 'gone']);
    expect(cleanup).toHaveBeenCalledWith(new Set(['live', 'archived']), { allowEmpty: false });
  });

  it('skips cleanup entirely when the list fetch fails', async () => {
    const { store, cleanup } = storeSpy();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await cleanupArtifacts(store, root, {
      listPage: async () => {
        throw new Error('backend down');
      },
      exists: async () => false,
    });
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('skips cleanup entirely when an existence check fails', async () => {
    const { store, cleanup } = storeSpy();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await cleanupArtifacts(store, root, {
      listPage: async () => ({ items: [{ id: 'live' }], total: 1, has_more: false }),
      exists: async (id) => {
        if (id === 'gone') throw new Error('500');
        return false;
      },
    });
    expect(cleanup).not.toHaveBeenCalled();
  });
});
