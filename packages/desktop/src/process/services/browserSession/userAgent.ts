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

/** Repeated challenges of one host after the switch that are reported for diagnosis. */
const MAX_REPORTED_REPEATS = 5;

/** Cloudflare's clearance cookie, which its check sets and ties to the agent that passed it. */
const CLEARANCE_COOKIE = 'cf_clearance';

/** Cloudflare marks its challenge page with `cf-mitigated: challenge` (any header case). */
const isCloudflareChallenge = (headers: Record<string, string[]> | undefined): boolean =>
  Object.entries(headers ?? {}).some(
    ([name, values]) => name.toLowerCase() === 'cf-mitigated' && values.some((v) => v.toLowerCase() === 'challenge')
  );

/**
 * When Cloudflare challenges a page load, its host gets Electron's own agent from then on and the tab loads it again on
 * that agent (once per host: a challenge that remains is the user's own check, not a loop). A later challenge that
 * finds the tab on another agent than its page loads send is put right and loaded once more: Cloudflare ties the
 * clearance the check grants to the agent that passed it, so a mismatch refuses every pass (the Windows loop, logged
 * with cf_clearance present and the tab still on plain Chrome). Each time, the host's clearance cookie goes first: one
 * issued to another agent, or refused, would otherwise ride along with the next pass's (the v2.2.32 Windows loop:
 * cf_clearance present, agent matching). `contentsOf` finds a tab by its webContents id.
 */
export function installChallengeFallback(
  session: Electron.Session,
  electronUa: string,
  contentsOf: (webContentsId: number) => Electron.WebContents | null,
  stillChallenged?: (webContentsId: number, url: string, repeat: number) => void | Promise<void>,
  onChallengePage?: (webContentsId: number) => void
): void {
  // Repeats per host after the switch, reported the first few times (diagnostics; the loop is the user's to judge).
  const repeats = new Map<string, number>();
  // Removes every cf_clearance that would be sent to `url`; a failure leaves it and the page loads anyway.
  const dropClearance = (url: string): Promise<void> => session.cookies.remove(url, CLEARANCE_COOKIE).catch(() => {});
  const loadInTab = (webContentsId: number | undefined, url: string): void => {
    const contents = webContentsId === undefined ? null : contentsOf(webContentsId);
    if (contents && !contents.isDestroyed()) loadWithSiteAgent(contents, url, electronUa);
  };
  session.webRequest.onHeadersReceived((details, callback) => {
    callback({});
    if (details.resourceType !== 'mainFrame' || !isCloudflareChallenge(details.responseHeaders)) return;
    const host = hostOf(details.url);
    if (host === null) return;
    if (details.webContentsId !== undefined) onChallengePage?.(details.webContentsId);
    if (challengedHosts.has(host)) {
      const repeat = (repeats.get(host) ?? 0) + 1;
      repeats.set(host, repeat);
      const report =
        repeat <= MAX_REPORTED_REPEATS && details.webContentsId !== undefined
          ? stillChallenged?.(details.webContentsId, details.url, repeat)
          : undefined;
      const contents = details.webContentsId === undefined ? null : contentsOf(details.webContentsId);
      const mismatched =
        contents && !contents.isDestroyed() && contents.getUserAgent() !== userAgentFor(details.url, electronUa);
      // Reported first, so the log shows the cookie that was refused.
      void Promise.resolve(report)
        .catch(() => {})
        .then(() => dropClearance(details.url))
        .then(() => {
          if (mismatched) loadInTab(details.webContentsId, details.url);
        });
      return;
    }
    if (keepsElectronToken(details.url)) return;
    challengedHosts.add(host);
    console.warn(`[BrowserSession] Cloudflare challenged ${host}; using the browser's own agent there`);
    void dropClearance(details.url).then(() => loadInTab(details.webContentsId, details.url));
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
    callback({ requestHeaders: withUserAgent(details.requestHeaders, userAgentFor(details.url, electronUa)) });
  });
}

/**
 * `headers` sending `agent` as their user agent, every header kept where it was: untouched when the agent is already
 * right, otherwise the value replaced in place. Cloudflare fingerprints header order, and Chrome sends User-Agent
 * early, never last: moving it to the end made every page load look like another client than the one that passed the
 * check, so each pass was refused and challenged again (the socialadsmentor.com loop, cf_clearance and agent matching).
 */
export function withUserAgent(headers: Record<string, string>, agent: string): Record<string, string> {
  const name = Object.keys(headers).find((key) => key.toLowerCase() === 'user-agent');
  if (name === undefined) return { ...headers, 'User-Agent': agent };
  if (headers[name] === agent) return headers;
  return Object.fromEntries(
    Object.entries(headers).map(([key, value]) => (key === name ? ['User-Agent', agent] : [key, value]))
  );
}

/** about:blank and the like: no request goes out, and a popup's opener may be writing into it. */
const isLocalPage = (url: string): boolean => /^about:/i.test(url);

/**
 * Loads `url` in the tab on the agent of its site, deferred a tick (stopping or loading from inside an event of the
 * load under way crashes Electron or races it). A tab on another agent is stopped first: Chromium answers a user-agent
 * change during a load by reloading the page already shown, which races the new load (gmail.com → mail.google.com
 * stayed blank).
 */
export function loadWithSiteAgent(contents: Electron.WebContents, url: string, electronUa: string): void {
  setImmediate(() => {
    if (contents.isDestroyed()) return;
    const agent = userAgentFor(url, electronUa);
    if (contents.getUserAgent() !== agent) {
      contents.stop();
      contents.setUserAgent(agent);
    }
    // A stopped load rejects on its own; failures of this one reach did-fail-load like any other load.
    contents.loadURL(url).catch(() => {});
  });
}

/**
 * Keeps a browser tab's user agent right for the site it is going to: set before each main-frame load (a link, a
 * redirect, a typed or scripted load), so the request and the page's `navigator.userAgent` agree. The session keeps
 * the Electron-token default; only tabs on other sites switch to plain Chrome. Each switch is judged by the tab's real
 * agent: other code switches it too ({@link installChallengeFallback}).
 */
export function installSiteUserAgent(contents: Electron.WebContents, electronUa: string): void {
  /** Whether a load of `url` needs another agent than the tab has. An about: page sends no request: never. */
  const needsSwitch = (url: string): boolean =>
    !isLocalPage(url) && userAgentFor(url, electronUa) !== contents.getUserAgent();
  // A link on a settled page has not started loading, so switching cancels nothing. While the tab still loads (an
  // opener pointing its popup somewhere fires this only after the load began) a switch would race that load.
  contents.on('will-navigate', (_event, url) => {
    if (!contents.isLoading() && needsSwitch(url)) contents.setUserAgent(userAgentFor(url, electronUa));
  });
  // A load under way that needs the other agent is stopped and sent again on it (see loadWithSiteAgent).
  // Cancelled before the redirect target is requested, so the restart is its only request.
  contents.on('will-redirect', (details) => {
    if (!details.isMainFrame || !needsSwitch(details.url)) return;
    details.preventDefault();
    loadWithSiteAgent(contents, details.url, electronUa);
  });
  // Only a load the browser started (the address bar, loadURL, an agent's Page.navigate) restarts. A page's own load
  // (`initiator` set) has already been sent: restarting would send it twice, which spends a one-time login link
  // (ViziPlatform's site login), so it keeps the agent it has this once.
  contents.on('did-start-navigation', (details) => {
    if (details.isMainFrame && !details.isSameDocument && !details.initiator && needsSwitch(details.url)) {
      loadWithSiteAgent(contents, details.url, electronUa);
    }
  });
}
