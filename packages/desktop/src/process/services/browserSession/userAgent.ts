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
    .filter((token) => !token.startsWith('Electron/'))
    .join(' ');
}

/** Google's own sites, where its sign-in must see the Electron token (see {@link toBrowserUserAgent}). */
const ELECTRON_TOKEN_SITES = ['google.com', 'youtube.com'];

/**
 * Hosts Cloudflare challenged under the plain-Chrome agent. Its bot check sees the browser is not the Chrome the
 * agent claims and keeps answering "Just a moment..." (clicking "Verify you are human" loops); Electron's own agent
 * passes. Kept for this run: a host's first challenge after a restart switches it again.
 */
const challengedHosts = new Set<string>();

const hostOf = (url: string): string | null => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return null;
  }
};

/** Whether pages and requests at `url` keep the Electron token: Google's and YouTube's hosts, and challenged ones. */
export function keepsElectronToken(url: string): boolean {
  const host = hostOf(url);
  if (host === null) return false;
  return challengedHosts.has(host) || ELECTRON_TOKEN_SITES.some((site) => host === site || host.endsWith(`.${site}`));
}

/** Cloudflare marks its challenge page with `cf-mitigated: challenge` (any header case). */
const isCloudflareChallenge = (headers: Record<string, string[]> | undefined): boolean =>
  Object.entries(headers ?? {}).some(
    ([name, values]) => name.toLowerCase() === 'cf-mitigated' && values.some((v) => v.toLowerCase() === 'challenge')
  );

/**
 * When Cloudflare challenges a page load, its host gets Electron's own agent from then on and the tab loads it again
 * (once per host: a challenge that remains is the user's own check, not a loop). `reload` loads the url in the tab;
 * its browser-started load switches the tab's agent (see {@link installSiteUserAgent}).
 */
export function installChallengeFallback(
  session: Electron.Session,
  reload: (webContentsId: number, url: string) => void
): void {
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({});
    if (details.resourceType !== 'mainFrame' || !isCloudflareChallenge(details.responseHeaders)) return;
    const host = hostOf(details.url);
    if (host === null || challengedHosts.has(host) || keepsElectronToken(details.url)) return;
    challengedHosts.add(host);
    console.warn(`[BrowserSession] Cloudflare challenged ${host}; using the browser's own agent there`);
    if (details.webContentsId !== undefined) reload(details.webContentsId, details.url);
  });
}

/** The user agent for a page or request at `url`: Electron's for Google, plain Chrome everywhere else. */
export function userAgentFor(url: string, electronUa: string): string {
  return keepsElectronToken(url) ? toBrowserUserAgent(electronUa) : toChromeUserAgent(electronUa);
}

/**
 * Sends every page load (a tab's first, a redirect, a popup's) with the agent of the site it goes to, so the request
 * never carries the session default only to be switched afterwards: a site that ties its login to the agent
 * (WordPress on ViziPlatform) answered a fresh tab's first request with its login page. The page's other requests
 * keep the tab's agent, which {@link installSiteUserAgent} keeps matching the page.
 */
export function installRequestUserAgent(session: Electron.Session, electronUa: string): void {
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    if (details.resourceType !== 'mainFrame') return callback({ requestHeaders: details.requestHeaders });
    const requestHeaders = Object.fromEntries(
      Object.entries(details.requestHeaders).filter(([name]) => name.toLowerCase() !== 'user-agent')
    );
    requestHeaders['User-Agent'] = userAgentFor(details.url, electronUa);
    callback({ requestHeaders });
  });
}

/** about:blank and the like: no request goes out, and a popup's opener may be writing into it. */
const isLocalPage = (url: string): boolean => /^about:/i.test(url);

/**
 * Keeps a browser tab's user agent right for the site it is going to: set before each main-frame load (a link, a
 * redirect, a typed or scripted load), so the request and the page's `navigator.userAgent` agree. The session keeps
 * the Electron-token default; only tabs on other sites switch to plain Chrome.
 */
export function installSiteUserAgent(contents: Electron.WebContents, electronUa: string): void {
  // The tab's own agent (the session's), so a new tab's first load is a switch only when its site needs another.
  let current = contents.getUserAgent();
  /** Sets the user agent for `url`; true when it changed. An about: page sends no request, so it never switches. */
  const follow = (url: string): boolean => {
    if (isLocalPage(url)) return false;
    const next = userAgentFor(url, electronUa);
    if (next === current) return false;
    current = next;
    contents.setUserAgent(next);
    return true;
  };
  // Chromium answers a user-agent change during a load by reloading the page already shown, which races the load
  // under way (gmail.com → mail.google.com stayed blank). So a load that needs the other agent is stopped first,
  // leaving nothing to reload, then sent again with the new agent. Deferred a tick: stopping a navigation from inside
  // its own event crashes Electron. Returns whether a restart was scheduled.
  const restart = (url: string): boolean => {
    if (isLocalPage(url) || userAgentFor(url, electronUa) === current) return false;
    setImmediate(() => {
      if (contents.isDestroyed()) return;
      contents.stop();
      follow(url);
      // The stopped load rejects on its own; failures of this one reach did-fail-load like any other load.
      contents.loadURL(url).catch(() => {});
    });
    return true;
  };
  // A link on a settled page has not started loading, so switching cancels nothing. While the tab still loads (an
  // opener pointing its popup somewhere fires this only after the load began) a switch would race that load.
  contents.on('will-navigate', (_event, url) => {
    if (!contents.isLoading()) follow(url);
  });
  // Cancelled before the redirect target is requested, so the restart is its only request.
  contents.on('will-redirect', (details) => {
    if (details.isMainFrame && restart(details.url)) details.preventDefault();
  });
  // Only a load the browser started (the address bar, loadURL, an agent's Page.navigate) restarts. A page's own load
  // (`initiator` set) has already been sent: restarting would send it twice, which spends a one-time login link
  // (ViziPlatform's site login), so it keeps the agent it has this once.
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument && !details.initiator) restart(details.url);
  });
}
