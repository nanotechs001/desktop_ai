/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { isGoogleHost, rewriteChromeBrands, toChromeUserAgent } from '@process/services/browserSession/userAgent';

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.243 Safari/537.36';

describe('toChromeUserAgent', () => {
  it('strips AionUi and Electron tokens', () => {
    expect(
      toChromeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AionUi/2.2.2 Chrome/138.0.7204.243 Electron/37.10.3 Safari/537.36'
      )
    ).toBe(CHROME_UA);
  });

  it('strips the dev-mode AionUi-Dev token', () => {
    expect(
      toChromeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AionUi-Dev-2/2.2.2 Chrome/138.0.7204.243 Electron/37.10.3 Safari/537.36'
      )
    ).toBe(CHROME_UA);
  });

  it('matches the tokens case-insensitively', () => {
    expect(
      toChromeUserAgent(
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) aionui/2.2.2 Chrome/138.0.7204.243 ELECTRON/37.10.3 Safari/537.36'
      )
    ).toBe(CHROME_UA);
  });

  it('leaves a plain Chrome UA unchanged', () => {
    expect(toChromeUserAgent(CHROME_UA)).toBe(CHROME_UA);
  });
});

describe('rewriteChromeBrands', () => {
  it('adds "Google Chrome" with the Chromium version', () => {
    expect(rewriteChromeBrands('"Chromium";v="138", "Not)A;Brand";v="8"')).toBe(
      '"Chromium";v="138", "Not)A;Brand";v="8", "Google Chrome";v="138"'
    );
  });

  it('copies the full version for sec-ch-ua-full-version-list', () => {
    expect(rewriteChromeBrands('"Chromium";v="138.0.7204.243", "Not)A;Brand";v="8.0.0.0"')).toBe(
      '"Chromium";v="138.0.7204.243", "Not)A;Brand";v="8.0.0.0", "Google Chrome";v="138.0.7204.243"'
    );
  });

  it('is a no-op when "Google Chrome" is already present', () => {
    const value = '"Chromium";v="138", "Google Chrome";v="138", "Not)A;Brand";v="8"';
    expect(rewriteChromeBrands(value)).toBe(value);
  });

  it('is a no-op when the Chromium brand is absent', () => {
    expect(rewriteChromeBrands('"Not)A;Brand";v="8"')).toBe('"Not)A;Brand";v="8"');
    expect(rewriteChromeBrands('')).toBe('');
  });
});

describe('isGoogleHost', () => {
  it.each([
    'https://accounts.google.com/signin',
    'https://google.com/',
    'https://lh3.googleusercontent.com/a/photo.png',
    'https://ACCOUNTS.GOOGLE.COM:8443/x',
  ])('is true for %s', (url) => {
    expect(isGoogleHost(url)).toBe(true);
  });

  it.each([
    'https://evilgoogle.com/',
    'https://google.com.evil.io/',
    'https://notgoogleusercontent.com/',
    'https://example.com/?next=accounts.google.com',
    'not a url',
    '',
  ])('is false for %s', (url) => {
    expect(isGoogleHost(url)).toBe(false);
  });
});
