/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * html/body/#root never scroll (index.html), so on a short phone screen (e.g. a Fold cover screen, or with the
 * keyboard open) the login page must scroll itself, and centering must not push the card's top or bottom off-screen.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(
  path.resolve(__dirname, '../../../../packages/desktop/src/renderer/pages/login/LoginPage.css'),
  'utf8'
);
const rule = (selector: string) =>
  css.match(new RegExp(`(^|\\n)${selector.replace(/[.]/g, '\\.')}\\s*{[^}]*}`))?.[0] ?? '';

describe('login page on a short screen', () => {
  it('is its own scroll container that fills the root', () => {
    const page = rule('.login-page');
    expect(page).toMatch(/overflow-y:\s*auto/);
    expect(page).not.toMatch(/overflow:\s*hidden/);
    expect(page).toMatch(/(^|[^-])height:\s*100%/);
  });

  it('centers the card with auto margins, so an overflowing card stays reachable', () => {
    expect(rule('.login-page')).not.toMatch(/align-items:\s*center/);
    expect(rule('.login-page__card')).toMatch(/margin-block:\s*auto/);
  });
});
