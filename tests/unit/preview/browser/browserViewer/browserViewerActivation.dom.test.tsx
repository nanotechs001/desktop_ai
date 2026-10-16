/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ report: vi.fn(() => Promise.resolve({ success: true })) }));

vi.mock('@/common', () => ({
  ipcBridge: {
    application: { reportBrowserWebContentsId: { invoke: mocks.report } },
    agentBrowser: {
      ownershipChanged: { on: () => () => {} },
      agentAction: { on: () => () => {} },
      getOwnership: { invoke: () => Promise.resolve({ success: true, data: [] }) },
    },
    browser: {
      getDownloads: { invoke: vi.fn(() => Promise.resolve({ success: true, data: [] })) },
      downloadsChanged: { on: () => () => {} },
      shortcut: { on: () => () => {} },
      closeTabRequested: { on: () => () => {} },
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => ({ openBrowserTab: vi.fn() }),
}));

import BrowserViewer from '@/renderer/pages/conversation/Preview/browser/BrowserViewer';

const stubs = {
  executeJavaScript: () => Promise.resolve(),
  getWebContentsId: () => 7,
  canGoBack: () => false,
  canGoForward: () => false,
  setZoomFactor: () => {},
  setAudioMuted: vi.fn(),
};

beforeEach(() => {
  Object.assign(HTMLUnknownElement.prototype, stubs);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  for (const name of Object.keys(stubs)) {
    delete (HTMLUnknownElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

const viewer = (active: boolean) => (
  <BrowserViewer
    url='https://example.com'
    tabId='tab-1'
    active={active}
    onUrlChange={vi.fn()}
    onTitleChange={vi.fn()}
    onFaviconChange={vi.fn()}
  />
);

describe('BrowserViewer tab activation', () => {
  it('reports its webContents id again each time its tab becomes active, not only on dom-ready', () => {
    const { container, rerender } = render(viewer(false));
    act(() => {
      container.querySelector('webview')?.dispatchEvent(new Event('dom-ready'));
    });
    mocks.report.mockClear();

    rerender(viewer(true));
    expect(mocks.report).toHaveBeenCalledWith({ webContentsId: 7 });

    mocks.report.mockClear();
    rerender(viewer(false));
    expect(mocks.report).not.toHaveBeenCalled();
    rerender(viewer(true));
    expect(mocks.report).toHaveBeenCalledTimes(1);
  });

  it('mutes its page while hidden and unmutes it when shown', () => {
    const { container, rerender } = render(viewer(false));
    act(() => {
      container.querySelector('webview')?.dispatchEvent(new Event('dom-ready'));
    });
    expect(stubs.setAudioMuted).toHaveBeenLastCalledWith(true);

    rerender(viewer(true));
    expect(stubs.setAudioMuted).toHaveBeenLastCalledWith(false);

    rerender(viewer(false));
    expect(stubs.setAudioMuted).toHaveBeenLastCalledWith(true);
  });

  it('does not report before the webview is ready', () => {
    render(viewer(true));

    expect(mocks.report).not.toHaveBeenCalled();
  });
});
