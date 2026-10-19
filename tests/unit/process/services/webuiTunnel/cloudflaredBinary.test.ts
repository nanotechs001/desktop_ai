/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CLOUDFLARED_ASSETS,
  CLOUDFLARED_VERSION,
  ensureCloudflared,
  extractTgz,
  type CloudflaredAsset,
} from '@process/webuiTunnel/cloudflaredBinary';

const sha = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');

const BIN = Buffer.from('fake cloudflared binary');
const TGZ = Buffer.from('fake tgz bytes');

const testAssets: Record<string, CloudflaredAsset> = {
  'linux-x64': { asset: 'cloudflared-linux-amd64', sha256: sha(BIN), archive: 'none' },
  'win32-x64': { asset: 'cloudflared-windows-amd64.exe', sha256: sha(BIN), archive: 'none' },
  'darwin-arm64': {
    asset: 'cloudflared-darwin-arm64.tgz',
    sha256: sha(BIN),
    archive: 'tgz',
    archiveSha256: sha(TGZ),
  },
};

const enoent = () => Object.assign(new Error('ENOENT'), { code: 'ENOENT' });

const makeFs = (initial: Record<string, Buffer> = {}) => {
  const files = new Map(Object.entries(initial));
  return {
    files,
    readFile: vi.fn(async (p: string) => {
      const data = files.get(p);
      if (!data) throw enoent();
      return data;
    }),
    writeFile: vi.fn(async (p: string, data: Buffer) => {
      files.set(p, Buffer.from(data));
    }),
    mkdir: vi.fn(async () => undefined),
    rm: vi.fn(async (p: string) => {
      for (const key of files.keys()) if (key === p || key.startsWith(`${p}/`)) files.delete(key);
    }),
    rename: vi.fn(async (from: string, to: string) => {
      const data = files.get(from);
      if (!data) throw enoent();
      files.delete(from);
      files.set(to, data);
    }),
    chmod: vi.fn(async () => undefined),
  };
};

const okResponse = (body: Buffer) => new Response(new Uint8Array(body), { status: 200 });

const setup = (platformKey: string, body: Buffer, initial: Record<string, Buffer> = {}, inner: Buffer = BIN) => {
  const fs = makeFs(initial);
  const fetch = vi.fn(async () => okResponse(body));
  const extract = vi.fn(async (_buf: Buffer, dest: string) => {
    fs.files.set(path.join(dest, 'cloudflared'), inner);
  });
  const onDownload = vi.fn();
  const deps = {
    binDir: '/data/bin',
    platformKey,
    fetch: fetch as unknown as typeof globalThis.fetch,
    fs,
    extractTgz: extract,
    assets: testAssets,
    onDownload,
  };
  return { fs, fetch, extract, onDownload, deps };
};

describe('ensureCloudflared', () => {
  it('downloads the pinned asset, verifies it, makes it executable and returns its path', async () => {
    const { fs, fetch, onDownload, deps } = setup('linux-x64', BIN);
    await expect(ensureCloudflared(deps)).resolves.toBe('/data/bin/cloudflared');
    expect(fetch).toHaveBeenCalledWith(
      `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/cloudflared-linux-amd64`,
      expect.anything()
    );
    expect(onDownload).toHaveBeenCalledTimes(1);
    expect(fs.files.get('/data/bin/cloudflared')).toEqual(BIN);
    expect(fs.chmod).toHaveBeenCalledWith('/data/bin/cloudflared.tmp', 0o755);
    expect(fs.rename).toHaveBeenCalledWith('/data/bin/cloudflared.tmp', '/data/bin/cloudflared');
    expect([...fs.files.keys()]).toEqual(['/data/bin/cloudflared']);
  });

  it('uses cloudflared.exe on Windows and does not chmod', async () => {
    const { fs, deps } = setup('win32-x64', BIN);
    await expect(ensureCloudflared(deps)).resolves.toBe(path.join('/data/bin', 'cloudflared.exe'));
    expect(fs.chmod).not.toHaveBeenCalled();
  });

  it('does not download again when the binary on disk has the pinned hash', async () => {
    const { fetch, onDownload, deps } = setup('linux-x64', BIN, { '/data/bin/cloudflared': BIN });
    await expect(ensureCloudflared(deps)).resolves.toBe('/data/bin/cloudflared');
    expect(fetch).not.toHaveBeenCalled();
    expect(onDownload).not.toHaveBeenCalled();
  });

  it('replaces a binary on disk whose hash does not match', async () => {
    const { fs, fetch, deps } = setup('linux-x64', BIN, { '/data/bin/cloudflared': Buffer.from('tampered') });
    await ensureCloudflared(deps);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fs.files.get('/data/bin/cloudflared')).toEqual(BIN);
  });

  it('throws on a checksum mismatch and leaves no binary behind', async () => {
    const { fs, deps } = setup('linux-x64', Buffer.from('evil'));
    await expect(ensureCloudflared(deps)).rejects.toThrow('cloudflared checksum mismatch');
    expect(fs.files.size).toBe(0);
  });

  it('verifies and extracts the tgz on darwin', async () => {
    const { fs, extract, deps } = setup('darwin-arm64', TGZ);
    await expect(ensureCloudflared(deps)).resolves.toBe('/data/bin/cloudflared');
    expect(extract).toHaveBeenCalledWith(TGZ, '/data/bin/cloudflared.extract');
    expect(fs.chmod).toHaveBeenCalledWith('/data/bin/cloudflared.extract/cloudflared', 0o755);
    expect([...fs.files.keys()]).toEqual(['/data/bin/cloudflared']);
  });

  it('does not extract a tgz whose own hash does not match', async () => {
    const { extract, deps } = setup('darwin-arm64', Buffer.from('evil tgz'));
    await expect(ensureCloudflared(deps)).rejects.toThrow('cloudflared checksum mismatch');
    expect(extract).not.toHaveBeenCalled();
  });

  it('deletes an extracted binary whose hash does not match', async () => {
    const { fs, deps } = setup('darwin-arm64', TGZ, {}, Buffer.from('evil inner'));
    await expect(ensureCloudflared(deps)).rejects.toThrow('cloudflared checksum mismatch');
    expect(fs.files.size).toBe(0);
  });

  it('throws when the download fails', async () => {
    const { fetch, deps } = setup('linux-x64', BIN);
    fetch.mockResolvedValueOnce(new Response('nope', { status: 404 }));
    await expect(ensureCloudflared(deps)).rejects.toThrow('404');
  });

  it('throws on an unsupported platform', async () => {
    const { deps } = setup('freebsd-x64', BIN);
    await expect(ensureCloudflared(deps)).rejects.toThrow('freebsd-x64');
  });
});

describe('CLOUDFLARED_ASSETS', () => {
  it('pins a sha256 for each supported platform', () => {
    expect(Object.keys(CLOUDFLARED_ASSETS).toSorted()).toEqual(
      ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64', 'win32-x64'].toSorted()
    );
    for (const entry of Object.values(CLOUDFLARED_ASSETS)) {
      expect(entry.sha256).toMatch(/^[0-9a-f]{64}$/);
      if (entry.archive === 'tgz') expect(entry.archiveSha256).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(CLOUDFLARED_ASSETS['darwin-arm64'].archive).toBe('tgz');
    expect(CLOUDFLARED_ASSETS['win32-x64'].asset).toBe('cloudflared-windows-amd64.exe');
  });
});

describe.skipIf(process.platform === 'win32')('extractTgz', () => {
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  it('extracts only the cloudflared member with the system tar', async () => {
    const src = mkdtempSync(path.join(tmpdir(), 'cf-src-'));
    const dest = mkdtempSync(path.join(tmpdir(), 'cf-dest-'));
    dirs.push(src, dest);
    writeFileSync(path.join(src, 'cloudflared'), 'inner');
    writeFileSync(path.join(src, 'other'), 'ignored');
    const tgz = execFileSync('tar', ['-czf', '-', '-C', src, 'cloudflared', 'other']);
    await extractTgz(tgz, dest);
    expect(readFileSync(path.join(dest, 'cloudflared'), 'utf-8')).toBe('inner');
    expect(existsSync(path.join(dest, 'other'))).toBe(false);
  });
});
