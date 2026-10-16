/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type StubContents = { getType: () => string; session: unknown };

const mocks = vi.hoisted(() => {
  const browserSession = { setUserAgent: vi.fn(), webRequest: { onBeforeSendHeaders: vi.fn() } };
  return {
    browserSession,
    otherSession: { setUserAgent: vi.fn() },
    app: {
      userAgentFallback:
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AionUi/2.2.2 Chrome/138.0.7204.243 Electron/37.10.3 Safari/537.36',
      on: vi.fn(),
    },
    fromPartition: vi.fn(() => browserSession),
  };
});

vi.mock('electron', () => ({
  app: mocks.app,
  session: { fromPartition: mocks.fromPartition },
}));

const CHROME_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.7204.243 Safari/537.36';

const makeContents = (type: string, session: unknown = mocks.browserSession): StubContents => ({
  getType: () => type,
  session,
});

const makeMainWindow = (webContents: StubContents, destroyed = false) => ({
  webContents,
  isDestroyed: () => destroyed,
});

// The module keeps init state at module scope, so each test imports a fresh copy.
const loadModule = async () => {
  vi.resetModules();
  return import('@process/services/browserSession/browserSession');
};

type Mod = Awaited<ReturnType<typeof loadModule>>;
type MainWindowArg = Parameters<Mod['isBrowserContents']>[1];
type ContentsArg = Parameters<Mod['isBrowserContents']>[0];

const asContents = (contents: StubContents) => contents as unknown as ContentsArg;
const asWindow = (win: ReturnType<typeof makeMainWindow> | null) => win as unknown as MainWindowArg;

/** Returns the handler passed to the most recent `app.on('web-contents-created', …)`. */
const getCreatedHandler = (): ((event: unknown, contents: StubContents) => void) => {
  const call = mocks.app.on.mock.calls.findLast(([name]) => name === 'web-contents-created');
  if (!call) throw new Error('web-contents-created handler was not registered');
  return call[1];
};

beforeEach(() => {
  mocks.app.on.mockClear();
  mocks.fromPartition.mockClear();
  mocks.browserSession.setUserAgent.mockClear();
  mocks.browserSession.webRequest.onBeforeSendHeaders.mockClear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isBrowserContents', () => {
  it('is true for a webview or window on the browser session', async () => {
    const { isBrowserContents } = await loadModule();
    const main = makeMainWindow(makeContents('window', mocks.otherSession));

    expect(isBrowserContents(asContents(makeContents('webview')), asWindow(main))).toBe(true);
    expect(isBrowserContents(asContents(makeContents('window')), asWindow(main))).toBe(true);
    expect(isBrowserContents(asContents(makeContents('webview')), null)).toBe(true);
  });

  it('is false for the main window, even on the browser session', async () => {
    const { isBrowserContents } = await loadModule();
    const mainContents = makeContents('window');

    expect(isBrowserContents(asContents(mainContents), asWindow(makeMainWindow(mainContents)))).toBe(false);
  });

  it('does not touch a destroyed main window', async () => {
    const { isBrowserContents } = await loadModule();
    const main = makeMainWindow(makeContents('window'), true);
    Object.defineProperty(main, 'webContents', {
      get: () => {
        throw new Error('Object has been destroyed');
      },
    });

    expect(isBrowserContents(asContents(makeContents('webview')), asWindow(main))).toBe(true);
  });

  it('is false for other sessions', async () => {
    const { isBrowserContents } = await loadModule();

    expect(isBrowserContents(asContents(makeContents('webview', mocks.otherSession)), null)).toBe(false);
    expect(isBrowserContents(asContents(makeContents('window', mocks.otherSession)), null)).toBe(false);
  });

  it('is false for other contents types on the browser session', async () => {
    const { isBrowserContents } = await loadModule();

    expect(isBrowserContents(asContents(makeContents('backgroundPage')), null)).toBe(false);
    expect(isBrowserContents(asContents(makeContents('remote')), null)).toBe(false);
  });
});

describe('initBrowserSession', () => {
  it('sets the stripped UA on the browser session once, even when called twice', async () => {
    const { initBrowserSession } = await loadModule();
    const deps = { getMainWindow: () => null };

    initBrowserSession(deps);
    initBrowserSession(deps);

    expect(mocks.fromPartition).toHaveBeenCalledWith('persist:aionui-browser');
    expect(mocks.browserSession.setUserAgent).toHaveBeenCalledTimes(1);
    expect(mocks.browserSession.setUserAgent).toHaveBeenCalledWith(CHROME_UA);
    expect(mocks.browserSession.webRequest.onBeforeSendHeaders).toHaveBeenCalledTimes(1);
    expect(mocks.app.on.mock.calls.filter(([name]) => name === 'web-contents-created')).toHaveLength(1);
  });

  describe('sec-ch-ua rewriting', () => {
    const setup = async () => {
      const { initBrowserSession } = await loadModule();
      initBrowserSession({ getMainWindow: () => null });
      const [filter, listener] = mocks.browserSession.webRequest.onBeforeSendHeaders.mock.calls[0];
      return { filter, listener };
    };
    const run = (listener: (d: unknown, cb: (r: unknown) => void) => void, url: string, requestHeaders: object) => {
      const callback = vi.fn();
      listener({ url, requestHeaders }, callback);
      expect(callback).toHaveBeenCalledTimes(1);
      return callback.mock.calls[0][0] as { requestHeaders: Record<string, string> };
    };

    it('only listens for Google hosts', async () => {
      const { filter } = await setup();

      expect(filter).toEqual({ urls: ['*://*.google.com/*', '*://google.com/*', '*://*.googleusercontent.com/*'] });
    });

    it('adds "Google Chrome" to both client-hint headers without mutating the input', async () => {
      const { listener } = await setup();
      const headers = Object.freeze({
        'sec-ch-ua': '"Chromium";v="138", "Not)A;Brand";v="8"',
        'Sec-CH-UA-Full-Version-List': '"Chromium";v="138.0.7204.243", "Not)A;Brand";v="8.0.0.0"',
        'User-Agent': CHROME_UA,
      });

      const { requestHeaders } = run(listener, 'https://accounts.google.com/signin', headers);

      expect(requestHeaders).toEqual({
        'sec-ch-ua': '"Chromium";v="138", "Not)A;Brand";v="8", "Google Chrome";v="138"',
        'Sec-CH-UA-Full-Version-List':
          '"Chromium";v="138.0.7204.243", "Not)A;Brand";v="8.0.0.0", "Google Chrome";v="138.0.7204.243"',
        'User-Agent': CHROME_UA,
      });
    });

    it('passes headers through unchanged for non-Google URLs', async () => {
      const { listener } = await setup();
      const headers = { 'sec-ch-ua': '"Chromium";v="138"' };

      expect(run(listener, 'https://example.com/', headers).requestHeaders).toEqual(headers);
    });
  });

  describe('web-contents-created', () => {
    it('runs onBrowserContentsCreated listeners for browser contents only', async () => {
      const { initBrowserSession, onBrowserContentsCreated } = await loadModule();
      const main = makeMainWindow(makeContents('window', mocks.otherSession));
      const listener = vi.fn();
      onBrowserContentsCreated(listener);
      initBrowserSession({ getMainWindow: () => asWindow(main) });
      const handler = getCreatedHandler();

      const webview = makeContents('webview');
      const popup = makeContents('window');
      handler({}, webview);
      handler({}, popup);
      handler({}, main.webContents);
      handler({}, makeContents('webview', mocks.otherSession));

      expect(listener.mock.calls.map(([contents]) => contents)).toEqual([webview, popup]);
    });

    it('stops notifying a listener once it is unsubscribed', async () => {
      const { initBrowserSession, onBrowserContentsCreated } = await loadModule();
      const kept = vi.fn();
      const dropped = vi.fn();
      onBrowserContentsCreated(kept);
      const unsubscribe = onBrowserContentsCreated(dropped);
      initBrowserSession({ getMainWindow: () => null });
      unsubscribe();

      getCreatedHandler()({}, makeContents('webview'));

      expect(kept).toHaveBeenCalledTimes(1);
      expect(dropped).not.toHaveBeenCalled();
    });

    it('keeps notifying the remaining listeners when one throws', async () => {
      const { initBrowserSession, onBrowserContentsCreated } = await loadModule();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failing = vi.fn(() => {
        throw new Error('boom');
      });
      const after = vi.fn();
      onBrowserContentsCreated(failing);
      onBrowserContentsCreated(after);
      initBrowserSession({ getMainWindow: () => null });

      expect(() => getCreatedHandler()({}, makeContents('webview'))).not.toThrow();

      expect(after).toHaveBeenCalledTimes(1);
      expect(consoleError).toHaveBeenCalledTimes(1);
    });
  });
});
