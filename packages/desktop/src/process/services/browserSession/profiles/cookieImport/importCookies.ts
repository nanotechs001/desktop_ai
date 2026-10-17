/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFile } from 'node:child_process';
import type { BrowserTabProfile, CookieImportResult, CookieSourceBrowser } from '@/common/types/browser';
import { ensureBrowserSession } from '../../browserSession';
import { partitionOfProfile } from '../browserProfiles';
import { deriveKey, readChromiumCookies, type ImportedCookie } from './chromiumCookies';
import type { BrowserSource } from './detect';

/*
 * Privacy (spec R7): cookie values and the Keychain password never leave this module except into
 * `session.cookies.set` on the chosen partition. Nothing here logs a value, and callers get counts only.
 */

/** The Keychain item each browser keeps its cookie password in. */
export const SAFE_STORAGE: Record<CookieSourceBrowser, string> = {
  chrome: 'Chrome Safe Storage',
  brave: 'Brave Safe Storage',
  edge: 'Microsoft Edge Safe Storage',
  arc: 'Arc Safe Storage',
  vivaldi: 'Vivaldi Safe Storage',
};

/** Runs a program with arguments (never through a shell) and resolves with its stdout. */
export type ExecFile = (file: string, args: string[]) => Promise<{ stdout: string }>;

const runProgram: ExecFile = (file, args) =>
  new Promise((resolve, reject) => {
    execFile(file, args, { encoding: 'utf8' }, (error, stdout) => (error ? reject(error) : resolve({ stdout })));
  });

const SAME_SITE: Record<number, Electron.CookiesSetDetails['sameSite']> = {
  [-1]: 'unspecified',
  0: 'no_restriction',
  1: 'lax',
  2: 'strict',
};

/**
 * The browser's cookie password from the Keychain. macOS asks the user first; that prompt is the consent step.
 * Any failure (item missing, exit 44/51, the user denying it) means no access.
 */
async function safeStoragePassword(browser: CookieSourceBrowser, exec: ExecFile): Promise<string> {
  const item = SAFE_STORAGE[browser];
  try {
    const password = (await exec('security', ['find-generic-password', '-w', '-s', item])).stdout.replace(/\r?\n$/, '');
    if (password !== '') return password;
    console.warn(`[CookieImport] ${item} is empty`);
  } catch (error) {
    console.warn(`[CookieImport] could not read ${item}; exit code:`, (error as { code?: unknown }).code);
  }
  throw new Error(`Access to ${item} was denied`);
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

/**
 * Imports a browser profile's cookies into `target`'s partition and nothing else. Reads the Keychain password
 * (derived per import, never kept), reads a copy of the source DB, and sets each cookie. `domains` null means every
 * site. Throws "Access to <Browser> Safe Storage was denied" when the Keychain refuses, before reading anything.
 */
export async function importCookies(
  source: BrowserSource,
  target: BrowserTabProfile,
  domains: string[] | null,
  exec: ExecFile = runProgram
): Promise<CookieImportResult> {
  const partition = partitionOfProfile(target);
  const key = deriveKey(await safeStoragePassword(source.browser, exec));
  let read: Awaited<ReturnType<typeof readChromiumCookies>>;
  try {
    read = await readChromiumCookies(source.cookiesPath, key, domains);
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
  const rejected = outcomes.length - sites.length;
  if (rejected > 0) console.warn(`[CookieImport] ${rejected} cookie(s) were rejected`);
  return { imported: sites.length, sites: new Set(sites).size, skipped: { ...read.skipped, rejected } };
}
