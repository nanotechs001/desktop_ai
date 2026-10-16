/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// `AionUi[\w-]*` also covers the dev-mode app names (`AionUi-Dev`, `AionUi-Dev-2`).
const APP_TOKENS = /\s*\b(?:AionUi[\w-]*|Electron)\/\S+/gi;
const CHROMIUM_BRAND = /"Chromium";v="([^"]+)"/;
const GOOGLE_CHROME_BRAND = '"Google Chrome"';

/**
 * Turns Electron's default user agent into the one plain Chrome would send, by
 * removing the `AionUi/<ver>` and `Electron/<ver>` tokens. Google rejects sign-in
 * from user agents that carry an Electron token.
 */
export function toChromeUserAgent(electronUa: string): string {
  return electronUa
    .replace(APP_TOKENS, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/**
 * Adds a `"Google Chrome"` brand (same version as `"Chromium"`) to a `sec-ch-ua` or
 * `sec-ch-ua-full-version-list` header value. Returns the value unchanged when the
 * brand is already there or there is no Chromium brand to copy the version from.
 */
export function rewriteChromeBrands(headerValue: string): string {
  if (headerValue.includes(GOOGLE_CHROME_BRAND)) return headerValue;
  const chromium = CHROMIUM_BRAND.exec(headerValue);
  if (!chromium) return headerValue;
  return `${headerValue}, ${GOOGLE_CHROME_BRAND};v="${chromium[1]}"`;
}

/** True for `google.com`, `*.google.com` and `*.googleusercontent.com`; false for anything unparsable. */
export function isGoogleHost(url: string): boolean {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return false;
  }
  return hostname === 'google.com' || hostname.endsWith('.google.com') || hostname.endsWith('.googleusercontent.com');
}
