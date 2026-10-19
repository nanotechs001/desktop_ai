/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { toBrowserUserAgent } from '@process/services/browserSession/userAgent';

const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36';

describe('toBrowserUserAgent', () => {
  it('drops the app-name token and keeps Chrome and Electron', () => {
    expect(
      toBrowserUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) PixebotBrowser/37.10.3 Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36'
      )
    ).toBe(BROWSER_UA);
  });

  it('drops dev and legacy app names too', () => {
    for (const name of ['PixebotBrowser-Dev/2.2.2', 'AionUi-Dev-2/2.2.2', 'AionUi/2.2.2-beta.1']) {
      expect(
        toBrowserUserAgent(
          `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) ${name} Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36`
        )
      ).toBe(BROWSER_UA);
    }
  });

  it('keeps the Windows platform section', () => {
    expect(
      toBrowserUserAgent(
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) PixebotBrowser/37.10.3 Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36'
      )
    ).toBe(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.251 Electron/37.10.3 Safari/537.36'
    );
  });

  it('leaves a user agent without an app name unchanged', () => {
    expect(toBrowserUserAgent(BROWSER_UA)).toBe(BROWSER_UA);
  });
});
