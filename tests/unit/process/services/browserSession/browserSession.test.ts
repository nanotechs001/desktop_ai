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
    installWindowOpenHandler: vi.fn(),
    installBeforeUnloadDialog: vi.fn(),
    installContextMenu: vi.fn(),
    installBrowserShortcuts: vi.fn(),
    installDownloads: vi.fn(),
    installPermissions: vi.fn(),
    extensions: { addTab: vi.fn(), selectTab: vi.fn(), getContextMenuItems: vi.fn(() => ['ext item']) },
    initBrowserExtensions: vi.fn(),
    fromId: vi.fn(),
    openTabEmit: vi.fn(),
    closeTabEmit: vi.fn(),
  };
});

vi.mock('electron', () => ({
  app: mocks.app,
  session: { fromPartition: mocks.fromPartition },
  webContents: { fromId: mocks.fromId },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    browser: { openTabRequested: { emit: mocks.openTabEmit }, closeTabRequested: { emit: mocks.closeTabEmit } },
  },
}));

vi.mock('@process/services/browserSession/extensions', () => ({ initBrowserExtensions: mocks.initBrowserExtensions }));

vi.mock('@process/services/browserSession/downloads', () => ({ installDownloads: mocks.installDownloads }));

vi.mock('@process/services/browserSession/permissions', () => ({ installPermissions: mocks.installPermissions }));

vi.mock('@process/services/browserSession/contextMenu/contextMenuInstall', () => ({
  installContextMenu: mocks.installContextMenu,
}));

vi.mock('@process/services/browserSession/shortcuts', () => ({
  installBrowserShortcuts: mocks.installBrowserShortcuts,
}));

vi.mock('@process/services/browserSession/windowOpen', () => ({
  installWindowOpenHandler: mocks.installWindowOpenHandler,
  installBeforeUnloadDialog: mocks.installBeforeUnloadDialog,
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
  mocks.installWindowOpenHandler.mockClear();
  mocks.installBeforeUnloadDialog.mockClear();
  mocks.installContextMenu.mockClear();
  mocks.installBrowserShortcuts.mockClear();
  mocks.installDownloads.mockClear();
  mocks.installPermissions.mockClear();
  vi.clearAllMocks();
  mocks.extensions.getContextMenuItems.mockReturnValue(['ext item']);
  mocks.initBrowserExtensions.mockImplementation(() => Promise.resolve(mocks.extensions));
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
    expect(mocks.installDownloads).toHaveBeenCalledTimes(1);
    expect(mocks.installDownloads).toHaveBeenCalledWith(mocks.browserSession);
    expect(mocks.installPermissions).toHaveBeenCalledTimes(1);
    expect(mocks.installPermissions).toHaveBeenCalledWith(mocks.browserSession);
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

    it('installs the window-open handler on browser webviews and popups, with the main window as parent', async () => {
      const { initBrowserSession } = await loadModule();
      const main = makeMainWindow(makeContents('window', mocks.otherSession));
      initBrowserSession({ getMainWindow: () => asWindow(main) });
      const handler = getCreatedHandler();

      const webview = makeContents('webview');
      const popup = makeContents('window');
      handler({}, webview);
      handler({}, popup);
      handler({}, main.webContents);
      handler({}, makeContents('webview', mocks.otherSession));

      expect(mocks.installWindowOpenHandler.mock.calls.map(([contents]) => contents)).toEqual([webview, popup]);
      expect(mocks.installWindowOpenHandler.mock.calls[0][1]()).toBe(main);
      expect(mocks.installBeforeUnloadDialog.mock.calls.map(([contents]) => contents)).toEqual([webview, popup]);
      expect(mocks.installBeforeUnloadDialog.mock.calls[0][1]()).toBe(main);
    });

    it('installs the context menu on browser webviews and popups only', async () => {
      const { initBrowserSession } = await loadModule();
      const main = makeMainWindow(makeContents('window', mocks.otherSession));
      initBrowserSession({ getMainWindow: () => asWindow(main) });
      const handler = getCreatedHandler();

      const webview = makeContents('webview');
      const popup = makeContents('window');
      handler({}, webview);
      handler({}, popup);
      handler({}, main.webContents);

      expect(mocks.installContextMenu.mock.calls.map(([contents]) => contents)).toEqual([webview, popup]);
      expect(mocks.installContextMenu.mock.calls[0][1]()).toBe(main);
      expect(mocks.installBrowserShortcuts.mock.calls.map(([contents]) => contents)).toEqual([webview, popup]);
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

    it('logs a rejecting async listener once and still runs the other listeners', async () => {
      const { initBrowserSession, onBrowserContentsCreated } = await loadModule();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const failure = new Error('async boom');
      const rejecting = vi.fn(async () => {
        throw failure;
      });
      const after = vi.fn();
      onBrowserContentsCreated(rejecting);
      onBrowserContentsCreated(after);
      initBrowserSession({ getMainWindow: () => null });

      expect(() => getCreatedHandler()({}, makeContents('webview'))).not.toThrow();

      expect(after).toHaveBeenCalledTimes(1);
      await vi.waitFor(() => expect(consoleError).toHaveBeenCalledTimes(1));
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[BrowserSession]'), failure);
    });

    it('starts an async listener synchronously, before the first navigation can happen', async () => {
      const { initBrowserSession, onBrowserContentsCreated } = await loadModule();
      const steps: string[] = [];
      onBrowserContentsCreated(async () => {
        steps.push('sync part');
        await Promise.resolve();
        steps.push('after await');
      });
      initBrowserSession({ getMainWindow: () => null });

      getCreatedHandler()({}, makeContents('webview'));

      expect(steps).toEqual(['sync part']);
      await vi.waitFor(() => expect(steps).toEqual(['sync part', 'after await']));
    });

    it('does not log a listener whose promise resolves', async () => {
      const { initBrowserSession, onBrowserContentsCreated } = await loadModule();
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
      const listener = vi.fn(async () => {});
      onBrowserContentsCreated(listener);
      initBrowserSession({ getMainWindow: () => null });

      getCreatedHandler()({}, makeContents('webview'));
      await Promise.resolve();

      expect(listener).toHaveBeenCalledTimes(1);
      expect(consoleError).not.toHaveBeenCalled();
    });

    it('runs a listener registered after initBrowserSession for later contents', async () => {
      const { initBrowserSession, onBrowserContentsCreated } = await loadModule();
      initBrowserSession({ getMainWindow: () => null });
      const handler = getCreatedHandler();
      const early = makeContents('webview');
      handler({}, early);
      const late = vi.fn();
      onBrowserContentsCreated(late);

      const later = makeContents('webview');
      handler({}, later);

      expect(late.mock.calls.map(([contents]) => contents)).toEqual([later]);
    });

    it('dispatches to a snapshot: changes made during dispatch apply from the next contents', async () => {
      const { initBrowserSession, onBrowserContentsCreated } = await loadModule();
      const added = vi.fn();
      const removed = vi.fn();
      // Registered first, so it runs before `removed` and changes the set mid-dispatch.
      onBrowserContentsCreated(() => {
        unsubscribeRemoved();
        onBrowserContentsCreated(added);
      });
      const unsubscribeRemoved = onBrowserContentsCreated(removed);
      initBrowserSession({ getMainWindow: () => null });
      const handler = getCreatedHandler();

      handler({}, makeContents('webview'));
      expect(removed).toHaveBeenCalledTimes(1);
      expect(added).not.toHaveBeenCalled();

      handler({}, makeContents('webview'));
      expect(removed).toHaveBeenCalledTimes(1);
      expect(added).toHaveBeenCalledTimes(1);
    });

    it('shares one slot when the same function is registered twice', async () => {
      const { initBrowserSession, onBrowserContentsCreated } = await loadModule();
      const listener = vi.fn();
      onBrowserContentsCreated(listener);
      const unsubscribe = onBrowserContentsCreated(listener);
      initBrowserSession({ getMainWindow: () => null });
      const handler = getCreatedHandler();

      handler({}, makeContents('webview'));
      expect(listener).toHaveBeenCalledTimes(1);

      unsubscribe();
      handler({}, makeContents('webview'));
      expect(listener).toHaveBeenCalledTimes(1);
    });
  });
});

describe('Chrome extensions wiring', () => {
  type Deps = {
    session: unknown;
    getMainWindow: () => unknown;
    openTab: (url: string) => void;
    closeTab: (id: number) => void;
  };

  const setup = async () => {
    const mod = await loadModule();
    const main = makeMainWindow(makeContents('window', mocks.otherSession));
    mod.initBrowserSession({ getMainWindow: () => asWindow(main) });
    // Let the extensions promise settle so the handle is in place.
    await Promise.resolve();
    await Promise.resolve();
    const deps = mocks.initBrowserExtensions.mock.calls[0][0] as Deps;
    return { mod, main, deps, handler: getCreatedHandler() };
  };

  it('starts extensions on the browser session and routes tab open/close through the IPC bridge', async () => {
    const { deps, main } = await setup();

    expect(mocks.initBrowserExtensions).toHaveBeenCalledTimes(1);
    expect(deps.session).toBe(mocks.browserSession);
    expect(deps.getMainWindow()).toBe(main);
    deps.openTab('https://a.test/');
    deps.closeTab(9);
    expect(mocks.openTabEmit).toHaveBeenCalledWith({ url: 'https://a.test/', background: false });
    expect(mocks.closeTabEmit).toHaveBeenCalledWith({ webContentsId: 9 });
  });

  it('tracks browser webviews as extension tabs, but not popups', async () => {
    const { handler } = await setup();
    const webview = makeContents('webview');

    handler({}, webview);
    handler({}, makeContents('window'));

    expect(mocks.extensions.addTab.mock.calls).toEqual([[webview]]);
  });

  it('appends extension context-menu items for the right-clicked contents', async () => {
    const { handler } = await setup();
    const webview = makeContents('webview');
    handler({}, webview);
    const extraItems = mocks.installContextMenu.mock.calls[0][2] as (params: unknown) => unknown[];
    const params = { x: 1 };

    expect(extraItems(params)).toEqual(['ext item']);
    expect(mocks.extensions.getContextMenuItems).toHaveBeenCalledWith(webview, params);
  });

  it('logs a failed extensions start and keeps the browser working without extensions', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('license');
    mocks.initBrowserExtensions.mockImplementation(() => Promise.reject(failure));
    const { mod, handler } = await setup();
    const webview = makeContents('webview');

    await vi.waitFor(() =>
      expect(consoleError).toHaveBeenCalledWith(expect.stringContaining('[BrowserSession]'), failure)
    );
    expect(() => handler({}, webview)).not.toThrow();
    expect(mocks.installWindowOpenHandler).toHaveBeenCalledWith(webview, expect.any(Function));
    expect((mocks.installContextMenu.mock.calls[0][2] as (p: unknown) => unknown[])({})).toEqual([]);
    mocks.fromId.mockReturnValue({ ...webview, isDestroyed: () => false });
    expect(() => mod.selectBrowserTab(1)).not.toThrow();
  });

  it('selectBrowserTab forwards live browser-session contents only', async () => {
    const { mod } = await setup();
    const browserTab = { ...makeContents('webview'), isDestroyed: () => false };
    const otherTab = { ...makeContents('webview', mocks.otherSession), isDestroyed: () => false };
    const deadTab = { ...makeContents('webview'), isDestroyed: () => true };
    mocks.fromId.mockImplementation((id: number) => ({ 1: browserTab, 2: otherTab, 3: deadTab })[id]);

    mod.selectBrowserTab(2);
    mod.selectBrowserTab(3);
    mod.selectBrowserTab(4);
    mod.selectBrowserTab(1);

    expect(mocks.extensions.selectTab.mock.calls).toEqual([[browserTab]]);
  });
});
