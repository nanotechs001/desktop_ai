/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserShortcutRequest } from '@/common/types/browser';

const mocks = vi.hoisted(() => ({
  openBrowserTab: vi.fn(),
  emit: null as ((request: BrowserShortcutRequest) => void) | null,
  closeTabRequested: null as ((request: { webContentsId: number }) => void) | null,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    application: { reportBrowserWebContentsId: { invoke: vi.fn(() => Promise.resolve({ success: true })) } },
    agentBrowser: {
      ownershipChanged: { on: () => () => {} },
      agentAction: { on: () => () => {} },
      getOwnership: { invoke: () => Promise.resolve({ success: true, data: [] }) },
    },
    browser: {
      getDownloads: { invoke: vi.fn(() => Promise.resolve({ success: true, data: [] })) },
      downloadsChanged: { on: () => () => {} },
      shortcut: {
        on: (handler: (request: BrowserShortcutRequest) => void) => {
          mocks.emit = handler;
          return () => {
            mocks.emit = null;
          };
        },
      },
      closeTabRequested: {
        on: (handler: (request: { webContentsId: number }) => void) => {
          mocks.closeTabRequested = handler;
          return () => {
            mocks.closeTabRequested = null;
          };
        },
      },
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => ({ openBrowserTab: mocks.openBrowserTab }),
}));

import BrowserViewer from '@/renderer/pages/conversation/Preview/browser/BrowserViewer';

const OWN_ID = 7;
const WEBVIEW_STUBS = {
  executeJavaScript: () => Promise.resolve(),
  getWebContentsId: () => OWN_ID,
  canGoBack: () => true,
  canGoForward: () => true,
  reload: vi.fn(),
  reloadIgnoringCache: vi.fn(),
  goBack: vi.fn(),
  goForward: vi.fn(),
  setZoomFactor: () => {},
  findInPage: vi.fn(),
  stopFindInPage: vi.fn(),
  focus: vi.fn(),
};

beforeEach(() => {
  Object.assign(HTMLUnknownElement.prototype, WEBVIEW_STUBS);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  for (const name of Object.keys(WEBVIEW_STUBS)) {
    delete (HTMLUnknownElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

const mount = () => {
  const onRequestClose = vi.fn();
  const { container } = render(
    <BrowserViewer
      url='https://example.com'
      tabId='tab-1'
      onUrlChange={vi.fn()}
      onTitleChange={vi.fn()}
      onFaviconChange={vi.fn()}
      onRequestClose={onRequestClose}
    />
  );
  act(() => {
    container.querySelector('webview')?.dispatchEvent(new Event('dom-ready'));
  });
  const send = (action: BrowserShortcutRequest['action'], webContentsId = OWN_ID) =>
    act(() => mocks.emit?.({ webContentsId, action }));
  return { onRequestClose, send };
};

describe('BrowserViewer shortcuts', () => {
  it('close-tab for its own webContents id closes this tab; another id is ignored', () => {
    const { onRequestClose, send } = mount();

    send('close-tab', OWN_ID + 1);
    expect(onRequestClose).not.toHaveBeenCalled();

    send('close-tab');
    expect(onRequestClose).toHaveBeenCalledWith('tab-1');
  });

  it('new-tab opens a blank browser tab, only for its own id', () => {
    const { send } = mount();

    send('new-tab', OWN_ID + 1);
    expect(mocks.openBrowserTab).not.toHaveBeenCalled();

    send('new-tab');
    expect(mocks.openBrowserTab).toHaveBeenCalledWith();
  });

  it('find shows the find bar and escape clears the search and hides it', () => {
    const { send } = mount();
    const placeholder = 'preview.browserChrome.find.placeholder';

    send('find');
    expect(screen.getByPlaceholderText(placeholder)).toBeTruthy();

    send('escape');
    expect(screen.queryByPlaceholderText(placeholder)).toBeNull();
    expect(WEBVIEW_STUBS.stopFindInPage).toHaveBeenCalledWith('clearSelection');
  });

  it('escape while the find bar is closed does nothing', () => {
    const { send } = mount();

    send('escape');

    expect(WEBVIEW_STUBS.stopFindInPage).not.toHaveBeenCalled();
    expect(WEBVIEW_STUBS.focus).not.toHaveBeenCalled();
  });

  it('a webview whose getWebContentsId throws never matches', () => {
    const { onRequestClose, send } = mount();
    const original = HTMLUnknownElement.prototype as unknown as { getWebContentsId: () => number };
    original.getWebContentsId = () => {
      throw new Error(
        'The WebView must be attached to the DOM and the dom-ready event emitted before this method can be called.'
      );
    };

    expect(() => send('close-tab')).not.toThrow();
    expect(onRequestClose).not.toHaveBeenCalled();
  });

  it('focus-address focuses the address bar input', () => {
    const { send } = mount();

    send('focus-address');

    expect(document.activeElement).toBe(screen.getByPlaceholderText('preview.browser.addressPlaceholder'));
  });
});

describe('BrowserViewer closeTabRequested', () => {
  it('closes this tab for its own webContents id and ignores another id', () => {
    const { onRequestClose } = mount();

    act(() => mocks.closeTabRequested?.({ webContentsId: OWN_ID + 1 }));
    expect(onRequestClose).not.toHaveBeenCalled();

    act(() => mocks.closeTabRequested?.({ webContentsId: OWN_ID }));
    expect(onRequestClose).toHaveBeenCalledWith('tab-1');
  });
});

describe('BrowserViewer shortcuts typed into its own controls', () => {
  // jsdom's user agent is not macOS, so the platform modifier is Ctrl.
  const press = (target: Element, key: string, init: Partial<KeyboardEventInit> = {}) => {
    const event = new KeyboardEvent('keydown', { key, ctrlKey: true, bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  };
  const addressBar = () => screen.getByPlaceholderText('preview.browser.addressPlaceholder');

  it('Cmd/Ctrl+R in the address bar reloads the page and does not reach the app', () => {
    mount();
    const appListener = vi.fn();
    document.addEventListener('keydown', appListener);

    const event = press(addressBar(), 'r');

    document.removeEventListener('keydown', appListener);
    expect(WEBVIEW_STUBS.reload).toHaveBeenCalledTimes(1);
    expect(event.defaultPrevented).toBe(true);
    expect(appListener).not.toHaveBeenCalled();
  });

  it('routes Shift+R, [, ], L, T, W and F to the tab', () => {
    const { onRequestClose } = mount();

    press(addressBar(), 'R', { shiftKey: true });
    press(addressBar(), '[');
    press(addressBar(), ']');
    press(addressBar(), 't');
    press(addressBar(), 'w');
    press(addressBar(), 'f');

    expect(WEBVIEW_STUBS.reloadIgnoringCache).toHaveBeenCalledTimes(1);
    expect(WEBVIEW_STUBS.goBack).toHaveBeenCalledTimes(1);
    expect(WEBVIEW_STUBS.goForward).toHaveBeenCalledTimes(1);
    expect(mocks.openBrowserTab).toHaveBeenCalledWith();
    expect(onRequestClose).toHaveBeenCalledWith('tab-1');
    const findInput = screen.getByPlaceholderText('preview.browserChrome.find.placeholder');
    expect(findInput).toBeTruthy();

    press(findInput, 'l');
    expect(document.activeElement).toBe(addressBar());
  });

  it('Cmd/Ctrl+R in the find bar reloads too', () => {
    const { send } = mount();
    send('find');

    press(screen.getByPlaceholderText('preview.browserChrome.find.placeholder'), 'r');

    expect(WEBVIEW_STUBS.reload).toHaveBeenCalledTimes(1);
  });

  it('leaves other keys and other chords alone', () => {
    mount();

    const plain = press(addressBar(), 'r', { ctrlKey: false });
    const withAlt = press(addressBar(), 'r', { altKey: true });
    const copy = press(addressBar(), 'c');
    const shiftT = press(addressBar(), 'T', { shiftKey: true });

    expect([plain, withAlt, copy, shiftT].map((e) => e.defaultPrevented)).toEqual([false, false, false, false]);
    expect(WEBVIEW_STUBS.reload).not.toHaveBeenCalled();
    expect(mocks.openBrowserTab).not.toHaveBeenCalled();
  });
});
