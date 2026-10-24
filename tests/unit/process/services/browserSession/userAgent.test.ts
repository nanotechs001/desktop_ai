/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  installChallengeFallback,
  installRequestUserAgent,
  installSiteUserAgent,
  keepsElectronToken,
  toBrowserUserAgent,
  toChromeUserAgent,
  userAgentFor,
} from '@process/services/browserSession/userAgent';

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

const ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) PixebotBrowser/2.2.16 Chrome/152.0.7977.167 Electron/44.9.1 Safari/537.36';
const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.167 Safari/537.36';
/** The browser session's default agent, which a tab starts on: the app's, with the Electron token kept. */
const ELECTRON_UA_SESSION_DEFAULT = toBrowserUserAgent(ELECTRON_UA);

describe('toChromeUserAgent', () => {
  it('drops the app name and the Electron token, so pages see plain Chrome', () => {
    expect(toChromeUserAgent(ELECTRON_UA)).toBe(CHROME_UA);
  });
});

describe('userAgentFor', () => {
  it('keeps the Electron token on Google and YouTube, where Google sign-in needs it', () => {
    for (const url of [
      'https://accounts.google.com/v3/signin/identifier',
      'https://mail.google.com/mail/u/0/',
      'https://www.youtube.com/watch?v=1',
      'https://google.com/',
    ]) {
      expect(keepsElectronToken(url), url).toBe(true);
      expect(userAgentFor(url, ELECTRON_UA)).toContain('Electron/44.9.1');
    }
  });

  it('sends plain Chrome everywhere else, so Firebase-based apps (GHL white-labels) sign in', () => {
    for (const url of [
      'https://app.coachmarketingmachine.com/',
      'https://backend.leadconnectorhq.com/users/x',
      'https://notgoogle.com/',
      'https://google.com.evil.example/',
      'not a url',
    ]) {
      expect(keepsElectronToken(url), url).toBe(false);
      expect(userAgentFor(url, ELECTRON_UA)).toBe(CHROME_UA);
    }
  });
});

describe('installSiteUserAgent', () => {
  const tab = () => {
    const contents = Object.assign(new EventEmitter(), {
      ua: '',
      setUserAgent: vi.fn(),
      getURL: () => '',
      getUserAgent: () => ELECTRON_UA_SESSION_DEFAULT,
      loadURL: vi.fn(() => Promise.resolve()),
      stop: vi.fn(),
      isDestroyed: () => false,
      loading: false,
      isLoading: () => contents.loading,
    });
    contents.setUserAgent.mockImplementation((ua: string) => {
      contents.ua = ua;
    });
    return contents;
  };
  const tick = () => new Promise((resolve) => setImmediate(resolve));

  it('switches a tab to plain Chrome on other sites and back to Electron on Google, before each page loads', async () => {
    const contents = tab();
    installSiteUserAgent(contents as never, ELECTRON_UA);

    contents.emit('will-navigate', {}, 'https://app.coachmarketingmachine.com/');
    expect(contents.ua).toBe(CHROME_UA);
    contents.emit('will-redirect', {
      url: 'https://accounts.google.com/signin',
      isMainFrame: true,
      preventDefault: vi.fn(),
    });
    await tick();
    expect(contents.ua).toContain('Electron/44.9.1');
    contents.emit('did-start-navigation', {
      url: 'https://app.coachmarketingmachine.com/x',
      isMainFrame: true,
      isSameDocument: false,
    });
    await tick();
    expect(contents.ua).toBe(CHROME_UA);
  });

  it('ignores frames and same-page navigations, and does not reset an unchanged user agent', () => {
    const contents = tab();
    installSiteUserAgent(contents as never, ELECTRON_UA);
    contents.emit('did-start-navigation', {
      url: 'https://accounts.google.com/',
      isMainFrame: false,
      isSameDocument: false,
    });
    contents.emit('did-start-navigation', {
      url: 'https://accounts.google.com/',
      isMainFrame: true,
      isSameDocument: true,
    });
    expect(contents.setUserAgent).not.toHaveBeenCalled();
    contents.emit('will-navigate', {}, 'https://a.example/');
    contents.emit('will-navigate', {}, 'https://b.example/');
    expect(contents.setUserAgent).toHaveBeenCalledTimes(1);
  });

  // Chromium answers a user-agent change during a load by reloading the page already shown, which races the new load
  // (gmail.com → mail.google.com stayed blank). Loads already under way are stopped, then sent again with the new agent.
  it('stops a load under way and sends it again when its site needs the other user agent', async () => {
    const contents = tab();
    installSiteUserAgent(contents as never, ELECTRON_UA);
    contents.emit('did-start-navigation', { url: 'https://gmail.com/', isMainFrame: true, isSameDocument: false });
    expect(contents.loadURL).not.toHaveBeenCalled();
    await tick();
    expect(contents.stop).toHaveBeenCalled();
    expect(contents.ua).toBe(CHROME_UA);
    expect(contents.loadURL).toHaveBeenCalledWith('https://gmail.com/');

    contents.loadURL.mockClear();
    const redirect = { url: 'https://mail.google.com/mail/u/0/', isMainFrame: true, preventDefault: vi.fn() };
    contents.emit('will-redirect', redirect);
    expect(redirect.preventDefault).toHaveBeenCalled();
    await tick();
    expect(contents.ua).toContain('Electron/44.9.1');
    expect(contents.loadURL).toHaveBeenCalledWith('https://mail.google.com/mail/u/0/');
  });

  it('lets a load whose user agent is already right, or a link that has not started loading, carry on', async () => {
    const contents = tab();
    installSiteUserAgent(contents as never, ELECTRON_UA);
    contents.emit('will-navigate', {}, 'https://a.example/');
    contents.emit('did-start-navigation', { url: 'https://a.example/', isMainFrame: true, isSameDocument: false });
    const redirect = { url: 'https://b.example/', isMainFrame: true, preventDefault: vi.fn() };
    contents.emit('will-redirect', redirect);
    await tick();
    expect(contents.ua).toBe(CHROME_UA);
    expect(redirect.preventDefault).not.toHaveBeenCalled();
    expect(contents.stop).not.toHaveBeenCalled();
    expect(contents.loadURL).not.toHaveBeenCalled();
  });

  // A new tab (a popup a page opened) starts on the session's agent: its first about:blank load is no switch, so it
  // is not stopped and reloaded, which wiped the page the opener wrote into it and could cancel the login load.
  it("starts from the tab's own user agent and never switches on an about: page", async () => {
    const contents = tab();
    installSiteUserAgent(contents as never, ELECTRON_UA);
    contents.emit('did-start-navigation', { url: 'about:blank', isMainFrame: true, isSameDocument: false });
    await tick();
    expect(contents.setUserAgent).not.toHaveBeenCalled();
    expect(contents.stop).not.toHaveBeenCalled();
    expect(contents.loadURL).not.toHaveBeenCalled();
  });

  // An opener pointing its popup at a one-time login link starts that load itself (`initiator` set), and only then
  // fires will-navigate: restarting it requested the link twice and spent the token.
  it('leaves a load a page started alone: no restart, and no switch while the tab is loading', async () => {
    const contents = tab();
    installSiteUserAgent(contents as never, ELECTRON_UA);
    const login = 'https://productplayground.viziglobal.com/wp-login.php?token=one-time';
    contents.emit('did-start-navigation', { url: login, isMainFrame: true, isSameDocument: false, initiator: {} });
    contents.loading = true;
    contents.emit('will-navigate', {}, login);
    await tick();
    expect(contents.stop).not.toHaveBeenCalled();
    expect(contents.loadURL).not.toHaveBeenCalled();
    expect(contents.setUserAgent).not.toHaveBeenCalled();
  });
});

// A fresh tab's first request went out on the session default and only then switched, so a site that ties its login
// to the agent (WordPress on ViziPlatform) answered the bot's wp-admin with the login page; a second load worked.
describe('installRequestUserAgent', () => {
  type Listener = (
    details: { url: string; resourceType: string; requestHeaders: Record<string, string> },
    callback: (response: { requestHeaders: Record<string, string> }) => void
  ) => void;
  const sessionWithListener = () => {
    let listener: Listener | null = null;
    const session = { webRequest: { onBeforeSendHeaders: vi.fn((fn: Listener) => (listener = fn)) } };
    installRequestUserAgent(session as never, ELECTRON_UA);
    const send = (url: string, resourceType: string, requestHeaders: Record<string, string>) => {
      let sent: Record<string, string> = {};
      listener!({ url, resourceType, requestHeaders }, (response) => (sent = response.requestHeaders));
      return sent;
    };
    return send;
  };

  it("sends every page load with its site's agent, from the first request", () => {
    const send = sessionWithListener();
    const session = toBrowserUserAgent(ELECTRON_UA);
    expect(send('https://productplayground.viziglobal.com/wp-admin/', 'mainFrame', { 'User-Agent': session })).toEqual({
      'User-Agent': CHROME_UA,
    });
    // Google keeps Electron's agent and its own client hints (posing as Chrome there broke sign-in).
    const brands = '"Chromium";v="152", "Not)A;Brand";v="8"';
    expect(
      send('https://accounts.google.com/', 'mainFrame', { 'user-agent': CHROME_UA, Accept: '*/*', 'sec-ch-ua': brands })
    ).toEqual({ 'User-Agent': toBrowserUserAgent(ELECTRON_UA), Accept: '*/*', 'sec-ch-ua': brands });
  });

  it("leaves a page's other requests on the tab's agent", () => {
    const send = sessionWithListener();
    expect(send('https://www.gstatic.com/x.js', 'script', { 'User-Agent': 'tab agent' })).toEqual({
      'User-Agent': 'tab agent',
    });
  });
});

// Cloudflare answers the plain-Chrome agent with an endless "Just a moment..." (403, cf-mitigated: challenge) because
// the browser is not Chrome; Electron's own agent passes (measured on identity.wpengine.com).
describe('installChallengeFallback', () => {
  type HeadersListener = (
    details: {
      url: string;
      resourceType: string;
      statusCode: number;
      webContentsId?: number;
      responseHeaders?: Record<string, string[]>;
    },
    callback: (response: Record<string, never>) => void
  ) => void;
  const setup = () => {
    let listener: HeadersListener | null = null;
    const session = { webRequest: { onHeadersReceived: vi.fn((fn: HeadersListener) => (listener = fn)) } };
    const reload = vi.fn();
    installChallengeFallback(session as never, reload);
    const respond = (
      url: string,
      statusCode: number,
      headers: Record<string, string[]>,
      resourceType = 'mainFrame'
    ) => {
      const callback = vi.fn();
      listener!({ url, resourceType, statusCode, webContentsId: 9, responseHeaders: headers }, callback);
      expect(callback).toHaveBeenCalledWith({});
    };
    return { reload, respond };
  };

  it("gives a site that Cloudflare challenges Electron's own agent and reloads the tab, once", () => {
    const { reload, respond } = setup();
    const url = 'https://challenged.example.net/oauth2/authorize?x=1';
    expect(userAgentFor(url, ELECTRON_UA)).toBe(CHROME_UA);

    respond(url, 403, { 'CF-Mitigated': ['challenge'], Server: ['cloudflare'] });

    expect(userAgentFor(url, ELECTRON_UA)).toBe(toBrowserUserAgent(ELECTRON_UA));
    expect(reload).toHaveBeenCalledWith(9, url);
    respond(url, 403, { 'cf-mitigated': ['challenge'] }); // still challenged: the user's own check, no reload loop
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('ignores responses that are no challenge, and challenges outside the page itself', () => {
    const { reload, respond } = setup();
    respond('https://plain.example.org/', 200, { server: ['cloudflare'] });
    respond('https://frame.example.org/', 403, { 'cf-mitigated': ['challenge'] }, 'subFrame');
    expect(reload).not.toHaveBeenCalled();
    expect(userAgentFor('https://plain.example.org/', ELECTRON_UA)).toBe(CHROME_UA);
  });
});
