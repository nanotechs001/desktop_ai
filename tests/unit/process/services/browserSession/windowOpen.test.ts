/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ emit: vi.fn() }));

vi.mock('@/common', () => ({ ipcBridge: { browser: { openTabRequested: { emit: mocks.emit } } } }));

import {
  classifyWindowOpen,
  installWindowOpenHandler,
  popupWindowOptions,
} from '@process/services/browserSession/windowOpen';

const classify = (url: string, disposition: string, features = '') =>
  classifyWindowOpen({ url, disposition, features });

beforeEach(() => {
  mocks.emit.mockClear();
});

describe('classifyWindowOpen', () => {
  it('foreground-tab becomes a foreground tab and background-tab a background tab', () => {
    expect(classify('https://a.test/', 'foreground-tab')).toEqual({
      kind: 'tab',
      url: 'https://a.test/',
      background: false,
    });
    expect(classify('https://a.test/', 'background-tab')).toEqual({
      kind: 'tab',
      url: 'https://a.test/',
      background: true,
    });
  });

  it('new-window with width and height features becomes a popup of that size', () => {
    expect(classify('https://a.test/', 'new-window', 'width=500,height=600')).toEqual({
      kind: 'popup',
      url: 'https://a.test/',
      width: 500,
      height: 600,
    });
  });

  it('new-window with the popup feature and no size gets 600x700', () => {
    expect(classify('https://a.test/', 'new-window', 'popup')).toEqual({
      kind: 'popup',
      url: 'https://a.test/',
      width: 600,
      height: 700,
    });
  });

  it('new-window with no features at all is still a popup (shift-click)', () => {
    expect(classify('https://a.test/', 'new-window')).toMatchObject({ kind: 'popup', width: 600, height: 700 });
  });

  it('default disposition with empty features becomes a tab', () => {
    expect(classify('https://a.test/', 'default')).toEqual({ kind: 'tab', url: 'https://a.test/', background: false });
  });

  it('treats "other" like "default": features decide between tab and popup', () => {
    expect(classify('https://a.test/', 'other')).toMatchObject({ kind: 'tab' });
    expect(classify('https://a.test/', 'other', 'width=450,height=350')).toMatchObject({
      kind: 'popup',
      width: 450,
      height: 350,
    });
  });

  it('a lone width fills the missing height with the default', () => {
    expect(classify('https://a.test/', 'default', 'width=420')).toMatchObject({
      kind: 'popup',
      width: 420,
      height: 700,
    });
  });

  it.each(['popup=1', 'popup=yes', 'popup=true', ' popup = yes ', 'POPUP'])(
    'features "%s" make a popup',
    (features) => {
      expect(classify('https://a.test/', 'default', features)).toMatchObject({ kind: 'popup' });
    }
  );

  it.each(['popup=0', 'popup=no', 'popup=false'])('features "%s" do not make a popup', (features) => {
    expect(classify('https://a.test/', 'default', features)).toMatchObject({ kind: 'tab' });
  });

  it('noopener alone does not make a popup', () => {
    expect(classify('https://a.test/', 'default', 'noopener,noreferrer')).toMatchObject({ kind: 'tab' });
  });

  it('reads sizes from comma-separated pairs with spaces and ignores unrelated keys', () => {
    expect(
      classify('https://a.test/', 'default', 'left=10, top=20, width = 480 ,height=520,scrollbars=yes')
    ).toMatchObject({
      kind: 'popup',
      width: 480,
      height: 520,
    });
  });

  it.each(['width=abc', 'width=0,height=-5', 'width='])('ignores unusable size "%s"', (features) => {
    expect(classify('https://a.test/', 'default', features)).toMatchObject({ kind: 'tab' });
  });

  it('about:blank with features is a popup (OAuth flows open about:blank then navigate)', () => {
    expect(classify('about:blank', 'new-window', 'width=500,height=600')).toEqual({
      kind: 'popup',
      url: 'about:blank',
      width: 500,
      height: 600,
    });
  });

  it.each([
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,x',
    'chrome://settings',
    'ftp://a.test/',
    'blob:https://a.test/x',
  ])('%s is denied', (url) => {
    expect(classify(url, 'foreground-tab')).toEqual({ kind: 'deny' });
    expect(classify(url, 'new-window', 'width=500,height=600')).toEqual({ kind: 'deny' });
  });

  it.each(['about:srcdoc', 'about:blank#x', '', 'not a url', 'JAVASCRIPT:alert(1)', '  javascript:alert(1)'])(
    '%j is denied',
    (url) => {
      expect(classify(url, 'foreground-tab')).toEqual({ kind: 'deny' });
    }
  );
});

describe('popupWindowOptions', () => {
  const PINNED = {
    frame: true,
    alwaysOnTop: false,
    fullscreen: false,
    fullscreenable: true,
    kiosk: false,
    transparent: false,
    skipTaskbar: false,
    resizable: true,
    movable: true,
    minimizable: true,
    closable: true,
  };
  const makeParent = (bounds = { x: 100, y: 50, width: 1000, height: 800 }) =>
    ({ getBounds: () => bounds }) as unknown as Electron.BrowserWindow;

  it('clamps 3000x50 to 1400x300, uses the browser partition and centers on the parent', () => {
    const parent = makeParent();

    const options = popupWindowOptions({ width: 3000, height: 50 }, parent);

    expect(options).toEqual({
      parent,
      width: 1400,
      height: 300,
      x: -100,
      y: 300,
      autoHideMenuBar: true,
      ...PINNED,
      webPreferences: {
        partition: 'persist:aionui-browser',
        contextIsolation: true,
        sandbox: true,
        nodeIntegration: false,
      },
    });
  });

  it('neutralizes hostile page features: Electron spreads them under these options', () => {
    // Electron turns "left=5,top=7,frame=no,alwaysOnTop=yes,..." into BrowserWindow options and then
    // spreads ours over them, so every key a page can set must be present here with a safe value.
    const hostile = { x: 5, y: 7, frame: false, alwaysOnTop: true, fullscreen: true, kiosk: true, transparent: true };
    const hostileOnly = { skipTaskbar: true, resizable: false, movable: false, minimizable: false, closable: false };
    const pageParsed = { ...hostile, ...hostileOnly, fullscreenable: false };

    const merged = { ...pageParsed, ...popupWindowOptions({ width: 500, height: 600 }, makeParent()) };

    expect(merged).toMatchObject({ ...PINNED, x: 350, y: 150 });
  });

  it('leaves position to the OS rather than the page without a parent, as own keys that override left/top', () => {
    const options = popupWindowOptions({ width: 500, height: 600 }, null);

    expect(Object.keys(options)).toEqual(expect.arrayContaining(['x', 'y']));
    expect(options.x).toBeUndefined();
    expect(options.y).toBeUndefined();
    expect({ x: 5, y: 7, ...options }.x).toBeUndefined();
  });

  it('clamps the small end of width and the large end of height', () => {
    expect(popupWindowOptions({ width: 10, height: 5000 }, null)).toMatchObject({ width: 400, height: 1000 });
  });

  it('keeps an in-range size and leaves parent unset without a parent window', () => {
    const options = popupWindowOptions({ width: 500, height: 600 }, null);

    expect(options).toMatchObject({ width: 500, height: 600 });
    expect(options.parent).toBeUndefined();
  });
});

describe('installWindowOpenHandler', () => {
  type Handler = (details: { url: string; disposition: string; features: string }) => {
    action: string;
    overrideBrowserWindowOptions?: Electron.BrowserWindowConstructorOptions;
  };

  const install = (parent: { isDestroyed: () => boolean } | null) => {
    const setWindowOpenHandler = vi.fn();
    installWindowOpenHandler(
      { setWindowOpenHandler } as unknown as Electron.WebContents,
      () => parent as unknown as Electron.BrowserWindow | null
    );
    expect(setWindowOpenHandler).toHaveBeenCalledTimes(1);
    return setWindowOpenHandler.mock.calls[0][0] as Handler;
  };

  it('asks the renderer for a tab and denies the native window', () => {
    const handler = install(null);

    const result = handler({ url: 'https://a.test/', disposition: 'background-tab', features: '' });

    expect(result).toEqual({ action: 'deny' });
    expect(mocks.emit).toHaveBeenCalledWith({ url: 'https://a.test/', background: true });
  });

  it('allows a popup as a child window of the parent on the browser partition', () => {
    const parent = { isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }) };
    const handler = install(parent);

    const result = handler({ url: 'https://a.test/', disposition: 'new-window', features: 'width=500,height=600' });

    expect(result.action).toBe('allow');
    expect(result.overrideBrowserWindowOptions).toMatchObject({
      parent,
      width: 500,
      height: 600,
      webPreferences: { partition: 'persist:aionui-browser' },
    });
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('does not parent a popup to a destroyed window', () => {
    const handler = install({ isDestroyed: () => true });

    const result = handler({ url: 'https://a.test/', disposition: 'new-window', features: 'popup' });

    expect(result.action).toBe('allow');
    expect(result.overrideBrowserWindowOptions?.parent).toBeUndefined();
  });

  it('denies an unsafe scheme without opening anything', () => {
    const handler = install(null);

    expect(handler({ url: 'javascript:alert(1)', disposition: 'foreground-tab', features: '' })).toEqual({
      action: 'deny',
    });
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});
