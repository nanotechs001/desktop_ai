/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { returnPathOf } from '@/renderer/pages/login/returnPath';

describe('returnPathOf', () => {
  // A phone whose session ran out on a refresh lost the bot chat it had open: sign-in always went to /guid.
  it('returns to the chat the user had open', () => {
    expect(returnPathOf({ from: '/conversation/abc123' })).toBe('/conversation/abc123');
    expect(returnPathOf({ from: '/settings/agent?tab=accounts' })).toBe('/settings/agent?tab=accounts');
  });

  it('goes to the start page without a usable origin', () => {
    expect(returnPathOf(undefined)).toBe('/guid');
    expect(returnPathOf(null)).toBe('/guid');
    expect(returnPathOf({ from: 42 })).toBe('/guid');
    expect(returnPathOf({ from: 'https://evil.example/' })).toBe('/guid');
    expect(returnPathOf({ from: '//evil.example/x' })).toBe('/guid');
  });

  it('never returns to a sign-in page', () => {
    expect(returnPathOf({ from: '/login' })).toBe('/guid');
    expect(returnPathOf({ from: '/qr-login?token=x' })).toBe('/guid');
    expect(returnPathOf({ from: '/loginx' })).toBe('/loginx');
  });
});
