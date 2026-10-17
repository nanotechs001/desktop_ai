/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Fixture DBs and a fake `security` only: these tests never read a real browser profile or the Keychain.

import { createCipheriv, createDecipheriv, createHash, pbkdf2Sync } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Provider = (request?: unknown) => Promise<{ success: boolean; data?: unknown; msg?: string }>;
type SetDetails = Record<string, unknown>;

const h = vi.hoisted(() => {
  const providers = new Map<string, Provider>();
  const provider = (name: string) => ({ provider: (fn: Provider) => providers.set(name, fn) });
  return {
    providers,
    home: { dir: '', fail: false },
    // The IPC reads the Keychain through execFile; this one answers like `security -w` with the test password.
    execFile: vi.fn(
      (_file: string, _args: string[], _options: unknown, callback: (error: Error | null, stdout: string) => void) =>
        callback(null, 'peanuts\n')
    ),
    opened: [] as Array<{ file: string; readonly: boolean }>,
    sessions: new Map<string, { cookies: { set: ReturnType<typeof vi.fn> } }>(),
    bridge: {
      browser: {
        profileRemoved: { emit: () => {} },
        profilePartition: provider('profilePartition'),
        clearProfileData: provider('clearProfileData'),
        deleteProfileData: provider('deleteProfileData'),
        cookieImport: { listSources: provider('listSources'), run: provider('run') },
      },
    },
  };
});

// better-sqlite3 is built for Electron's ABI; the tests read the copy through node:sqlite with the same calls.
vi.mock('better-sqlite3', async () => {
  const { DatabaseSync: Sync } = await import('node:sqlite');
  class FakeDatabase {
    private readonly db: InstanceType<typeof Sync>;
    constructor(file: string, options: { readonly?: boolean; fileMustExist?: boolean } = {}) {
      if (options.fileMustExist && !fs.existsSync(file)) throw new Error('no such file');
      h.opened.push({ file, readonly: options.readonly === true });
      this.db = new Sync(file, { readOnly: options.readonly === true });
    }
    prepare(sql: string) {
      const statement = this.db.prepare(sql);
      // Chromium times pass 2^53; node:sqlite throws on those unless it reads them as bigints.
      statement.setReadBigInts(true);
      return statement;
    }
    close() {
      this.db.close();
    }
  }
  return { default: FakeDatabase };
});
vi.mock('@/common', () => ({ ipcBridge: h.bridge }));
vi.mock('node:child_process', () => ({ execFile: h.execFile }));
vi.mock('electron', () => ({
  app: {
    getPath: (name: string) => {
      if (name !== 'home') return '/nonexistent-aionui-test-user-data';
      if (h.home.fail) throw new Error(`EACCES: permission denied, scandir '${h.home.dir}/Library'`);
      return h.home.dir;
    },
  },
  session: { fromPartition: vi.fn() },
  webContents: { getAllWebContents: () => [] },
  BrowserWindow: { fromWebContents: () => null },
}));
vi.mock('@process/services/browserSession/permissions', () => ({ forgetPermissions: vi.fn() }));
vi.mock('@process/services/browserSession/browserSession', () => ({
  ensureBrowserSession: (partition: string) => {
    const existing = h.sessions.get(partition);
    if (existing) return existing;
    const created = { cookies: { set: vi.fn((_details: SetDetails) => Promise.resolve()) } };
    h.sessions.set(partition, created);
    return created;
  },
  forgetBrowserSession: vi.fn(),
  browserExtensionsSettled: () => Promise.resolve(),
}));

import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';
import { agentPartition } from '@process/services/browserSession/profiles/browserProfiles';
import {
  decryptValue,
  deriveKey,
  readChromiumCookies,
} from '@process/services/browserSession/profiles/cookieImport/chromiumCookies';
import { detectBrowserSources } from '@process/services/browserSession/profiles/cookieImport/detect';
import { SAFE_STORAGE, importCookies } from '@process/services/browserSession/profiles/cookieImport/importCookies';
import { registerBrowserProfileIpc } from '@process/services/browserSession/profiles/profileIpc';

const PASSWORD = 'peanuts';
const KEY = pbkdf2Sync(PASSWORD, 'saltysalt', 1003, 16, 'sha1');
const IV = Buffer.alloc(16, ' ');
const AGENT_ID = 'bare:632f31d2';
/** Microseconds between 1601-01-01 and 1970-01-01, as Chromium stores times. */
const EPOCH_DELTA_US = 11644473600n * 1000000n;
const NOW_S = Math.floor(Date.now() / 1000);
const chromiumTime = (unixSeconds: number): bigint => BigInt(unixSeconds) * 1000000n + EPOCH_DELTA_US;
const SECRET_VALUES = ['sid-secret-1', 'pref-secret-2', 'host-secret-3', 'sess-secret-4', 'other-secret-5'];

const encrypt = (value: string, metaVersion: number, host: string): Buffer => {
  const prefix = metaVersion >= 24 ? createHash('sha256').update(host).digest() : Buffer.alloc(0);
  const cipher = createCipheriv('aes-128-cbc', KEY, IV);
  const body = Buffer.concat([cipher.update(Buffer.concat([prefix, Buffer.from(value)])), cipher.final()]);
  return Buffer.concat([Buffer.from('v10'), body]);
};

type FixtureCookie = {
  host: string;
  name: string;
  value: string;
  path?: string;
  expires?: bigint;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: number;
  encrypted?: Buffer;
  /** CHIPS: the top-level site a partitioned cookie belongs to. */
  topFrameSiteKey?: string;
};

const FIXTURE: FixtureCookie[] = [
  // A domain cookie for every subdomain, persistent, lax.
  {
    host: '.example.com',
    name: 'sid',
    value: SECRET_VALUES[0],
    expires: chromiumTime(NOW_S + 86400),
    secure: true,
    httpOnly: true,
    sameSite: 1,
  },
  // A host-only cookie, strict.
  {
    host: 'app.example.com',
    name: '__Host-pref',
    value: SECRET_VALUES[1],
    path: '/',
    expires: chromiumTime(NOW_S + 3600),
    secure: true,
    sameSite: 2,
  },
  // A __Secure- cookie that is not secure: the browser would refuse it, so it is rejected.
  { host: 'example.com', name: '__Secure-bad', value: SECRET_VALUES[2], secure: false, sameSite: -1 },
  // A session cookie (expires 0), no_restriction.
  { host: 'shop.example.com', name: 'cart', value: SECRET_VALUES[3], expires: 0n, secure: true, sameSite: 0 },
  // Expired.
  { host: '.example.com', name: 'old', value: 'expired-value', expires: chromiumTime(NOW_S - 60) },
  // Undecryptable: garbage after v10, and an unknown prefix.
  {
    host: '.example.com',
    name: 'broken',
    value: '',
    encrypted: Buffer.concat([Buffer.from('v10'), Buffer.alloc(16, 7)]),
  },
  { host: '.example.com', name: 'v11', value: '', encrypted: Buffer.from('v11xxxxxxxxxxxxxxxxx') },
  // Partitioned (CHIPS): skipped and counted as rejected. Only in DBs that have the column (meta 24 here).
  {
    host: '.example.com',
    name: 'chips',
    value: 'chips-secret-6',
    expires: chromiumTime(NOW_S + 86400),
    secure: true,
    topFrameSiteKey: 'https://embedder.test',
  },
  // Another site.
  { host: '.other.org', name: 'o', value: SECRET_VALUES[4], expires: chromiumTime(NOW_S + 86400), secure: true },
];

/**
 * Writes a Chromium-like `Cookies` DB. Older DBs (meta < 24 here) have no `top_frame_site_key` column, so their
 * fixture leaves the partitioned cookie out. `wal` keeps the writer open in WAL mode with no checkpoint, the way a
 * running browser leaves recent rows only in `Cookies-wal`; the caller closes the returned DB.
 */
function buildCookiesDb(file: string, metaVersion: number, options: { wal: true }): DatabaseSync;
function buildCookiesDb(file: string, metaVersion: number, options?: { wal?: false }): void;
function buildCookiesDb(file: string, metaVersion: number, options: { wal?: boolean } = {}): DatabaseSync | void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const partitioned = metaVersion >= 24;
  const db = new DatabaseSync(file);
  if (options.wal) {
    db.exec('PRAGMA journal_mode=WAL');
    db.exec('PRAGMA wal_autocheckpoint=0');
  }
  db.exec('CREATE TABLE meta (key TEXT NOT NULL UNIQUE PRIMARY KEY, value TEXT)');
  db.exec(
    'CREATE TABLE cookies (host_key TEXT, name TEXT, value TEXT, encrypted_value BLOB, path TEXT, ' +
      'expires_utc INTEGER, is_secure INTEGER, is_httponly INTEGER, samesite INTEGER' +
      (partitioned ? ', top_frame_site_key TEXT' : '') +
      ')'
  );
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('version', String(metaVersion));
  const insert = db.prepare(`INSERT INTO cookies VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?${partitioned ? ', ?' : ''})`);
  for (const c of FIXTURE) {
    if (c.topFrameSiteKey && !partitioned) continue;
    insert.run(
      c.host,
      c.name,
      '',
      c.encrypted ?? encrypt(c.value, metaVersion, c.host),
      c.path ?? '/',
      c.expires ?? 0n,
      c.secure ? 1 : 0,
      c.httpOnly ? 1 : 0,
      c.sameSite ?? -1,
      ...(partitioned ? [c.topFrameSiteKey ?? ''] : [])
    );
  }
  if (options.wal) return db;
  db.close();
}

const tmpDirs: string[] = [];
const makeTmp = (): string => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aionui-cookie-test-'));
  tmpDirs.push(dir);
  return dir;
};

/** A fake home with Chrome (two profiles, one with Network/Cookies) and Brave; Edge has a Local State but no Cookies. */
const makeHome = (metaVersion = 24): string => {
  const home = makeTmp();
  const support = path.join(home, 'Library', 'Application Support');
  const chrome = path.join(support, 'Google', 'Chrome');
  fs.mkdirSync(chrome, { recursive: true });
  fs.writeFileSync(
    path.join(chrome, 'Local State'),
    JSON.stringify({
      profile: {
        info_cache: { Default: { name: 'Person 1' }, 'Profile 1': { name: 'Work' }, '../evil': { name: 'x' } },
      },
    })
  );
  buildCookiesDb(path.join(chrome, 'Default', 'Cookies'), metaVersion);
  buildCookiesDb(path.join(chrome, 'Profile 1', 'Network', 'Cookies'), metaVersion);
  const brave = path.join(support, 'BraveSoftware', 'Brave-Browser');
  fs.mkdirSync(brave, { recursive: true });
  fs.writeFileSync(
    path.join(brave, 'Local State'),
    JSON.stringify({ profile: { info_cache: { Default: { name: 'Me' } } } })
  );
  buildCookiesDb(path.join(brave, 'Default', 'Cookies'), metaVersion);
  const edge = path.join(support, 'Microsoft Edge');
  fs.mkdirSync(edge, { recursive: true });
  fs.writeFileSync(
    path.join(edge, 'Local State'),
    JSON.stringify({ profile: { info_cache: { Default: { name: 'E' } } } })
  );
  return home;
};

const fakeSecurity = () => vi.fn((_file: string, _args: string[]) => Promise.resolve({ stdout: `${PASSWORD}\n` }));

const setCallsOf = (partition: string): SetDetails[] =>
  (h.sessions.get(partition)?.cookies.set.mock.calls ?? []).map(([details]) => details as SetDetails);

beforeEach(() => {
  h.execFile.mockClear();
  h.opened.length = 0;
  h.sessions.clear();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of tmpDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('Chromium cookie decryption', () => {
  it('deriveKey matches the known Chromium test vector for password "peanuts"', () => {
    // Chromium's own fixed Linux key is PBKDF2-SHA1("peanuts", "saltysalt", 1 iteration, 16 bytes) = fd621fe5…
    expect(pbkdf2Sync(PASSWORD, 'saltysalt', 1, 16, 'sha1').toString('hex')).toBe('fd621fe5a2b402539dfa147ca9272778');
    // macOS uses the same derivation with 1003 iterations.
    expect(deriveKey(PASSWORD).toString('hex')).toBe('d9a09d499b4e1b7461f28e67972c6dbd');
  });

  it('decryptValue decrypts v10, strips the 32-byte host hash when meta.version >= 24, returns null on bad padding', () => {
    const key = deriveKey(PASSWORD);
    expect(decryptValue(encrypt('hello', 23, 'a.com'), key, 23, 'a.com')).toBe('hello');
    expect(decryptValue(encrypt('hello', 24, 'a.com'), key, 24, 'a.com')).toBe('hello');
    expect(decryptValue(Buffer.concat([Buffer.from('v10'), Buffer.alloc(16, 7)]), key, 24, 'a.com')).toBeNull();
    expect(decryptValue(Buffer.from('v11abcdefabcdefabcdef'), key, 24, 'a.com')).toBeNull();
    expect(decryptValue(encrypt('hello', 24, 'a.com'), Buffer.alloc(16, 1), 24, 'a.com')).toBeNull();
  });

  it('decryptValue checks the host hash at meta.version >= 24, so a wrong key that passes the padding is caught', () => {
    const key = deriveKey(PASSWORD);
    const enc = encrypt('a-cookie-value-long-enough', 24, '.a.com');
    // Another host's hash in front of the value: decrypts fine, but it is not this cookie's.
    expect(decryptValue(enc, key, 24, '.b.com')).toBeNull();
    // About 1 in 256 wrong keys leaves valid PKCS7 padding; find one and make sure it still fails.
    const paddingPasses = (candidate: Buffer): boolean => {
      try {
        const decipher = createDecipheriv('aes-128-cbc', candidate, IV);
        Buffer.concat([decipher.update(enc.subarray(3)), decipher.final()]);
        return true;
      } catch {
        return false;
      }
    };
    const wrongKey = Array.from({ length: 4096 }, (_, i) => deriveKey(`wrong-${i}`)).find(paddingPasses);
    if (!wrongKey) throw new Error('no padding-passing wrong key in 4096 tries');
    expect(decryptValue(enc, wrongKey, 24, '.a.com')).toBeNull();
  });

  it('readChromiumCookies reads a copy, filters by domain, counts expired and undecryptable, removes the temp copy', async () => {
    for (const metaVersion of [23, 24]) {
      h.opened.length = 0;
      const dir = makeTmp();
      const original = path.join(dir, 'Cookies');
      buildCookiesDb(original, metaVersion);
      fs.writeFileSync(`${original}-journal`, '');
      const before = fs.readFileSync(original);

      const all = await readChromiumCookies(original, deriveKey(PASSWORD), null);
      expect(all.cookies.map((c) => c.name).toSorted()).toEqual(['__Host-pref', '__Secure-bad', 'cart', 'o', 'sid']);
      expect(all.cookies.find((c) => c.name === 'sid')?.value).toBe(SECRET_VALUES[0]);
      expect(all.skipped).toEqual({ expired: 1, undecryptable: 2, partitioned: metaVersion >= 24 ? 1 : 0 });

      const filtered = await readChromiumCookies(original, deriveKey(PASSWORD), ['other.org']);
      expect(filtered.cookies.map((c) => c.name)).toEqual(['o']);

      // Only a readonly copy was opened, never the original, and every copy is gone.
      expect(h.opened).toHaveLength(2);
      for (const { file, readonly } of h.opened) {
        expect(readonly).toBe(true);
        expect(path.resolve(file)).not.toBe(path.resolve(original));
        expect(fs.existsSync(path.dirname(file))).toBe(false);
      }
      expect(fs.readFileSync(original).equals(before)).toBe(true);
    }
  });

  it('readChromiumCookies includes rows a running browser has only in Cookies-wal', async () => {
    const dir = makeTmp();
    const original = path.join(dir, 'Cookies');
    const writer = buildCookiesDb(original, 24, { wal: true });
    try {
      expect(fs.statSync(`${original}-wal`).size).toBeGreaterThan(0);
      const read = await readChromiumCookies(original, deriveKey(PASSWORD), null);
      expect(read.cookies.map((c) => c.name).toSorted()).toEqual(['__Host-pref', '__Secure-bad', 'cart', 'o', 'sid']);
      expect(read.skipped).toEqual({ expired: 1, undecryptable: 2, partitioned: 1 });
    } finally {
      writer.close();
    }
  });

  it('readChromiumCookies removes the temp copy when the read fails', async () => {
    const dir = makeTmp();
    const original = path.join(dir, 'Cookies');
    fs.writeFileSync(original, 'not a database');
    await expect(readChromiumCookies(original, deriveKey(PASSWORD), null)).rejects.toThrow();
    expect(h.opened).toHaveLength(1);
    expect(fs.existsSync(path.dirname(h.opened[0].file))).toBe(false);
  });
});

describe('detectBrowserSources', () => {
  it('finds the known browsers under a home dir and names profiles from Local State', async () => {
    const home = makeHome();
    const support = path.join(home, 'Library', 'Application Support');
    expect(await detectBrowserSources(home)).toEqual([
      {
        browser: 'chrome',
        profileDir: 'Default',
        profileName: 'Person 1',
        cookiesPath: path.join(support, 'Google', 'Chrome', 'Default', 'Cookies'),
      },
      {
        browser: 'chrome',
        profileDir: 'Profile 1',
        profileName: 'Work',
        cookiesPath: path.join(support, 'Google', 'Chrome', 'Profile 1', 'Network', 'Cookies'),
      },
      {
        browser: 'brave',
        profileDir: 'Default',
        profileName: 'Me',
        cookiesPath: path.join(support, 'BraveSoftware', 'Brave-Browser', 'Default', 'Cookies'),
      },
    ]);
    expect(await detectBrowserSources(makeTmp())).toEqual([]);
  });
});

describe('importCookies', () => {
  const chromeDefault = async (home: string) => (await detectBrowserSources(home))[0];

  it('importCookies sets cookies with domain, path, secure, httpOnly, sameSite and expiry into the target partition only', async () => {
    const exec = fakeSecurity();
    const result = await importCookies(await chromeDefault(makeHome()), { kind: 'personal' }, null, exec);

    expect(exec).toHaveBeenCalledWith('/usr/bin/security', [
      'find-generic-password',
      '-w',
      '-s',
      'Chrome Safe Storage',
    ]);
    // Rejected: the non-secure __Secure- cookie and the partitioned one.
    expect(result).toEqual({
      ok: true,
      imported: 4,
      sites: 4,
      skipped: { expired: 1, undecryptable: 2, rejected: 2 },
    });
    expect([...h.sessions.keys()]).toEqual([BROWSER_SESSION_PARTITION]);
    const calls = setCallsOf(BROWSER_SESSION_PARTITION);
    const byName = (name: string) => calls.find((c) => c.name === name);
    expect(byName('sid')).toEqual({
      url: 'https://example.com/',
      name: 'sid',
      value: SECRET_VALUES[0],
      domain: '.example.com',
      path: '/',
      secure: true,
      httpOnly: true,
      sameSite: 'lax',
      expirationDate: NOW_S + 86400,
    });
    // Host-only: a url and no domain.
    expect(byName('__Host-pref')).toEqual({
      url: 'https://app.example.com/',
      name: '__Host-pref',
      value: SECRET_VALUES[1],
      path: '/',
      secure: true,
      httpOnly: false,
      sameSite: 'strict',
      expirationDate: NOW_S + 3600,
    });
    // A session cookie stays one.
    expect(byName('cart')).not.toHaveProperty('expirationDate');
    expect(byName('cart')?.sameSite).toBe('no_restriction');
    expect(byName('o')?.sameSite).toBe('unspecified');
    expect(byName('__Secure-bad')).toBeUndefined();
    expect(byName('chips')).toBeUndefined();
  });

  it('counts a cookie Electron refuses as rejected', async () => {
    const exec = fakeSecurity();
    const source = await chromeDefault(makeHome());
    await importCookies(source, { kind: 'personal' }, ['other.org'], exec);
    h.sessions.get(BROWSER_SESSION_PARTITION)?.cookies.set.mockRejectedValue(new Error('Failed to set cookie'));
    const result = await importCookies(source, { kind: 'personal' }, ['other.org'], exec);
    expect(result).toEqual({ ok: true, imported: 0, sites: 0, skipped: { expired: 0, undecryptable: 0, rejected: 1 } });
  });

  it('importCookies into an Agent profile leaves Personal untouched', async () => {
    const result = await importCookies(
      await chromeDefault(makeHome(23)),
      { kind: 'agent', agentId: AGENT_ID },
      ['example.com'],
      fakeSecurity()
    );
    expect(result).toMatchObject({ ok: true, imported: 3 });
    expect([...h.sessions.keys()]).toEqual([agentPartition(AGENT_ID)]);
    expect(
      setCallsOf(agentPartition(AGENT_ID))
        .map((c) => c.name)
        .toSorted()
    ).toEqual(['__Host-pref', 'cart', 'sid']);
    expect(setCallsOf(BROWSER_SESSION_PARTITION)).toEqual([]);
  });

  it('Keychain denial returns a clear "access to <Browser> Safe Storage was denied" result and imports nothing', async () => {
    const source = (await detectBrowserSources(makeHome())).find((s) => s.browser === 'brave');
    if (!source) throw new Error('fixture missing Brave');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failing = (error: object) => vi.fn(() => Promise.reject(Object.assign(new Error('security: failed'), error)));
    const cases: Array<[object, string]> = [
      [{ code: 51 }, 'keychain_denied'],
      [{ code: 128 }, 'keychain_denied'],
      [{ code: 44 }, 'keychain_missing'],
      [{ killed: true, signal: 'SIGTERM', code: null }, 'keychain_timeout'],
    ];
    for (const [error, code] of cases) {
      expect(await importCookies(source, { kind: 'personal' }, null, failing(error))).toEqual({
        ok: false,
        code,
        browser: 'brave',
      });
    }
    expect(h.sessions.size).toBe(0);
    expect(h.opened).toEqual([]);
    expect(SAFE_STORAGE).toEqual({
      chrome: 'Chrome Safe Storage',
      brave: 'Brave Safe Storage',
      edge: 'Microsoft Edge Safe Storage',
      arc: 'Arc Safe Storage',
      vivaldi: 'Vivaldi Safe Storage',
    });
  });
});

describe('one import at a time', () => {
  it('refuses a second import while the first waits on the Keychain', async () => {
    const source = (await detectBrowserSources(makeHome()))[0];
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    let settle: ((error: Error) => void) | undefined;
    // The first import's Keychain prompt never answers until the test ends it.
    const hanging = vi.fn(
      () =>
        new Promise<{ stdout: string }>((_resolve, reject) => {
          settle = reject;
        })
    );
    const first = importCookies(source, { kind: 'personal' }, null, hanging);
    expect(await importCookies(source, { kind: 'personal' }, null, fakeSecurity())).toEqual({
      ok: false,
      code: 'busy',
      browser: 'chrome',
    });
    settle?.(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }));
    expect(await first).toEqual({ ok: false, code: 'keychain_timeout', browser: 'chrome' });
    // Once it is over, the next import runs.
    expect(await importCookies(source, { kind: 'personal' }, null, fakeSecurity())).toMatchObject({ ok: true });
  });
});

describe('cookie import IPC', () => {
  beforeEach(() => {
    h.home.fail = false;
    h.providers.clear();
    registerBrowserProfileIpc();
  });

  it('cookie values never appear in the IPC result or in logs', async () => {
    h.home.dir = makeHome();
    const logs = (['log', 'info', 'warn', 'error', 'debug'] as const).map((level) =>
      vi.spyOn(console, level).mockImplementation(() => {})
    );

    const sources = await h.providers.get('listSources')?.();
    expect(sources).toEqual({
      success: true,
      data: [
        { browser: 'chrome', profileDir: 'Default', profileName: 'Person 1' },
        { browser: 'chrome', profileDir: 'Profile 1', profileName: 'Work' },
        { browser: 'brave', profileDir: 'Default', profileName: 'Me' },
      ],
    });

    const run = h.providers.get('run');
    const result = await run?.({
      browser: 'chrome',
      profileDir: 'Default',
      target: { kind: 'personal' },
      domains: null,
    });
    expect(h.execFile).toHaveBeenCalledWith(
      '/usr/bin/security',
      ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'],
      { encoding: 'utf8', timeout: 120_000 },
      expect.any(Function)
    );
    expect(result).toEqual({
      success: true,
      data: { ok: true, imported: 4, sites: 4, skipped: { expired: 1, undecryptable: 2, rejected: 2 } },
    });
    // A failing import logs too: still no values.
    h.sessions.get(BROWSER_SESSION_PARTITION)?.cookies.set.mockRejectedValue(new Error('Failed to set cookie'));
    await run?.({ browser: 'chrome', profileDir: 'Default', target: { kind: 'personal' }, domains: null });

    const logged = JSON.stringify(logs.flatMap((spy) => spy.mock.calls));
    const replied = JSON.stringify([sources, result]);
    for (const secret of [...SECRET_VALUES, 'chips-secret-6', PASSWORD]) {
      expect(logged).not.toContain(secret);
      expect(replied).not.toContain(secret);
    }
  });

  it('refuses malformed requests and unknown source profiles without touching the Keychain', async () => {
    h.home.dir = makeHome();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const run = h.providers.get('run');
    const good = { browser: 'chrome', profileDir: 'Default', target: { kind: 'personal' }, domains: null };
    for (const bad of [
      null,
      { ...good, browser: 'safari' },
      { ...good, target: { kind: 'agent', agentId: '../x' } },
      { ...good, domains: ['not a domain'] },
      { ...good, domains: 'example.com' },
      { ...good, cookiesPath: '/etc/passwd' },
    ]) {
      expect(await run?.(bad)).toMatchObject({ success: false });
    }
    expect(await run?.({ ...good, profileDir: '../../Brave' })).toEqual({
      success: true,
      data: { ok: false, code: 'source_not_found', browser: 'chrome' },
    });
    expect(h.execFile).not.toHaveBeenCalled();
    expect(h.sessions.size).toBe(0);
  });

  it('failures reach the renderer as codes only: no path, no English text from main', async () => {
    h.home.dir = makeHome();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Brave's cookie DB is unreadable; Chrome's Keychain item is missing.
    fs.writeFileSync(
      path.join(h.home.dir, 'Library', 'Application Support', 'BraveSoftware', 'Brave-Browser', 'Default', 'Cookies'),
      'garbage'
    );
    const run = h.providers.get('run');
    const replies = [
      await run?.({ browser: 'brave', profileDir: 'Default', target: { kind: 'personal' }, domains: null }),
    ];
    h.execFile.mockImplementationOnce((_file, _args, _options, callback) =>
      callback(Object.assign(new Error('security: SecKeychainSearchCopyNext: item not found'), { code: 44 }), '')
    );
    replies.push(
      await run?.({ browser: 'chrome', profileDir: 'Default', target: { kind: 'personal' }, domains: null })
    );
    h.home.fail = true;
    replies.push(await h.providers.get('listSources')?.());
    replies.push(
      await run?.({ browser: 'chrome', profileDir: 'Default', target: { kind: 'personal' }, domains: null })
    );

    expect(replies).toEqual([
      { success: true, data: { ok: false, code: 'read_failed', browser: 'brave' } },
      { success: true, data: { ok: false, code: 'keychain_missing', browser: 'chrome' } },
      { success: false },
      { success: true, data: { ok: false, code: 'read_failed', browser: 'chrome' } },
    ]);
    const replied = JSON.stringify(replies);
    expect(replied).not.toContain(h.home.dir);
    expect(replied).not.toMatch(/msg|[A-Z][a-z]+ [a-z]+/);
    // The detail stays in main's log.
    expect(errors.mock.calls.flat().map(String).join('\n')).toContain('EACCES');
  });

  it('no relay or MCP route reaches the import: only the renderer IPC imports it', () => {
    const processDir = path.resolve(__dirname, '../../../../../../packages/desktop/src/process');
    const importers: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.tsx?$/.test(entry.name) && !file.includes(`${path.sep}cookieImport${path.sep}`)) {
          if (/cookieImport\/importCookies|\bimportCookies\b|cookieImport\.run/.test(fs.readFileSync(file, 'utf8'))) {
            importers.push(path.relative(processDir, file));
          }
        }
      }
    };
    walk(processDir);
    expect(importers).toEqual([path.join('services', 'browserSession', 'profiles', 'profileIpc.ts')]);
  });

  it('the raw run channel appears only where the bridge defines it, and only the IPC and the modal use it', () => {
    const packagesDir = path.resolve(__dirname, '../../../../../../packages');
    const withChannel: string[] = [];
    const withRun: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (['node_modules', 'dist', 'out', 'build', '.vite'].includes(entry.name)) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(file);
        else if (/\.(?:[cm]?[jt]sx?)$/.test(entry.name)) {
          const text = fs.readFileSync(file, 'utf8');
          if (text.includes('browser.cookie-import.run')) withChannel.push(path.relative(packagesDir, file));
          if (/cookieImport\.run\b/.test(text)) withRun.push(path.relative(packagesDir, file));
        }
      }
    };
    walk(packagesDir);
    const desktop = (...parts: string[]) => path.join('desktop', 'src', ...parts);
    expect(withChannel).toEqual([desktop('common', 'adapter', 'ipcBridge.ts')]);
    expect(withRun.toSorted()).toEqual(
      [
        desktop('process', 'services', 'browserSession', 'profiles', 'profileIpc.ts'),
        desktop('renderer', 'pages', 'conversation', 'Preview', 'browser', 'BrowserProfiles', 'CookieImportModal.tsx'),
      ].toSorted()
    );
  });
});
