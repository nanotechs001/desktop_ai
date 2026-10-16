/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Impl = {
  createTab: (details: { url?: string }) => Promise<[unknown, unknown]>;
  removeTab: (tab: { id: number }, window: unknown) => void;
};

const mocks = vi.hoisted(() => ({
  defaultSession: { name: 'default', webRequest: { onBeforeRequest: vi.fn() } },
  setSessionPartitionResolver: vi.fn(),
  constructed: [] as Array<Record<string, unknown>>,
  addTab: vi.fn(),
  selectTab: vi.fn(),
  getContextMenuItems: vi.fn(() => [{ label: 'Ext item' }]),
  handleCRXProtocol: vi.fn(),
  installChromeWebStore: vi.fn(() => Promise.resolve()),
  showMessageBox: vi.fn(() => Promise.resolve({ response: 1 })),
}));

vi.mock('electron', () => ({
  session: { defaultSession: mocks.defaultSession },
  dialog: { showMessageBox: mocks.showMessageBox },
}));
vi.mock('@process/services/browserSession/contextMenuInstall', () => ({
  loadTranslate: () =>
    Promise.resolve((key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key
    ),
}));

vi.mock('electron-chrome-extensions', () => ({
  setSessionPartitionResolver: mocks.setSessionPartitionResolver,
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

import {
  createBeforeInstall,
  describeInstall,
  initBrowserExtensions,
  isWebStoreUrl,
} from '@process/services/browserSession/extensions';

const browserSession = { name: 'browser' } as unknown as Electron.Session;
const mainWindow = { isDestroyed: () => false, webContents: { id: 1 } } as unknown as Electron.BrowserWindow;
const contentsWithId = (id: number) => Object.assign(new EventEmitter(), { id }) as unknown as Electron.WebContents;
/** The tab's first main-frame navigation, which pairs it with the createTab that asked for its url. */
const navigate = (contents: Electron.WebContents, url: string) =>
  (contents as unknown as EventEmitter).emit('did-start-navigation', { url, isMainFrame: true });

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

describe('initBrowserExtensions', () => {
  it('initBrowserExtensions passes license "GPL-3.0" and the browser session to ElectronChromeExtensions', async () => {
    await setup();

    expect(mocks.constructed).toHaveLength(1);
    expect(mocks.constructed[0]).toMatchObject({ license: 'GPL-3.0', session: browserSession });
  });

  it('installChromeWebStore is called with { session, autoUpdate: true }', async () => {
    await setup();

    expect(mocks.installChromeWebStore).toHaveBeenCalledWith({
      session: browserSession,
      autoUpdate: true,
      beforeInstall: expect.any(Function),
    });
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
    navigate(contents, 'https://a.test/');

    await expect(created).resolves.toEqual([contents, mainWindow]);
  });

  it('createTab allows an extension page and opens a blank tab when no url is given', async () => {
    const { extensions, impl, openTab } = await setup();

    const options = impl.createTab({ url: 'chrome-extension://abc/options.html' });
    const blank = impl.createTab({});
    const blankTab = contentsWithId(1);
    const optionsTab = contentsWithId(2);
    extensions.addTab(blankTab);
    extensions.addTab(optionsTab);
    navigate(blankTab, 'about:blank');
    navigate(optionsTab, 'chrome-extension://abc/options.html');

    await expect(options).resolves.toEqual([optionsTab, mainWindow]);
    await expect(blank).resolves.toEqual([blankTab, mainWindow]);
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

type InstallDetails = Parameters<ReturnType<typeof createBeforeInstall>>[0];

const installDetails = (frameUrl: string, manifest: Record<string, unknown> = {}): InstallDetails =>
  ({
    id: 'abcdefghijklmnopabcdefghijklmnop',
    localizedName: 'Good Ext',
    manifest: { name: 'Good Ext', version: '1', manifest_version: 3, ...manifest },
    frame: { url: frameUrl, isDestroyed: () => false },
  }) as unknown as InstallDetails;

describe('isWebStoreUrl', () => {
  it('accepts only https://chromewebstore.google.com, by exact host', () => {
    expect(isWebStoreUrl('https://chromewebstore.google.com/detail/x/abc')).toBe(true);
    expect(isWebStoreUrl('https://chromewebstore.google.com')).toBe(true);
  });

  it.each([
    'https://chromewebstore.google.com.evil.test/detail/x',
    'https://chromewebstore.google.comevil.test/',
    'http://chromewebstore.google.com/',
    'https://chromewebstore.google.com:8443/',
    'https://evil.test/?u=https://chromewebstore.google.com',
    'https://user@evil.test/',
    'not a url',
    '',
  ])('rejects %s', (url) => {
    expect(isWebStoreUrl(url)).toBe(false);
  });
});

describe('describeInstall', () => {
  it('splits API permissions from host access, including MV2 host permissions and content script matches', () => {
    const prompt = describeInstall({
      name: 'X',
      version: '1',
      manifest_version: 2,
      permissions: ['storage', 'tabs', '<all_urls>', 'https://*.example.com/*', 'storage'],
      host_permissions: ['https://a.test/*'],
      content_scripts: [{ matches: ['https://a.test/*', 'https://b.test/*'], js: ['c.js'] }],
    } as unknown as chrome.runtime.Manifest);

    expect(prompt).toEqual({
      permissions: ['storage', 'tabs'],
      hostPermissions: ['<all_urls>', 'https://*.example.com/*', 'https://a.test/*', 'https://b.test/*'],
    });
  });

  it('returns empty lists when the manifest asks for nothing', () => {
    expect(describeInstall({ name: 'X', version: '1', manifest_version: 3 })).toEqual({
      permissions: [],
      hostPermissions: [],
    });
  });
});

describe('createBeforeInstall', () => {
  it('asks with the extension name and permissions, and allows only when the user confirms', async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const beforeInstall = createBeforeInstall(confirm);

    const result = await beforeInstall(
      installDetails('https://chromewebstore.google.com/detail/good/abc', { permissions: ['storage'] })
    );

    expect(result).toEqual({ action: 'allow' });
    expect(confirm).toHaveBeenCalledWith({ name: 'Good Ext', permissions: ['storage'], hostPermissions: [] });
  });

  it('denies when the user cancels', async () => {
    const beforeInstall = createBeforeInstall(() => Promise.resolve(false));

    await expect(beforeInstall(installDetails('https://chromewebstore.google.com/detail/x'))).resolves.toEqual({
      action: 'deny',
    });
  });

  it('denies a lookalike-domain request without asking', async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const beforeInstall = createBeforeInstall(confirm);

    const result = await beforeInstall(installDetails('https://chromewebstore.google.com.evil.test/detail/x'));

    expect(result).toEqual({ action: 'deny' });
    expect(confirm).not.toHaveBeenCalled();
  });

  it('denies when the requesting frame is gone', async () => {
    const confirm = vi.fn(() => Promise.resolve(true));
    const details = {
      ...installDetails('https://chromewebstore.google.com/'),
      frame: { url: 'https://chromewebstore.google.com/', isDestroyed: () => true },
    } as unknown as InstallDetails;

    await expect(createBeforeInstall(confirm)(details)).resolves.toEqual({ action: 'deny' });
    expect(confirm).not.toHaveBeenCalled();
  });
});

describe('web store install dialog', () => {
  const installHook = async () => {
    await setup();
    const [[options]] = mocks.installChromeWebStore.mock.calls as unknown as [
      [{ beforeInstall: ReturnType<typeof createBeforeInstall> }],
    ];
    return options.beforeInstall;
  };

  it('shows a native Add / Cancel dialog on the main window; Add installs', async () => {
    mocks.showMessageBox.mockResolvedValueOnce({ response: 0 });
    const beforeInstall = await installHook();

    const result = await beforeInstall(
      installDetails('https://chromewebstore.google.com/detail/x', { host_permissions: ['https://a.test/*'] })
    );

    expect(result).toEqual({ action: 'allow' });
    const [parent, options] = mocks.showMessageBox.mock.calls[0] as unknown as [unknown, Electron.MessageBoxOptions];
    expect(parent).toBe(mainWindow);
    expect(options.message).toContain('Good Ext');
    expect(options.detail).toContain('https://a.test/*');
    expect(options.buttons).toHaveLength(2);
    expect(options.cancelId).toBe(1);
    expect(options.defaultId).toBe(1);
  });

  it('Cancel (or closing the dialog) does not install', async () => {
    mocks.showMessageBox.mockResolvedValueOnce({ response: 1 });
    const beforeInstall = await installHook();

    await expect(beforeInstall(installDetails('https://chromewebstore.google.com/detail/x'))).resolves.toEqual({
      action: 'deny',
    });
  });
});

describe('crx:// on the default session', () => {
  type CrxListener = (
    details: { url: string; webContentsId?: number },
    callback: (response: { cancel?: boolean }) => void
  ) => void;

  const crxListener = async (getMainWindow?: () => Electron.BrowserWindow | null) => {
    await setup(getMainWindow);
    return mocks.defaultSession.webRequest.onBeforeRequest.mock.calls[0][0] as CrxListener;
  };
  const decide = (listener: CrxListener, url: string, webContentsId?: number) => {
    const callback = vi.fn();
    listener({ url, webContentsId }, callback);
    return callback.mock.calls[0][0] as { cancel?: boolean };
  };

  it('lets the AionUi window load extension icons', async () => {
    const listener = await crxListener();

    expect(decide(listener, 'crx://extension-icon/abc/32/1?partition=persist:aionui-browser', 1)).toEqual({
      cancel: false,
    });
  });

  it('cancels crx:// from any other page, from no page, and when the main window is gone', async () => {
    const listener = await crxListener();
    expect(decide(listener, 'crx://extension-icon/abc/32/1', 2)).toEqual({ cancel: true });
    expect(decide(listener, 'crx://extension-icon/abc/32/1')).toEqual({ cancel: true });

    vi.clearAllMocks();
    const orphaned = await crxListener(() => null);
    expect(decide(orphaned, 'crx://extension-icon/abc/32/1', 1)).toEqual({ cancel: true });
  });

  it('leaves every other request alone', async () => {
    const listener = await crxListener();

    expect(decide(listener, 'https://a.test/', 2)).toEqual({});
    expect(decide(listener, 'http://localhost:5173/main.js', 1)).toEqual({});
  });

  it('resolves only the browser partition for <browser-action-list>', async () => {
    await setup();
    const resolve = mocks.setSessionPartitionResolver.mock.calls[0][0] as (partition: string) => Electron.Session;

    expect(resolve('persist:aionui-browser')).toBe(browserSession);
    expect(() => resolve('persist:anything-else')).toThrow();
    expect(() => resolve('')).toThrow();
  });
});
