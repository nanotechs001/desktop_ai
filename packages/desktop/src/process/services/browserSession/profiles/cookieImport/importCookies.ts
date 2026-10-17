/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import type {
  BrowserTabProfile,
  CookieImportErrorCode,
  CookieImportOutcome,
  CookieSourceBrowser,
} from '@/common/types/browser';
import { ensureBrowserSession } from '../../browserSession';
import { partitionOfProfile } from '../browserProfiles';
import { deriveKey, readChromiumCookies, type ChromiumCookieRead, type ImportedCookie } from './chromiumCookies';
import type { BrowserSource } from './detect';

/*
 * Privacy (spec R7): cookie values and the Keychain password never leave this module except into
 * `session.cookies.set` on the chosen partition. Nothing here logs a value, and callers get counts or a code only.
 */

/** The Keychain item each browser keeps its cookie password in. */
export const SAFE_STORAGE: Record<CookieSourceBrowser, string> = {
  chrome: 'Chrome Safe Storage',
  brave: 'Brave Safe Storage',
  edge: 'Microsoft Edge Safe Storage',
  arc: 'Arc Safe Storage',
  vivaldi: 'Vivaldi Safe Storage',
};

const SECURITY_BIN = '/usr/bin/security';
/** How long the macOS Keychain prompt may wait for the user before the import gives up. */
const KEYCHAIN_TIMEOUT_MS = 120_000;
/** `security` exits with errSecItemNotFound's low byte when the browser has no Safe Storage item. */
const EXIT_ITEM_NOT_FOUND = 44;

/** Runs a program with arguments (never through a shell) and resolves with its stdout. */
export type ExecFile = (file: string, args: string[]) => Promise<{ stdout: string }>;

const runSecurity: ExecFile = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8', timeout: KEYCHAIN_TIMEOUT_MS }, (error, stdout) =>
      error ? reject(error) : resolve({ stdout })
    );
  });

const SAME_SITE: Record<number, Electron.CookiesSetDetails['sameSite']> = {
  [-1]: 'unspecified',
  0: 'no_restriction',
  1: 'lax',
  2: 'strict',
};

type KeychainCode = Extract<CookieImportErrorCode, `keychain_${string}`>;

/** Which Keychain failure a `security` error is: killed by the timeout, no such item, or refused. */
function keychainFailure(error: unknown): KeychainCode {
  const { code, killed } = (error ?? {}) as { code?: unknown; killed?: unknown };
  if (killed === true) return 'keychain_timeout';
  return code === EXIT_ITEM_NOT_FOUND ? 'keychain_missing' : 'keychain_denied';
}

/**
 * The browser's cookie password from the Keychain, or why there is none. macOS asks the user first; that prompt is
 * the consent step, and an unanswered one is given up after two minutes.
 */
async function safeStoragePassword(
  browser: CookieSourceBrowser,
  exec: ExecFile
): Promise<{ password: string } | { code: KeychainCode }> {
  const item = SAFE_STORAGE[browser];
  try {
    const password = (await exec(SECURITY_BIN, ['find-generic-password', '-w', '-s', item])).stdout.replace(
      /\r?\n$/,
      ''
    );
    if (password !== '') return { password };
    console.warn(`[CookieImport] ${item} is empty`);
    return { code: 'keychain_missing' };
  } catch (error) {
    const { code, signal } = (error ?? {}) as { code?: unknown; signal?: unknown };
    console.warn(`[CookieImport] could not read ${item}; exit code:`, code, 'signal:', signal);
    return { code: keychainFailure(error) };
  }
}

/**
 * What `session.cookies.set` gets for a cookie: host-only cookies by `url` alone, domain cookies with `domain`;
 * session cookies without an expiry. Null for a `__Host-`/`__Secure-` cookie that is not secure.
 */
function toSetDetails(cookie: ImportedCookie): Electron.CookiesSetDetails | null {
  if ((cookie.name.startsWith('__Host-') || cookie.name.startsWith('__Secure-')) && !cookie.secure) return null;
  const hostOnly = !cookie.hostKey.startsWith('.');
  const host = hostOnly ? cookie.hostKey : cookie.hostKey.slice(1);
  return {
    url: `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path}`,
    name: cookie.name,
    value: cookie.value,
    ...(hostOnly ? {} : { domain: cookie.hostKey }),
    path: cookie.path,
    secure: cookie.secure,
    httpOnly: cookie.httpOnly,
    sameSite: SAME_SITE[cookie.sameSite] ?? 'unspecified',
    ...(cookie.expires === null ? {} : { expirationDate: cookie.expires }),
  };
}

/** True while an import runs: a second one would stack another Keychain prompt, so it is refused. */
let importRunning = false;

async function runImport(
  source: BrowserSource,
  target: BrowserTabProfile,
  domains: string[] | null,
  exec: ExecFile
): Promise<CookieImportOutcome> {
  const fail = (code: CookieImportErrorCode): CookieImportOutcome => ({ ok: false, code, browser: source.browser });
  const partition = partitionOfProfile(target);
  const keychain = await safeStoragePassword(source.browser, exec);
  if ('code' in keychain) return fail(keychain.code);
  const key = deriveKey(keychain.password);
  let read: ChromiumCookieRead;
  try {
    read = await readChromiumCookies(source.cookiesPath, key, domains);
  } catch (error) {
    // Detail (paths, SQLite text) for the log only; the renderer gets the code.
    console.error(`[CookieImport] could not read the ${source.browser} cookie DB:`, error);
    return fail('read_failed');
  } finally {
    key.fill(0);
  }

  const { cookies } = ensureBrowserSession(partition);
  const outcomes = await Promise.all(
    read.cookies.map(async (cookie): Promise<string | null> => {
      const details = toSetDetails(cookie);
      if (details === null) return null;
      try {
        await cookies.set(details);
        return cookie.hostKey.replace(/^\./, '');
      } catch {
        // Electron's reason can echo the cookie; it is counted, never logged.
        return null;
      }
    })
  );
  const sites = outcomes.filter((site): site is string => site !== null);
  const rejected = outcomes.length - sites.length + read.skipped.partitioned;
  if (rejected > 0) console.warn(`[CookieImport] ${rejected} cookie(s) were rejected`);
  return {
    ok: true,
    imported: sites.length,
    sites: new Set(sites).size,
    skipped: { expired: read.skipped.expired, undecryptable: read.skipped.undecryptable, rejected },
  };
}

/**
 * Imports a browser profile's cookies into `target`'s partition and nothing else, one import at a time (`busy`
 * otherwise). Reads the Keychain password (derived per import, never kept), reads a copy of the source DB, and sets
 * each cookie. `domains` null means every site. A Keychain failure returns its code before anything is read.
 * Partitioned (CHIPS) cookies count as rejected.
 */
export async function importCookies(
  source: BrowserSource,
  target: BrowserTabProfile,
  domains: string[] | null,
  exec: ExecFile = runSecurity
): Promise<CookieImportOutcome> {
  if (importRunning) return { ok: false, code: 'busy', browser: source.browser };
  importRunning = true;
  try {
    return await runImport(source, target, domains, exec);
  } finally {
    importRunning = false;
  }
}
