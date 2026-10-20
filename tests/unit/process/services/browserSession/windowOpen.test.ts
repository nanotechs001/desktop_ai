/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type FakeWindow = {
  options: Electron.BrowserWindowConstructorOptions;
  webContents: { id: number };
  handlers: Map<string, (...args: unknown[]) => void>;
};

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  windows: [] as FakeWindow[],
  showMessageBoxSync: vi.fn(() => 0),
  showMessageBox: vi.fn((_owner: unknown, _options: Electron.MessageBoxOptions) =>
    Promise.resolve({ response: 1, checkboxChecked: false })
  ),
  fromWebContents: vi.fn((_contents: unknown): unknown => null),
}));

vi.mock('@process/services/browserSession/contextMenu/contextMenuInstall', () => ({
  loadTranslate: () => Promise.resolve((key: string) => key),
}));

vi.mock('@/common', () => ({ ipcBridge: { browser: { openTabRequested: { emit: mocks.emit } } } }));
vi.mock('electron', () => ({
  dialog: { showMessageBoxSync: mocks.showMessageBoxSync, showMessageBox: mocks.showMessageBox },
  BrowserWindow: class {
    static fromWebContents = mocks.fromWebContents;
    options: Electron.BrowserWindowConstructorOptions;
    webContents: { id: number };
    handlers = new Map<string, (...args: unknown[]) => void>();
    constructor(options: Electron.BrowserWindowConstructorOptions) {
      this.options = options;
      this.webContents = (options.webContents as unknown as { id: number }) ?? { id: 0 };
      Object.assign(this.webContents, { getURL: this.getURL });
      mocks.windows.push(this);
    }
    getURL = () => 'https://login.example.com/oauth?x=1';
    on(event: string, handler: (...args: unknown[]) => void) {
      this.handlers.set(event, handler);
      return this;
    }
    setTitle = vi.fn();
  },
  screen: {
    getDisplayMatching: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
    getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }),
  },
}));

import {
  OpenLimiter,
  classifyWindowOpen,
  installBeforeUnloadDialog,
  popupTitle,
  installWindowOpenHandler,
  popupWindowOptions,
  setWindowOpenHooks,
} from '@process/services/browserSession/windowOpen';
import { agentPartition, rememberBrowserSession } from '@process/services/browserSession/profiles/browserProfiles';

const PERSONAL = 'persist:aionui-browser';
/** Browser contents always live in a set-up browser session; this one is Personal's. */
const personalSession = {} as Electron.Session;
rememberBrowserSession(PERSONAL, personalSession);

const classify = (url: string, disposition: string, features = '') =>
  classifyWindowOpen({ url, disposition, features });

const boom = (): never => {
  throw new Error('boom');
};

beforeEach(() => {
  mocks.emit.mockClear();
  mocks.windows.length = 0;
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
  const WORK_AREA = { x: 0, y: 0, width: 1920, height: 1080 };
  const makeParent = (bounds = { x: 100, y: 50, width: 1000, height: 800 }) =>
    ({ getBounds: () => bounds }) as unknown as Electron.BrowserWindow;
  const WEB_PREFERENCES = {
    partition: 'persist:aionui-browser',
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
  };

  it('clamps 3000x50 to 1400x300, uses the browser partition and centers on the parent', () => {
    const parent = makeParent();

    const options = popupWindowOptions({ width: 3000, height: 50 }, parent, WORK_AREA, PERSONAL);

    expect(options).toEqual({
      parent,
      width: 1400,
      height: 300,
      x: 0,
      y: 300,
      autoHideMenuBar: true,
      webPreferences: WEB_PREFERENCES,
    });
  });

  it('is an allowlist: no other window option is ever set', () => {
    const options = popupWindowOptions({ width: 500, height: 600 }, makeParent(), WORK_AREA, PERSONAL);

    expect(Object.keys(options).sort()).toEqual(
      ['autoHideMenuBar', 'height', 'parent', 'webPreferences', 'width', 'x', 'y'].sort()
    );
  });

  it('keeps the popup inside the parent display work area', () => {
    const workArea = { x: 1920, y: 25, width: 1280, height: 775 };
    const offscreenParent = makeParent({ x: 3000, y: 700, width: 600, height: 400 });

    const options = popupWindowOptions({ width: 1400, height: 1000 }, offscreenParent, workArea, PERSONAL);

    expect(options).toMatchObject({ width: 1280, height: 775, x: 1920, y: 25 });
  });

  it('pins a centred popup to the work area edge when the parent hangs off-screen', () => {
    const parent = makeParent({ x: -900, y: -500, width: 1000, height: 800 });

    expect(popupWindowOptions({ width: 500, height: 600 }, parent, WORK_AREA, PERSONAL)).toMatchObject({ x: 0, y: 0 });
  });

  it('leaves position to the OS without a parent', () => {
    const options = popupWindowOptions({ width: 500, height: 600 }, null, WORK_AREA, PERSONAL);

    expect(options.x).toBeUndefined();
    expect(options.y).toBeUndefined();
    expect(options.parent).toBeUndefined();
  });

  it('clamps the small end of width and the large end of height', () => {
    expect(popupWindowOptions({ width: 10, height: 5000 }, null, WORK_AREA, PERSONAL)).toMatchObject({
      width: 400,
      height: 1000,
    });
  });

  it('keeps an in-range size', () => {
    expect(popupWindowOptions({ width: 500, height: 600 }, null, WORK_AREA, PERSONAL)).toMatchObject({
      width: 500,
      height: 600,
    });
  });
});

describe('installWindowOpenHandler', () => {
  type PopupResult = {
    action: string;
    overrideBrowserWindowOptions?: Electron.BrowserWindowConstructorOptions;
    createWindow?: (options: Electron.BrowserWindowConstructorOptions) => Electron.WebContents;
  };
  type Handler = (details: { url: string; disposition: string; features: string }) => PopupResult;

  const install = (parent: { isDestroyed: () => boolean } | null, limiter = new OpenLimiter(), id = 1) => {
    const setWindowOpenHandler = vi.fn();
    installWindowOpenHandler(
      { id, setWindowOpenHandler, session: personalSession } as unknown as Electron.WebContents,
      () => parent as unknown as Electron.BrowserWindow | null,
      limiter
    );
    expect(setWindowOpenHandler).toHaveBeenCalledTimes(1);
    return setWindowOpenHandler.mock.calls[0][0] as Handler;
  };
  const liveParent = () => ({ isDestroyed: () => false, getBounds: () => ({ x: 0, y: 0, width: 1000, height: 800 }) });

  it('asks the renderer for a tab and denies the native window', () => {
    const handler = install(null);

    const result = handler({ url: 'https://a.test/', disposition: 'background-tab', features: '' });

    expect(result).toEqual({ action: 'deny' });
    expect(mocks.emit).toHaveBeenCalledWith({
      url: 'https://a.test/',
      background: true,
      profile: { kind: 'personal' },
    });
  });

  it("opens an Agent profile page's tabs and popups in that Agent's profile", () => {
    const partition = agentPartition('bare:42');
    const agentSession = {} as Electron.Session;
    rememberBrowserSession(partition, agentSession);
    const setWindowOpenHandler = vi.fn();
    installWindowOpenHandler(
      { id: 7, setWindowOpenHandler, session: agentSession } as unknown as Electron.WebContents,
      () => null,
      new OpenLimiter()
    );
    const handler = setWindowOpenHandler.mock.calls[0][0] as Handler;

    handler({ url: 'https://a.test/', disposition: 'foreground-tab', features: '' });
    const popup = handler({ url: 'https://a.test/', disposition: 'new-window', features: 'popup' });

    expect(mocks.emit).toHaveBeenCalledWith({
      url: 'https://a.test/',
      background: false,
      profile: { kind: 'agent', agentId: 'bare:42' },
    });
    expect(popup.overrideBrowserWindowOptions?.webPreferences?.partition).toBe(partition);
  });

  it('denies popups from a page whose session is not a browser profile', () => {
    const setWindowOpenHandler = vi.fn();
    installWindowOpenHandler(
      { id: 8, setWindowOpenHandler, session: {} } as unknown as Electron.WebContents,
      () => null,
      new OpenLimiter()
    );
    const handler = setWindowOpenHandler.mock.calls[0][0] as Handler;

    expect(handler({ url: 'https://a.test/', disposition: 'new-window', features: 'popup' })).toEqual({
      action: 'deny',
    });
  });

  it('allows a popup as a child window of the parent on the browser partition', () => {
    const parent = liveParent();
    const handler = install(parent);

    const result = handler({ url: 'https://a.test/', disposition: 'new-window', features: 'width=500,height=600' });

    expect(result.action).toBe('allow');
    expect(result.overrideBrowserWindowOptions).toEqual({
      webPreferences: expect.objectContaining({ partition: 'persist:aionui-browser', sandbox: true }),
    });
    const guest = { id: 9 };
    result.createWindow?.({ webContents: guest as unknown as Electron.WebContents });
    expect(mocks.windows.at(-1)?.options).toMatchObject({ parent, width: 500, height: 600, webContents: guest });
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('builds the popup window from our options only: page features never reach it', () => {
    const handler = install(liveParent());
    const result = handler({ url: 'https://a.test/', disposition: 'new-window', features: 'width=500,height=600' });
    const guest = { id: 9 } as unknown as Electron.WebContents;
    // What Electron hands createWindow: the page's parsed features merged into the options.
    const pageFeatures = { show: false, opacity: 0.01, minWidth: 5000, type: 'panel', titleBarStyle: 'hidden' };

    const created = result.createWindow?.({
      ...pageFeatures,
      webContents: guest,
    } as Electron.BrowserWindowConstructorOptions);

    const { options } = mocks.windows.at(-1) as { options: Record<string, unknown> };
    for (const key of Object.keys(pageFeatures)) expect(options).not.toHaveProperty(key);
    expect(created).toBe(mocks.windows.at(-1)?.webContents);
  });

  it('does not parent a popup to a destroyed window', () => {
    const handler = install({ isDestroyed: () => true });

    const result = handler({ url: 'https://a.test/', disposition: 'new-window', features: 'popup' });
    result.createWindow?.({ webContents: { id: 9 } as unknown as Electron.WebContents });

    expect(result.action).toBe('allow');
    expect(mocks.windows.at(-1)?.options.parent).toBeUndefined();
  });

  it('tells the agent-browser hooks about a tab request and a popup, and sends the chat they name', () => {
    const tabRequested = vi.fn((_openerId: number, _url: string, _partition: string | null) => ({
      conversationId: 'conv-1',
    }));
    const popupCreated = vi.fn();
    setWindowOpenHooks({ tabRequested, popupCreated });
    try {
      const handler = install(liveParent(), new OpenLimiter(), 4);

      handler({ url: 'https://a.test/', disposition: 'foreground-tab', features: '' });
      const result = handler({ url: 'https://b.test/', disposition: 'new-window', features: 'popup' });
      const created = result.createWindow?.({ webContents: { id: 12 } as unknown as Electron.WebContents });

      expect(tabRequested).toHaveBeenCalledWith(4, 'https://a.test/', PERSONAL);
      expect(mocks.emit).toHaveBeenCalledWith({
        url: 'https://a.test/',
        background: false,
        profile: { kind: 'personal' },
        conversationId: 'conv-1',
      });
      expect(popupCreated).toHaveBeenCalledWith(4, created);
    } finally {
      setWindowOpenHooks({});
    }
  });

  it('still opens the tab and the popup when a hook throws', () => {
    setWindowOpenHooks({ tabRequested: boom, popupCreated: boom });
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const handler = install(liveParent());

      handler({ url: 'https://a.test/', disposition: 'foreground-tab', features: '' });
      const result = handler({ url: 'https://b.test/', disposition: 'new-window', features: 'popup' });
      const created = result.createWindow?.({ webContents: { id: 13 } as unknown as Electron.WebContents });

      expect(mocks.emit).toHaveBeenCalledWith({
        url: 'https://a.test/',
        background: false,
        profile: { kind: 'personal' },
      });
      expect(created).toEqual({ id: 13, getURL: expect.any(Function) });
    } finally {
      setWindowOpenHooks({});
      error.mockRestore();
    }
  });

  it('denies an unsafe scheme without opening anything', () => {
    const handler = install(null);

    expect(handler({ url: 'javascript:alert(1)', disposition: 'foreground-tab', features: '' })).toEqual({
      action: 'deny',
    });
    expect(mocks.emit).not.toHaveBeenCalled();
  });
});

describe('OpenLimiter', () => {
  it('allows 2 open popups per opener; closing one frees a slot', () => {
    const limiter = new OpenLimiter();
    const release = limiter.reservePopup(1);
    limiter.reservePopup(1);

    expect(limiter.canOpenPopup(1)).toBe(false);
    expect(limiter.canOpenPopup(2)).toBe(true);
    release();
    expect(limiter.canOpenPopup(1)).toBe(true);
  });

  it('allows 5 open popups in total across openers', () => {
    const limiter = new OpenLimiter();
    [1, 1, 2, 2, 3].forEach((opener) => limiter.reservePopup(opener));

    expect(limiter.canOpenPopup(4)).toBe(false);
  });

  it('a release is idempotent', () => {
    const limiter = new OpenLimiter();
    const release = limiter.reservePopup(1);
    limiter.reservePopup(1);
    release();
    release();

    expect(limiter.canOpenPopup(1)).toBe(true);
    limiter.reservePopup(1);
    expect(limiter.canOpenPopup(1)).toBe(false);
  });

  it('allows 3 tab opens per opener in 10 s, then again once the window has passed', () => {
    const limiter = new OpenLimiter();

    expect([0, 1000, 2000].map((t) => limiter.tryOpenTab(1, t))).toEqual([true, true, true]);
    expect(limiter.tryOpenTab(1, 9_999)).toBe(false);
    expect(limiter.tryOpenTab(2, 9_999)).toBe(true);
    expect(limiter.tryOpenTab(1, 10_000)).toBe(true);
  });
});

describe('installWindowOpenHandler popup blocking', () => {
  type Handler = (details: { url: string; disposition: string; features: string }) => {
    action: string;
    createWindow?: (options: Electron.BrowserWindowConstructorOptions) => Electron.WebContents;
  };
  const install = (limiter: OpenLimiter, id = 1) => {
    const setWindowOpenHandler = vi.fn();
    installWindowOpenHandler(
      { id, setWindowOpenHandler, session: personalSession } as unknown as Electron.WebContents,
      () => null,
      limiter
    );
    return setWindowOpenHandler.mock.calls[0][0] as Handler;
  };
  const popup = { url: 'https://a.test/', disposition: 'new-window', features: 'popup' };
  const tab = { url: 'https://a.test/', disposition: 'foreground-tab', features: '' };

  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  it('denies a third popup from the same page until one closes', () => {
    const handler = install(new OpenLimiter());
    const first = handler(popup);
    first.createWindow?.({ webContents: { id: 10 } as unknown as Electron.WebContents });
    handler(popup).createWindow?.({ webContents: { id: 11 } as unknown as Electron.WebContents });

    expect(handler(popup)).toEqual({ action: 'deny' });
    mocks.windows[0].handlers.get('closed')?.();
    expect(handler(popup).action).toBe('allow');
  });

  it('a burst of window.open calls is capped before any window exists', () => {
    const handler = install(new OpenLimiter());

    const actions = [1, 2, 3, 4].map(() => handler(popup).action);

    expect(actions).toEqual(['allow', 'allow', 'deny', 'deny']);
  });

  it('denies a fourth tab within 10 s and logs it', () => {
    const handler = install(new OpenLimiter());

    [1, 2, 3].forEach(() => handler(tab));
    expect(handler(tab)).toEqual({ action: 'deny' });

    expect(mocks.emit).toHaveBeenCalledTimes(3);
    expect(console.warn).toHaveBeenCalled();
  });
});

describe('installBeforeUnloadDialog', () => {
  const owner = { isDestroyed: () => false };
  const mainWindow = { isDestroyed: () => false };

  const installOn = async (contents: Record<string, unknown>) => {
    const handlers = new Map<string, (event: { preventDefault: () => void }) => void>();
    const target = {
      id: 1,
      ...contents,
      on: (event: string, handler: (event: { preventDefault: () => void }) => void) => handlers.set(event, handler),
      once: vi.fn(),
    };
    installBeforeUnloadDialog(
      target as unknown as Electron.WebContents,
      () => mainWindow as unknown as Electron.BrowserWindow
    );
    // Translations load asynchronously once; the dialog needs them.
    await vi.waitFor(() => expect(handlers.has('will-prevent-unload')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fire = () => {
      const event = { preventDefault: vi.fn() };
      handlers.get('will-prevent-unload')?.(event);
      return event;
    };
    return { fire };
  };

  beforeEach(() => {
    mocks.showMessageBoxSync.mockReset();
    mocks.showMessageBox.mockClear();
    mocks.fromWebContents.mockReset();
    setWindowOpenHooks({});
  });

  it('asks "Leave site?" on the window that hosts the webview; Leave lets the page go', async () => {
    const host = { id: 1 };
    mocks.fromWebContents.mockImplementation((contents) => (contents === host ? owner : null));
    mocks.showMessageBoxSync.mockReturnValue(0);
    const { fire } = await installOn({ hostWebContents: host });

    const event = fire();

    expect(event.preventDefault).toHaveBeenCalled();
    const [parent, options] = mocks.showMessageBoxSync.mock.calls[0] as unknown as [
      unknown,
      Electron.MessageBoxSyncOptions,
    ];
    expect(parent).toBe(owner);
    expect(options).toMatchObject({
      message: 'preview.browserChrome.leave.title',
      detail: 'preview.browserChrome.leave.detail',
      buttons: ['preview.browserChrome.leave.leave', 'preview.browserChrome.leave.stay'],
      cancelId: 1,
    });
  });

  it('Stay keeps the page (no preventDefault)', async () => {
    mocks.fromWebContents.mockReturnValue(owner);
    mocks.showMessageBoxSync.mockReturnValue(1);
    const { fire } = await installOn({});

    expect(fire().preventDefault).not.toHaveBeenCalled();
  });

  it('falls back to the main window when no window owns the page', async () => {
    mocks.fromWebContents.mockReturnValue(null);
    mocks.showMessageBoxSync.mockReturnValue(0);
    const { fire } = await installOn({});

    fire();

    expect(mocks.showMessageBoxSync.mock.calls[0][0]).toBe(mainWindow);
  });
});

describe('installBeforeUnloadDialog with agent browser control', () => {
  const owner = { isDestroyed: () => false };
  let nextId = 100;

  /** A tab whose beforeunload blocks a load; `pendingUrl` is the uncommitted address `getURL()` shows. */
  const blockedTab = async (pendingUrl: string | null = null) => {
    const handlers = new Map<string, (event: { preventDefault: () => void }, input?: unknown) => void>();
    const destroyed = new Set<() => void>();
    const committed = 'https://editor.test/doc';
    const tab = {
      id: nextId++,
      getURL: () => pendingUrl ?? committed,
      mainFrame: { url: committed },
      isDestroyed: () => false,
      loadURL: vi.fn(() => Promise.resolve()),
      on: (event: string, handler: (event: { preventDefault: () => void }) => void) => handlers.set(event, handler),
      once: (event: string, handler: () => void) => {
        if (event === 'destroyed') destroyed.add(handler);
      },
      removeListener: (event: string, handler: () => void) => {
        if (event === 'destroyed') destroyed.delete(handler);
      },
      destroy: () => destroyed.forEach((handler) => handler()),
      keyDown: (key: string) =>
        handlers.get('before-input-event')?.({ preventDefault: () => {} }, { type: 'keyDown', key, code: `Key${key}` }),
    };
    installBeforeUnloadDialog(tab as unknown as Electron.WebContents, () => null);
    await vi.waitFor(() => expect(handlers.has('will-prevent-unload')).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const fire = () => {
      const event = { preventDefault: vi.fn() };
      handlers.get('will-prevent-unload')?.(event);
      return event;
    };
    return { tab, fire };
  };

  /** A chat ask the test answers; `signal` is what the dialog passed it. */
  const chatAsk = () => {
    let answer: (leave: boolean) => void = () => {};
    const seen: { signal: AbortSignal | null } = { signal: null };
    const askChat = vi.fn(
      (signal: AbortSignal) =>
        new Promise<boolean>((resolve) => {
          seen.signal = signal;
          answer = resolve;
        })
    );
    return { askChat, seen, answer: (leave: boolean) => answer(leave) };
  };

  /** The desktop box stays open until the test answers it or its signal closes it (as Stay). */
  const desktopBox = () => {
    let answer: (response: number) => void = () => {};
    mocks.showMessageBox.mockImplementationOnce(
      (_owner, options) =>
        new Promise((resolve) => {
          answer = (response) => resolve({ response, checkboxChecked: false });
          options.signal?.addEventListener('abort', () => resolve({ response: 1, checkboxChecked: false }));
        })
    );
    return { leave: () => answer(0) };
  };

  beforeEach(() => {
    mocks.showMessageBoxSync.mockReset();
    mocks.showMessageBox.mockClear();
    mocks.fromWebContents.mockReset();
    mocks.fromWebContents.mockReturnValue(owner);
  });

  afterEach(() => setWindowOpenHooks({}));

  it("lets an agent's own tab leave without any dialog", async () => {
    setWindowOpenHooks({ unloadBlocked: () => ({ kind: 'leave' }) });
    const { fire } = await blockedTab();

    expect(fire().preventDefault).toHaveBeenCalled();
    expect(mocks.showMessageBoxSync).not.toHaveBeenCalled();
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('asks a tab no chat drives with the blocking desktop box, as before', async () => {
    const unloadBlocked = vi.fn(() => ({ kind: 'ask' as const }));
    setWindowOpenHooks({ unloadBlocked });
    mocks.showMessageBoxSync.mockReturnValue(1);
    const { tab, fire } = await blockedTab();

    expect(fire().preventDefault).not.toHaveBeenCalled();
    expect(unloadBlocked).toHaveBeenCalledWith(tab.id);
    expect(mocks.showMessageBoxSync).toHaveBeenCalledTimes(1);
    expect(mocks.showMessageBox).not.toHaveBeenCalled();
  });

  it('keeps the page, asks on the desktop and in the chat; a chat Leave closes the box and runs the load again', async () => {
    const chat = chatAsk();
    setWindowOpenHooks({ unloadBlocked: () => ({ kind: 'ask', askChat: chat.askChat }) });
    desktopBox();
    const { tab, fire } = await blockedTab('https://elsewhere.test/next');

    expect(fire().preventDefault).not.toHaveBeenCalled();
    expect(mocks.showMessageBoxSync).not.toHaveBeenCalled();
    const [parent, options] = mocks.showMessageBox.mock.calls[0];
    expect(parent).toBe(owner);
    expect(options).toMatchObject({ message: 'preview.browserChrome.leave.title', cancelId: 1 });
    // A second attempt while the ask is open does not ask again.
    expect(fire().preventDefault).not.toHaveBeenCalled();
    expect(chat.askChat).toHaveBeenCalledTimes(1);

    chat.answer(true);
    await vi.waitFor(() => expect(tab.loadURL).toHaveBeenCalledWith('https://elsewhere.test/next'));
    expect(options.signal?.aborted).toBe(true);
    // The re-run load passes the page's beforeunload once; the next one asks again.
    expect(fire().preventDefault).toHaveBeenCalled();
    desktopBox();
    expect(fire().preventDefault).not.toHaveBeenCalled();
    expect(chat.askChat).toHaveBeenCalledTimes(2);
  });

  it('a desktop Leave withdraws the chat ask; with no known target the next attempt leaves unasked', async () => {
    const chat = chatAsk();
    setWindowOpenHooks({ unloadBlocked: () => ({ kind: 'ask', askChat: chat.askChat }) });
    const box = desktopBox();
    const { tab, fire } = await blockedTab();
    fire();

    box.leave();
    await vi.waitFor(() => expect(chat.seen.signal?.aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(tab.loadURL).not.toHaveBeenCalled();
    expect(fire().preventDefault).toHaveBeenCalled();
  });

  it('Stay in the chat keeps the page and grants nothing', async () => {
    const chat = chatAsk();
    setWindowOpenHooks({ unloadBlocked: () => ({ kind: 'ask', askChat: chat.askChat }) });
    desktopBox();
    const { tab, fire } = await blockedTab('https://elsewhere.test/next');
    fire();

    chat.answer(false);
    await vi.waitFor(() => expect(mocks.showMessageBox.mock.calls[0][1].signal?.aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(tab.loadURL).not.toHaveBeenCalled();
    desktopBox();
    expect(fire().preventDefault).not.toHaveBeenCalled();
  });

  it('closes the box and the chat card when the tab goes away', async () => {
    const chat = chatAsk();
    setWindowOpenHooks({ unloadBlocked: () => ({ kind: 'ask', askChat: chat.askChat }) });
    desktopBox();
    const { tab, fire } = await blockedTab();
    fire();

    tab.destroy();

    expect(chat.seen.signal?.aborted).toBe(true);
    expect(mocks.showMessageBox.mock.calls[0][1].signal?.aborted).toBe(true);
  });

  it("forgets a granted Leave at the user's next key, not at the agent's", async () => {
    const chat = chatAsk();
    const agentKeys = new Set(['A']);
    setWindowOpenHooks({
      unloadBlocked: () => ({ kind: 'ask', askChat: chat.askChat }),
      isAgentKey: (_id, { key }) => agentKeys.has(key),
    });
    desktopBox();
    const { tab, fire } = await blockedTab();
    fire();
    chat.answer(true);
    await vi.waitFor(() => expect(mocks.showMessageBox.mock.calls[0][1].signal?.aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));

    tab.keyDown('A'); // the agent's own key: the Leave still holds
    tab.keyDown('B'); // the user typed: the next attempt asks again
    desktopBox();

    expect(fire().preventDefault).not.toHaveBeenCalled();
    expect(chat.askChat).toHaveBeenCalledTimes(2);
  });

  it("keeps a granted Leave through the agent's key", async () => {
    const chat = chatAsk();
    setWindowOpenHooks({
      unloadBlocked: () => ({ kind: 'ask', askChat: chat.askChat }),
      isAgentKey: () => true,
    });
    desktopBox();
    const { tab, fire } = await blockedTab();
    fire();
    chat.answer(true);
    await vi.waitFor(() => expect(mocks.showMessageBox.mock.calls[0][1].signal?.aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));

    tab.keyDown('A');

    expect(fire().preventDefault).toHaveBeenCalled();
  });

  it('forgets an unused Leave after 15 s', async () => {
    const chat = chatAsk();
    setWindowOpenHooks({ unloadBlocked: () => ({ kind: 'ask', askChat: chat.askChat }) });
    desktopBox();
    const { fire } = await blockedTab();
    fire();
    chat.answer(true);
    await vi.waitFor(() => expect(mocks.showMessageBox.mock.calls[0][1].signal?.aborted).toBe(true));
    await new Promise((resolve) => setTimeout(resolve, 0));

    const later = Date.now() + 15_001;
    vi.spyOn(Date, 'now').mockReturnValue(later);
    desktopBox();
    try {
      expect(fire().preventDefault).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe('popup window title', () => {
  it('popupTitle appends the origin of the page', () => {
    expect(popupTitle('Sign in', 'https://login.example.com/oauth?x=1')).toBe('Sign in — https://login.example.com');
    expect(popupTitle('Blank', 'about:blank')).toBe('Blank — about:blank');
  });

  it("a popup's window title always shows the page origin, whatever the page sets", () => {
    const setWindowOpenHandler = vi.fn();
    installWindowOpenHandler(
      { id: 1, setWindowOpenHandler, session: personalSession } as unknown as Electron.WebContents,
      () => null,
      new OpenLimiter()
    );
    const handler = setWindowOpenHandler.mock.calls[0][0] as (details: {
      url: string;
      disposition: string;
      features: string;
    }) => { createWindow?: (options: Electron.BrowserWindowConstructorOptions) => Electron.WebContents };
    handler({ url: 'https://login.example.com/', disposition: 'new-window', features: 'popup' }).createWindow?.({
      webContents: { id: 10 } as unknown as Electron.WebContents,
    } as Electron.BrowserWindowConstructorOptions);
    const popup = mocks.windows.at(-1) as FakeWindow & { setTitle: ReturnType<typeof vi.fn> };
    const event = { preventDefault: vi.fn() };

    popup.handlers.get('page-title-updated')?.(event, 'Your bank — https://bank.test');

    expect(event.preventDefault).toHaveBeenCalled();
    expect(popup.setTitle).toHaveBeenCalledWith('Your bank — https://bank.test — https://login.example.com');
  });
});
