/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The pinned cloudflared connector for the WebUI secure link: download on first use, verify, never use one from PATH.
 */

import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

export const CLOUDFLARED_VERSION = '2026.10.1';

export type CloudflaredPlatformKey = 'darwin-arm64' | 'darwin-x64' | 'win32-x64' | 'linux-x64' | 'linux-arm64';

/** `sha256` is the cloudflared binary itself; for a tgz, `archiveSha256` is the downloaded archive. */
export type CloudflaredAsset = { asset: string; sha256: string; archive: 'tgz' | 'none'; archiveSha256?: string };

/**
 * Source: https://github.com/cloudflare/cloudflared/releases/tag/2026.10.1
 * `sha256` values are the release body's "SHA256 Checksums". Linux and Windows match the GitHub asset `digest`
 * (https://api.github.com/repos/cloudflare/cloudflared/releases/tags/2026.10.1). For the darwin tgz the body lists
 * the binary inside the archive (Cloudflare, cloudflared issues #1004 and #1648), so `archiveSha256` is the
 * asset `digest` and the archive is checked before it is unpacked.
 */
export const CLOUDFLARED_ASSETS: Record<CloudflaredPlatformKey, CloudflaredAsset> = {
  'darwin-arm64': {
    asset: 'cloudflared-darwin-arm64.tgz',
    sha256: '35b7e34c9a3f214d80d859c4223450c69e583c7668d228c45771026fe376cab9',
    archive: 'tgz',
    archiveSha256: '647615df99d49cd179ea5e13ef760b9bbfb33630f6ae62f87e33dfadda60adcc',
  },
  'darwin-x64': {
    asset: 'cloudflared-darwin-amd64.tgz',
    sha256: '8ccc6383aef109c8d88965937649a796febbb166dab4b73345e820623aee1ede',
    archive: 'tgz',
    archiveSha256: '3b0dbaf378337e9d7fb6cd235a76d1d6a7dee434c2d8edf9281164fb6a3837ab',
  },
  'win32-x64': {
    asset: 'cloudflared-windows-amd64.exe',
    sha256: '4d2490e74082c5d48dbfedaf92576fa5bd1702379ab88eb7faa0cfbe8dc891b6',
    archive: 'none',
  },
  'linux-x64': {
    asset: 'cloudflared-linux-amd64',
    sha256: '3bfc539f45d2620c71debb7a86be0efa737ed5ccbad9eb85c787116900e5c586',
    archive: 'none',
  },
  'linux-arm64': {
    asset: 'cloudflared-linux-arm64',
    sha256: '2c65dfabf616c40efc7545d107d7a57ad5e21377e2964b7e88af19a238074a46',
    archive: 'none',
  },
};

const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
const CHECKSUM_MISMATCH = 'cloudflared checksum mismatch';

export type CloudflaredFs = {
  readFile: (file: string) => Promise<Buffer>;
  writeFile: (file: string, data: Buffer, options?: { mode?: number }) => Promise<void>;
  mkdir: (dir: string, options: { recursive: true }) => Promise<unknown>;
  rm: (file: string, options: { force: true; recursive?: boolean }) => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  chmod: (file: string, mode: number) => Promise<void>;
};

export type EnsureCloudflaredDeps = {
  binDir: string;
  platformKey: string;
  fetch: typeof fetch;
  fs: CloudflaredFs;
  extractTgz: (buf: Buffer, dest: string) => Promise<void>;
  /** Called once a download starts (nothing usable on disk). */
  onDownload?: () => void;
  /** Test seam; defaults to the pinned table. */
  assets?: Partial<Record<string, CloudflaredAsset>>;
};

export const cloudflaredPlatformKey = (): string => `${process.platform}-${process.arch}`;

const sha256 = (data: Buffer): string => createHash('sha256').update(data).digest('hex');

const readOrNull = async (fs: CloudflaredFs, file: string): Promise<Buffer | null> => {
  try {
    return await fs.readFile(file);
  } catch {
    return null;
  }
};

const download = async (fetchImpl: typeof fetch, asset: string): Promise<Buffer> => {
  const url = `https://github.com/cloudflare/cloudflared/releases/download/${CLOUDFLARED_VERSION}/${asset}`;
  // Redirects to GitHub's asset CDN are fine: the pinned hash, not the host, guarantees integrity.
  // shortcut: Node fetch (and cloudflared) ignore the system proxy; upgrade if users behind proxies report it.
  const res = await fetchImpl(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`cloudflared download failed (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
};

/** Path of a verified, pinned cloudflared in `binDir`, downloading it first when missing or altered. */
export async function ensureCloudflared(deps: EnsureCloudflaredDeps): Promise<string> {
  const { binDir, platformKey, fs } = deps;
  const assets: Partial<Record<string, CloudflaredAsset>> = deps.assets ?? CLOUDFLARED_ASSETS;
  const entry = assets[platformKey];
  if (!entry) throw new Error(`The secure link is not available on ${platformKey}`);
  const isWindows = platformKey.startsWith('win32');
  const binPath = path.join(binDir, isWindows ? 'cloudflared.exe' : 'cloudflared');

  const existing = await readOrNull(fs, binPath);
  if (existing && sha256(existing) === entry.sha256) return binPath;
  await fs.rm(binPath, { force: true });
  await fs.mkdir(binDir, { recursive: true });
  deps.onDownload?.();

  // Verified bytes are staged next to binPath and renamed into place, so binPath is only ever replaced atomically.
  const body = await download(deps.fetch, entry.asset);
  const extractDir = path.join(binDir, 'cloudflared.extract');
  const staged = entry.archive === 'tgz' ? path.join(extractDir, 'cloudflared') : `${binPath}.tmp`;
  try {
    if (entry.archive === 'tgz') {
      if (sha256(body) !== entry.archiveSha256) throw new Error(CHECKSUM_MISMATCH);
      await fs.rm(extractDir, { force: true, recursive: true });
      await fs.mkdir(extractDir, { recursive: true });
      await deps.extractTgz(body, extractDir);
    } else {
      if (sha256(body) !== entry.sha256) throw new Error(CHECKSUM_MISMATCH);
      await fs.writeFile(staged, body, { mode: 0o755 });
    }
    const unpacked = await readOrNull(fs, staged);
    if (!unpacked || sha256(unpacked) !== entry.sha256) throw new Error(CHECKSUM_MISMATCH);
    if (!isWindows) await fs.chmod(staged, 0o755);
    await fs.rename(staged, binPath);
  } finally {
    // A failed cleanup is logged, never thrown, so it cannot mask the original error.
    const cleanup = (target: string) =>
      fs.rm(target, { force: true, recursive: true }).catch((error: unknown) => {
        console.warn('[WebUI tunnel] could not remove', target, error);
      });
    await cleanup(staged);
    if (entry.archive === 'tgz') await cleanup(extractDir);
  }
  return binPath;
}

/** Unpacks only the `cloudflared` member of a verified tgz into `dest` with the system tar (darwin only). */
export async function extractTgz(buf: Buffer, dest: string): Promise<void> {
  const archive = path.join(dest, `cloudflared-${process.pid}.tgz`);
  await writeFile(archive, buf);
  try {
    await promisify(execFile)('tar', ['-xzf', archive, '-C', dest, 'cloudflared']);
  } finally {
    await rm(archive, { force: true });
  }
}
