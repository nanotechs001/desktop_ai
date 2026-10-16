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
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    application: { reportBrowserWebContentsId: { invoke: vi.fn(() => Promise.resolve({ success: true })) } },
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
  canGoBack: () => false,
  canGoForward: () => false,
  reload: () => {},
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
