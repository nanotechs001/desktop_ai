/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import type { CookieImportSource, CookieSourceBrowser } from '@/common/types/browser';

/** A browser profile cookies can be imported from; `cookiesPath` never leaves main. */
export type BrowserSource = CookieImportSource & { cookiesPath: string };

/** Each browser's data folder under `~/Library/Application Support`, in the order the user sees them. */
const BROWSER_DIRS: ReadonlyArray<readonly [CookieSourceBrowser, string]> = [
  ['chrome', path.join('Google', 'Chrome')],
  ['brave', path.join('BraveSoftware', 'Brave-Browser')],
  ['edge', 'Microsoft Edge'],
  ['arc', path.join('Arc', 'User Data')],
  ['vivaldi', 'Vivaldi'],
];

/** Newer Chromium keeps the cookie DB under `Network/`; older versions next to the profile's other files. */
const COOKIE_FILES = [path.join('Network', 'Cookies'), 'Cookies'];

/** A profile folder name from `Local State` that stays inside the browser's folder. */
const isProfileDirName = (name: string): boolean =>
  name !== '' && name !== '.' && name !== '..' && path.basename(name) === name;

const exists = (file: string): Promise<boolean> =>
  fs.stat(file).then(
    (stat) => stat.isFile(),
    () => false
  );

/** The profiles a browser lists in its `Local State` (`profile.info_cache`); none when it is missing or unreadable. */
async function listedProfiles(root: string): Promise<Array<{ dir: string; name: string }>> {
  let cache: unknown;
  try {
    const state = JSON.parse(await fs.readFile(path.join(root, 'Local State'), 'utf8')) as {
      profile?: { info_cache?: unknown };
    };
    cache = state.profile?.info_cache;
  } catch {
    return [];
  }
  if (typeof cache !== 'object' || cache === null) return [];
  return Object.entries(cache as Record<string, unknown>)
    .filter(([dir]) => isProfileDirName(dir))
    .map(([dir, info]) => {
      const name = (info as { name?: unknown } | null)?.name;
      return { dir, name: typeof name === 'string' && name !== '' ? name : dir };
    });
}

/**
 * The Chromium browser profiles under `home` whose cookie DB exists: Chrome, Brave, Edge, Arc and Vivaldi at their
 * macOS paths, each profile named from the browser's `Local State`. Reads nothing but `Local State` and file stats.
 */
export async function detectBrowserSources(home: string): Promise<BrowserSource[]> {
  const support = path.join(home, 'Library', 'Application Support');
  const perBrowser = await Promise.all(
    BROWSER_DIRS.map(async ([browser, dir]) => {
      const root = path.join(support, dir);
      const profiles = await listedProfiles(root);
      const sources = await Promise.all(
        profiles.map(async ({ dir: profileDir, name }): Promise<BrowserSource | null> => {
          for (const file of COOKIE_FILES) {
            const cookiesPath = path.join(root, profileDir, file);
            if (await exists(cookiesPath)) return { browser, profileDir, profileName: name, cookiesPath };
          }
          return null;
        })
      );
      return sources.filter((source): source is BrowserSource => source !== null);
    })
  );
  return perBrowser.flat();
}
