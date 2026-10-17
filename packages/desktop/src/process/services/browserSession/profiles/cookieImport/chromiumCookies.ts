/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

/*
 * Chromium's macOS cookie encryption: the "<Browser> Safe Storage" Keychain password, PBKDF2-SHA1 with salt
 * `saltysalt`, 1003 iterations and 16 bytes, gives an AES-128-CBC key; values are `v10` + ciphertext, IV 16 spaces.
 * From DB `meta.version` 24 on, the plaintext starts with a 32-byte SHA-256 of the cookie's `host_key`.
 */

const KEY_SALT = 'saltysalt';
const KEY_ITERATIONS = 1003;
const KEY_BYTES = 16;
const IV = Buffer.alloc(16, ' ');
const V10 = Buffer.from('v10');
const HOST_HASH_BYTES = 32;
const HOST_HASH_META_VERSION = 24;
/** Seconds between 1601-01-01 (Chromium's time origin) and 1970-01-01. */
const WINDOWS_EPOCH_OFFSET_S = 11644473600;
const MICROS_PER_SECOND = 1_000_000;

/** A decrypted cookie. Its value stays in main: only `session.cookies.set` ever receives it. */
export type ImportedCookie = {
  /** Chromium's `host_key`: a leading dot for a domain cookie, none for a host-only one. */
  hostKey: string;
  name: string;
  value: string;
  path: string;
  /** Unix seconds; null for a session cookie. */
  expires: number | null;
  secure: boolean;
  httpOnly: boolean;
  /** Chromium's value: -1 unspecified, 0 no_restriction, 1 lax, 2 strict. */
  sameSite: number;
};

/** The cookies read, and those skipped: expired, failing to decrypt, or partitioned (CHIPS, not importable). */
export type ChromiumCookieRead = {
  cookies: ImportedCookie[];
  skipped: { expired: number; undecryptable: number; partitioned: number };
};

type CookieRow = {
  host_key: string;
  name: string;
  value: string | null;
  encrypted_value: Uint8Array | null;
  path: string | null;
  expires_utc: number | bigint;
  is_secure: number | bigint;
  is_httponly: number | bigint;
  samesite: number | bigint;
  /** Only in DBs new enough to store partitioned (CHIPS) cookies; non-empty for one. */
  top_frame_site_key?: string | null;
};

/** The AES key for a "<Browser> Safe Storage" password: PBKDF2-SHA1, `saltysalt`, 1003 iterations, 16 bytes. */
export const deriveKey = (password: string): Buffer =>
  pbkdf2Sync(password, KEY_SALT, KEY_ITERATIONS, KEY_BYTES, 'sha1');

/**
 * Decrypts a `v10` cookie value of the cookie whose `host_key` is `hostKey`. When `metaVersion >= 24` the value must
 * start with sha256(hostKey), which is then dropped; that check also catches the ~1 in 256 wrong keys that leave
 * valid padding. Null for any other prefix, a wrong key, bad padding or a hash mismatch.
 */
export function decryptValue(enc: Buffer, key: Buffer, metaVersion: number, hostKey: string): string | null {
  if (enc.length <= V10.length || !enc.subarray(0, V10.length).equals(V10)) return null;
  let plain: Buffer;
  try {
    const decipher = createDecipheriv('aes-128-cbc', key, IV);
    plain = Buffer.concat([decipher.update(enc.subarray(V10.length)), decipher.final()]);
  } catch {
    return null;
  }
  if (metaVersion < HOST_HASH_META_VERSION) return plain.toString('utf8');
  const hostHash = createHash('sha256').update(hostKey).digest();
  if (plain.length < HOST_HASH_BYTES || !plain.subarray(0, HOST_HASH_BYTES).equals(hostHash)) return null;
  return plain.subarray(HOST_HASH_BYTES).toString('utf8');
}

/**
 * Whole Unix seconds for a Chromium time (microseconds since 1601); null for 0, a session cookie. Rounded, because
 * these values pass 2^53 and lose a few microseconds as JS numbers.
 */
const unixSeconds = (expiresUtc: number): number | null =>
  expiresUtc === 0 ? null : Math.round(expiresUtc / MICROS_PER_SECOND) - WINDOWS_EPOCH_OFFSET_S;

/**
 * Whether a cookie belongs to one of `domains`: its host is the domain or under it, or it is a domain cookie of a
 * parent the site uses (`.google.com` for `mail.google.com`).
 */
const inDomains = (hostKey: string, domains: string[]): boolean => {
  const host = hostKey.replace(/^\./, '').toLowerCase();
  return domains.some(
    (domain) =>
      host === domain || host.endsWith(`.${domain}`) || (hostKey.startsWith('.') && domain.endsWith(`.${host}`))
  );
};

const copyIfPresent = async (from: string, to: string): Promise<void> => {
  try {
    await fs.copyFile(from, to);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
};

/**
 * Reads and decrypts a Chromium cookie DB. Never opens `cookiesPath` itself: it copies the DB (with its `-wal` and
 * `-journal` files, so a running browser's recent writes count) to a temp dir, reads the copy readonly, and removes
 * the copy in `finally`. `domains` null means every site. Expired, undecryptable and partitioned cookies are
 * skipped and counted.
 */
export async function readChromiumCookies(
  cookiesPath: string,
  key: Buffer,
  domains: string[] | null
): Promise<ChromiumCookieRead> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'aionui-cookies-'));
  try {
    const copy = path.join(dir, 'Cookies');
    await fs.copyFile(cookiesPath, copy);
    await copyIfPresent(`${cookiesPath}-wal`, `${copy}-wal`);
    await copyIfPresent(`${cookiesPath}-journal`, `${copy}-journal`);

    const { default: Database } = await import('better-sqlite3');
    const db = new Database(copy, { readonly: true, fileMustExist: true });
    let metaVersion: number;
    let rows: CookieRow[];
    try {
      const meta = db.prepare("SELECT value FROM meta WHERE key = 'version'").get() as { value?: unknown } | undefined;
      metaVersion = Number(meta?.value ?? 0);
      // `*`: older DBs have no top_frame_site_key column.
      rows = db.prepare('SELECT * FROM cookies').all() as CookieRow[];
    } finally {
      db.close();
    }

    const nowS = Date.now() / 1000;
    const cookies: ImportedCookie[] = [];
    const skipped = { expired: 0, undecryptable: 0, partitioned: 0 };
    for (const row of rows) {
      if (domains !== null && !inDomains(row.host_key, domains)) continue;
      if (row.top_frame_site_key) {
        skipped.partitioned += 1;
        continue;
      }
      const expires = unixSeconds(Number(row.expires_utc));
      if (expires !== null && expires <= nowS) {
        skipped.expired += 1;
        continue;
      }
      const encrypted = row.encrypted_value ? Buffer.from(row.encrypted_value) : Buffer.alloc(0);
      const value = encrypted.length > 0 ? decryptValue(encrypted, key, metaVersion, row.host_key) : (row.value ?? '');
      if (value === null) {
        skipped.undecryptable += 1;
        continue;
      }
      cookies.push({
        hostKey: row.host_key,
        name: row.name,
        value,
        path: row.path || '/',
        expires,
        secure: Number(row.is_secure) === 1,
        httpOnly: Number(row.is_httponly) === 1,
        sameSite: Number(row.samesite),
      });
    }
    return { cookies, skipped };
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}
