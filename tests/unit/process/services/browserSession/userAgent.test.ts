/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import {
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
    const contents = Object.assign(new EventEmitter(), { ua: '', setUserAgent: vi.fn(), getURL: () => '' });
    contents.setUserAgent.mockImplementation((ua: string) => {
      contents.ua = ua;
    });
    return contents;
  };

  it('switches a tab to plain Chrome on other sites and back to Electron on Google, before each page loads', () => {
    const contents = tab();
    installSiteUserAgent(contents as never, ELECTRON_UA);

    contents.emit('will-navigate', {}, 'https://app.coachmarketingmachine.com/');
    expect(contents.ua).toBe(CHROME_UA);
    contents.emit('will-redirect', { url: 'https://accounts.google.com/signin', isMainFrame: true });
    expect(contents.ua).toContain('Electron/44.9.1');
    contents.emit('did-start-navigation', {
      url: 'https://app.coachmarketingmachine.com/x',
      isMainFrame: true,
      isSameDocument: false,
    });
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
});
