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

/**
 * {@link toBrowserUserAgent} without the `Electron/<ver>` token too: plain desktop Chrome. Sites that branch on
 * Electron otherwise break; Firebase Auth's web SDK, for one, never yields an ID token, so GHL white-label apps send an
 * empty `token-id` and loop on 401.
 */
export function toChromeUserAgent(electronUa: string): string {
  return toBrowserUserAgent(electronUa)
    .split(' ')
    .filter((token) => !/^Electron\//.test(token))
    .join(' ');
}

/** Google's own sites, where its sign-in must see the Electron token (see {@link toBrowserUserAgent}). */
const ELECTRON_TOKEN_SITES = ['google.com', 'youtube.com'];

/** Whether pages and requests at `url` keep the Electron token: Google's and YouTube's own hosts only. */
export function keepsElectronToken(url: string): boolean {
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return ELECTRON_TOKEN_SITES.some((site) => host === site || host.endsWith(`.${site}`));
}

/** The user agent for a page or request at `url`: Electron's for Google, plain Chrome everywhere else. */
export function userAgentFor(url: string, electronUa: string): string {
  return keepsElectronToken(url) ? toBrowserUserAgent(electronUa) : toChromeUserAgent(electronUa);
}

/**
 * Keeps a browser tab's user agent right for the site it is going to: set before each main-frame load (a link, a
 * redirect, a typed or scripted load), so the request and the page's `navigator.userAgent` agree. The session keeps
 * the Electron-token default; only tabs on other sites switch to plain Chrome.
 */
export function installSiteUserAgent(contents: Electron.WebContents, electronUa: string): void {
  let current = '';
  const follow = (url: string) => {
    const next = userAgentFor(url, electronUa);
    if (next === current) return;
    current = next;
    contents.setUserAgent(next);
  };
  contents.on('will-navigate', (_event, url) => follow(url));
  contents.on('will-redirect', (details) => {
    if (details.isMainFrame) follow(details.url);
  });
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument) follow(details.url);
  });
}
