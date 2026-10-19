/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/** A `Name/version` product token; tokens inside the parenthesised platform section have no slash. */
const PRODUCT_TOKEN = /^[^\s/()]+\/\S+$/;
/** The product tokens Chromium's own user agent carries. */
const KEPT_PRODUCT = /^(?:Mozilla|AppleWebKit|Chrome|Electron|Safari)\//;

/**
 * Electron's default user agent minus the app-name token (`PixebotBrowser/<ver>`, `AionUi-Dev/<ver>`, …).
 * The `Electron/<ver>` token stays on purpose: with it Google serves its embedded-browser sign-in, which
 * Electron passes, while a user agent posing as desktop Chrome gets Google's full Chrome checks and
 * "Couldn't sign you in — this browser or app may not be secure".
 */
export function toBrowserUserAgent(electronUa: string): string {
  return electronUa
    .split(' ')
    .filter((token) => !PRODUCT_TOKEN.test(token) || KEPT_PRODUCT.test(token))
    .join(' ');
}
