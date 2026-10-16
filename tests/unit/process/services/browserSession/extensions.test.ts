/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Impl = {
  createTab: (details: { url?: string }) => Promise<[unknown, unknown]>;
  removeTab: (tab: { id: number }, window: unknown) => void;
};

const mocks = vi.hoisted(() => ({
  defaultSession: { name: 'default' },
  constructed: [] as Array<Record<string, unknown>>,
  addTab: vi.fn(),
  selectTab: vi.fn(),
  getContextMenuItems: vi.fn(() => [{ label: 'Ext item' }]),
  handleCRXProtocol: vi.fn(),
  installChromeWebStore: vi.fn(() => Promise.resolve()),
}));

vi.mock('electron', () => ({ session: { defaultSession: mocks.defaultSession } }));

vi.mock('electron-chrome-extensions', () => ({
  ElectronChromeExtensions: class {
    static handleCRXProtocol = mocks.handleCRXProtocol;
    addTab = mocks.addTab;
    selectTab = mocks.selectTab;
    getContextMenuItems = mocks.getContextMenuItems;
    constructor(options: Record<string, unknown>) {
      mocks.constructed.push(options);
    }
  },
}));

vi.mock('electron-chrome-web-store', () => ({ installChromeWebStore: mocks.installChromeWebStore }));

import { CreateTabWaiter, initBrowserExtensions } from '@process/services/browserSession/extensions';

const browserSession = { name: 'browser' } as unknown as Electron.Session;
const mainWindow = { isDestroyed: () => false } as unknown as Electron.BrowserWindow;
const contentsWithId = (id: number) => ({ id }) as unknown as Electron.WebContents;

const setup = async (getMainWindow: () => Electron.BrowserWindow | null = () => mainWindow) => {
  const openTab = vi.fn();
  const closeTab = vi.fn();
  const extensions = await initBrowserExtensions({ session: browserSession, getMainWindow, openTab, closeTab });
  const impl = mocks.constructed.at(-1) as unknown as Impl;
  return { extensions, impl, openTab, closeTab };
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.constructed.length = 0;
  mocks.installChromeWebStore.mockImplementation(() => Promise.resolve());
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('CreateTabWaiter', () => {
  it('CreateTabWaiter resolves waiters in FIFO order as browser tabs attach', async () => {
    const waiter = new CreateTabWaiter();
    const first = waiter.wait('https://a.test/', 1000);
    const second = waiter.wait('https://b.test/', 1000);
    const a = contentsWithId(1);
    const b = contentsWithId(2);

    waiter.onAttached(a);
    waiter.onAttached(b);

    await expect(first).resolves.toBe(a);
    await expect(second).resolves.toBe(b);
  });

  it('CreateTabWaiter rejects with "tab-create-timeout" after timeoutMs and drops the waiter', async () => {
    vi.useFakeTimers();
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const waiter = new CreateTabWaiter();
    const timedOut = waiter.wait('https://a.test/', 100);
    const assertion = expect(timedOut).rejects.toThrow('tab-create-timeout');

    await vi.advanceTimersByTimeAsync(100);
    await assertion;

    const next = waiter.wait('https://b.test/', 100);
    const contents = contentsWithId(3);
    waiter.onAttached(contents);
    await expect(next).resolves.toBe(contents);
  });

  it('ignores an attach when nobody is waiting', () => {
    expect(() => new CreateTabWaiter().onAttached(contentsWithId(1))).not.toThrow();
  });
});

describe('initBrowserExtensions', () => {
  it('initBrowserExtensions passes license "GPL-3.0" and the browser session to ElectronChromeExtensions', async () => {
    await setup();

    expect(mocks.constructed).toHaveLength(1);
    expect(mocks.constructed[0]).toMatchObject({ license: 'GPL-3.0', session: browserSession });
  });

  it('installChromeWebStore is called with { session, autoUpdate: true }', async () => {
    await setup();

    expect(mocks.installChromeWebStore).toHaveBeenCalledWith({ session: browserSession, autoUpdate: true });
  });

  it('handleCRXProtocol is registered on session.defaultSession', async () => {
    await setup();

    expect(mocks.handleCRXProtocol).toHaveBeenCalledWith(mocks.defaultSession);
  });

  it('logs a failed Chrome Web Store setup and still returns working extensions', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    const failure = new Error('store down');
    mocks.installChromeWebStore.mockImplementation(() => Promise.reject(failure));

    const { extensions } = await setup();

    await vi.waitFor(() => expect(consoleError).toHaveBeenCalledWith(expect.any(String), failure));
    const contents = contentsWithId(1);
    extensions.addTab(contents);
    expect(mocks.addTab).toHaveBeenCalledWith(contents, mainWindow);
  });

  it('createTab emits openTab(url) and resolves with [attached contents, main window]', async () => {
    const { extensions, impl, openTab } = await setup();

    const created = impl.createTab({ url: 'https://a.test/' });
    expect(openTab).toHaveBeenCalledWith('https://a.test/');
    const contents = contentsWithId(5);
    extensions.addTab(contents);

    await expect(created).resolves.toEqual([contents, mainWindow]);
  });

  it('createTab allows an extension page and opens a blank tab when no url is given', async () => {
    const { extensions, impl, openTab } = await setup();

    const options = impl.createTab({ url: 'chrome-extension://abc/options.html' });
    const blank = impl.createTab({});
    extensions.addTab(contentsWithId(1));
    extensions.addTab(contentsWithId(2));

    await Promise.all([options, blank]);
    expect(openTab.mock.calls).toEqual([['chrome-extension://abc/options.html'], ['about:blank']]);
  });

  it('createTab rejects unsafe URLs without opening a tab', async () => {
    const { impl, openTab } = await setup();

    await expect(impl.createTab({ url: 'javascript:alert(1)' })).rejects.toThrow();
    await expect(impl.createTab({ url: 'file:///etc/passwd' })).rejects.toThrow();
    expect(openTab).not.toHaveBeenCalled();
  });

  it('createTab rejects when the main window is missing', async () => {
    const { impl, openTab } = await setup(() => null);

    await expect(impl.createTab({ url: 'https://a.test/' })).rejects.toThrow();
    expect(openTab).not.toHaveBeenCalled();
  });

  it('removeTab calls closeTab(webContents.id)', async () => {
    const { impl, closeTab } = await setup();

    impl.removeTab({ id: 42 }, mainWindow);

    expect(closeTab).toHaveBeenCalledWith(42);
  });

  it('addTab does not track a tab while the main window is missing', async () => {
    const { extensions } = await setup(() => null);

    extensions.addTab(contentsWithId(1));

    expect(mocks.addTab).not.toHaveBeenCalled();
  });

  it('forwards selectTab and getContextMenuItems to the library', async () => {
    const { extensions } = await setup();
    const contents = contentsWithId(1);
    const params = { x: 1 } as unknown as Electron.ContextMenuParams;

    extensions.selectTab(contents);
    const items = extensions.getContextMenuItems(contents, params);

    expect(mocks.selectTab).toHaveBeenCalledWith(contents);
    expect(mocks.getContextMenuItems).toHaveBeenCalledWith(contents, params);
    expect(items).toEqual([{ label: 'Ext item' }]);
  });
});
