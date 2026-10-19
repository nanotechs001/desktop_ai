/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

const UA_PLATFORM = /^Mozilla\/5\.0 \(([^)]+)\)/;
const CHROME_MAJOR = /\bChrome\/(\d+)\./;
const CHROMIUM_BRAND = /"Chromium";v="([^"]+)"/;
const GOOGLE_CHROME_BRAND = '"Google Chrome"';

/**
 * Rebuilds Electron's default user agent as the one plain Chrome sends, keeping only
 * the platform and the Chrome major version (in Chrome's reduced `<major>.0.0.0` form).
 * Every other `Name/ver` token (the app name, whatever it is, and `Electron/<ver>`) is
 * dropped, because Google rejects sign-in from user agents that carry one.
 */
export function toChromeUserAgent(electronUa: string): string {
  const platform = UA_PLATFORM.exec(electronUa)?.[1];
  const major = CHROME_MAJOR.exec(electronUa)?.[1];
  if (!platform || !major) return electronUa;
  return `Mozilla/5.0 (${platform}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
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
