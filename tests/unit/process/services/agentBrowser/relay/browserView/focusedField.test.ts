/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { textFieldFocused } from '@process/services/agentBrowser/relay/browserView/focusedField';

const frame = (answer: () => Promise<unknown>) => ({ executeJavaScript: answer });

describe('textFieldFocused', () => {
  it('is true when any frame reports a focused text field', async () => {
    expect(await textFieldFocused([frame(async () => false), frame(async () => true)])).toBe(true);
  });

  it('is false with no frames, no field, or a frame whose script fails or answers oddly', async () => {
    expect(await textFieldFocused([])).toBe(false);
    expect(
      await textFieldFocused([
        frame(async () => false),
        frame(() => Promise.reject(new Error('frame gone'))),
        frame(async () => 'yes'),
      ])
    ).toBe(false);
  });
});
