/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * This fork never sends crash, error, log or diagnostics data to a remote
 * service. This guard fails when Sentry or the startup log report comes back
 * anywhere under packages/.
 */

import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';

const packagesRoot = path.resolve(__dirname, '../../../packages');
const SKIPPED_DIRS = new Set(['node_modules', 'out', 'dist', 'dist-server']);
const SCANNED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.cjs', '.json']);

const FORBIDDEN: ReadonlyArray<readonly [string, RegExp]> = [
  ['a @sentry/ import', /@sentry\//],
  ['a Sentry. call', /\bSentry\./],
  ['startupLogReport', /startupLogReport/i],
];

const listSourceFiles = (dir: string): string[] =>
  fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (SKIPPED_DIRS.has(entry.name)) return [];
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return listSourceFiles(full);
    return SCANNED_EXTENSIONS.has(path.extname(entry.name)) ? [full] : [];
  });

describe('no remote error reporting under packages/', () => {
  const files = listSourceFiles(packagesRoot);

  it('scans a realistic number of files', () => {
    expect(files.length).toBeGreaterThan(100);
  });

  it.each(FORBIDDEN)('contains no %s', (_label, pattern) => {
    const offenders = files.filter((file) => pattern.test(fs.readFileSync(file, 'utf-8')));
    expect(offenders.map((file) => path.relative(packagesRoot, file))).toEqual([]);
  });

  it('keeps the sentry source module deleted', () => {
    expect(fs.existsSync(path.join(packagesRoot, 'desktop/src/sentry.ts'))).toBe(false);
  });
});
