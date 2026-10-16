/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlatformServices } from '@/common/platform';
import { ARTIFACT_LIMITS } from '@/common/types/agent/artifacts';
import { artifactsRoot, cleanupArtifacts, fetchLiveConversationIds, startArtifacts } from '@process/artifacts';
import { BodyTooLarge, readBody } from '@process/artifacts/server';
import type { ArtifactStore } from '@process/artifacts/store';

vi.mock('@/common', () => ({ ipcBridge: {} }));

describe('artifactsRoot', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('keeps dev artifacts apart from release ones (separate backends must not clean each other up)', () => {
    const isPackaged = vi.spyOn(getPlatformServices().paths, 'isPackaged').mockReturnValue(false);
    vi.stubEnv('AIONUI_MULTI_INSTANCE', '');
    expect(artifactsRoot()).toBe(path.join(os.homedir(), '.aionui-dev', 'artifacts'));
    vi.stubEnv('AIONUI_MULTI_INSTANCE', '1');
    expect(artifactsRoot()).toBe(path.join(os.homedir(), '.aionui-dev-2', 'artifacts'));
    isPackaged.mockReturnValue(true);
    expect(artifactsRoot()).toBe(path.join(os.homedir(), '.aionui', 'artifacts'));
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

describe('create API body cap', () => {
  it('accepts near-limit content whose JSON escaping more than doubles the body', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifacts-cap-'));
    const started = await startArtifacts({ rootDir: root });
    try {
      // 1.9 MB of content; escaped (\" and \n) the request body is about 3.8 MB, past the old content + 64 KB cap.
      const content = '"\n'.repeat(Math.floor((1.9 * 1024 * 1024) / 2)).slice(0, 1.9 * 1024 * 1024);
      const response = await fetch(`${started?.server.origin}/api/artifacts/create`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${started?.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId: 'c1', title: 'Escapes', kind: 'html', content }),
      });
      expect(JSON.stringify({ content }).length).toBeGreaterThan(ARTIFACT_LIMITS.maxContentBytes + 64 * 1024);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true });
    } finally {
      await started?.server.close();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('readBody', () => {
  /** A request stream the test drives by hand. */
  const fakeRequest = () => new PassThrough() as unknown as IncomingMessage & PassThrough;

  it('resolves with the body once the client is done', async () => {
    const req = fakeRequest();
    const body = readBody(req);
    req.end('{"a":1}');
    await expect(body).resolves.toBe('{"a":1}');
  });

  it('a client abort below the cap rejects as an abort, not as too large', async () => {
    const req = fakeRequest();
    const body = readBody(req);
    req.write('{"a":');
    req.emit('close');
    const error = await body.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(BodyTooLarge);
    expect((error as Error).message).toMatch(/aborted/);
  });

  it('an upload past the cap rejects as too large', async () => {
    const req = fakeRequest();
    const body = readBody(req);
    req.end(Buffer.alloc(2 * ARTIFACT_LIMITS.maxContentBytes + 65 * 1024));
    await expect(body).rejects.toBeInstanceOf(BodyTooLarge);
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
