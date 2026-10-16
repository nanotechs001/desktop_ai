/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  emit: vi.fn(),
  popup: vi.fn(),
  buildFromTemplate: vi.fn(),
  fromWebContents: vi.fn(),
  writeText: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: { fromWebContents: mocks.fromWebContents },
  Menu: { buildFromTemplate: mocks.buildFromTemplate },
  clipboard: { writeText: mocks.writeText },
}));
vi.mock('@/common', () => ({ ipcBridge: { browser: { openTabRequested: { emit: mocks.emit } } } }));
vi.mock('@process/services/i18n', () => ({
  default: { t: (key: string, options?: { text: string }) => (options ? `${key}|${options.text}` : key) },
  i18nReady: Promise.resolve(),
}));

import { installContextMenu } from '@process/services/browserSession/contextMenuInstall';

type Template = { label?: string; type?: string; enabled?: boolean; click?: () => void };
type Params = Parameters<Parameters<Electron.WebContents['on']>[1]>;

const PARAMS = {
  x: 10,
  y: 20,
  linkURL: '',
  srcURL: '',
  mediaType: 'none',
  selectionText: '',
  isEditable: false,
  misspelledWord: '',
  dictionarySuggestions: [],
  editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true },
};

const makeContents = () => {
  const handlers = new Map<string, (...args: unknown[]) => void>();
  const host = { id: 'host' };
  const contents = {
    hostWebContents: host,
    session: { addWordToSpellCheckerDictionary: vi.fn() },
    navigationHistory: { canGoBack: () => true, canGoForward: () => false, goBack: vi.fn() },
    on: (name: string, handler: (...args: unknown[]) => void) => handlers.set(name, handler),
    isDestroyed: () => false,
    inspectElement: vi.fn(),
    copyImageAt: vi.fn(),
    downloadURL: vi.fn(),
  };
  const fire = (overrides: Record<string, unknown>) => handlers.get('context-menu')?.({}, { ...PARAMS, ...overrides } as unknown as Params);
  return { contents, host, fire };
};

const popupWindow = { isDestroyed: () => false };
const mainWindow = { isDestroyed: () => false };

const install = (extra?: () => Electron.MenuItemConstructorOptions[]) => {
  const stub = makeContents();
  installContextMenu(stub.contents as unknown as Electron.WebContents, () => mainWindow as unknown as Electron.BrowserWindow, extra);
  return stub;
};

const lastTemplate = (): Template[] => mocks.buildFromTemplate.mock.calls.at(-1)?.[0] ?? [];
const clickItem = (label: string) => lastTemplate().find((item) => item.label === label)?.click?.();

beforeEach(() => {
  vi.clearAllMocks();
  mocks.buildFromTemplate.mockReturnValue({ popup: mocks.popup });
  mocks.fromWebContents.mockReturnValue(popupWindow);
});

describe('installContextMenu', () => {
  it('builds a menu on a context-menu event and pops it up on the window that owns the contents', async () => {
    const { fire, host } = install();
    fire({});
    await vi.waitFor(() => expect(mocks.popup).toHaveBeenCalledTimes(1));
    expect(mocks.fromWebContents).toHaveBeenCalledWith(host);
    expect(mocks.popup).toHaveBeenCalledWith({ window: popupWindow });
    expect(lastTemplate().map((item) => item.label ?? item.type)).toEqual([
      'preview.browserChrome.menu.back',
      'preview.browserChrome.menu.forward',
      'preview.browserChrome.menu.reload',
      'separator',
      'preview.browserChrome.menu.inspect',
    ]);
  });

  it('falls back to the main window when the owner cannot be resolved', async () => {
    mocks.fromWebContents.mockReturnValue(null);
    const { fire } = install();
    fire({});
    await vi.waitFor(() => expect(mocks.popup).toHaveBeenCalledWith({ window: mainWindow }));
  });

  it('opens the link in a new tab when "Open link in new tab" is clicked', async () => {
    const { fire } = install();
    fire({ linkURL: 'https://a.test/page' });
    await vi.waitFor(() => expect(mocks.popup).toHaveBeenCalled());
    clickItem('preview.browserChrome.menu.openLinkInNewTab');
    expect(mocks.emit).toHaveBeenCalledWith({ url: 'https://a.test/page', background: false });
  });

  it('offers no Open entry for a javascript: link', async () => {
    const { fire } = install();
    fire({ linkURL: 'javascript:alert(1)' });
    await vi.waitFor(() => expect(mocks.popup).toHaveBeenCalled());
    expect(lastTemplate().map((item) => item.label)).not.toContain('preview.browserChrome.menu.openLinkInNewTab');
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('searches Google with the trimmed, URL-encoded selection capped at 500 characters', async () => {
    const { fire } = install();
    fire({ selectionText: `  a b&c${'x'.repeat(600)}` });
    await vi.waitFor(() => expect(mocks.popup).toHaveBeenCalled());
    const label = lastTemplate().find((item) => item.label?.startsWith('preview.browserChrome.menu.searchSelection'))?.label;
    clickItem(label ?? '');
    const query = `a b&c${'x'.repeat(600)}`.slice(0, 500);
    expect(mocks.emit).toHaveBeenCalledWith({
      url: `https://www.google.com/search?q=${encodeURIComponent(query)}`,
      background: false,
    });
  });

  it('maps copy link, inspect, save image and add-to-dictionary to their Electron calls', async () => {
    const { fire, contents } = install();
    fire({ linkURL: 'https://a.test/', mediaType: 'image', srcURL: 'https://a.test/i.png' });
    await vi.waitFor(() => expect(mocks.popup).toHaveBeenCalled());
    clickItem('preview.browserChrome.menu.copyLink');
    clickItem('preview.browserChrome.menu.copyImage');
    clickItem('preview.browserChrome.menu.saveImageAs');
    clickItem('preview.browserChrome.menu.inspect');
    expect(mocks.writeText).toHaveBeenCalledWith('https://a.test/');
    expect(contents.copyImageAt).toHaveBeenCalledWith(10, 20);
    expect(contents.downloadURL).toHaveBeenCalledWith('https://a.test/i.png');
    expect(contents.inspectElement).toHaveBeenCalledWith(10, 20);

    fire({ isEditable: true, misspelledWord: 'helo' });
    await vi.waitFor(() => expect(mocks.popup).toHaveBeenCalledTimes(2));
    clickItem('preview.browserChrome.menu.addToDictionary');
    expect(contents.session.addWordToSpellCheckerDictionary).toHaveBeenCalledWith('helo');
  });

  it('appends extension items after the built-in ones', async () => {
    const { fire } = install(() => [{ label: 'Ext item' }]);
    fire({});
    await vi.waitFor(() => expect(mocks.popup).toHaveBeenCalled());
    const labels = lastTemplate().map((item) => item.label ?? item.type);
    expect(labels.slice(-2)).toEqual(['separator', 'Ext item']);
  });
});
