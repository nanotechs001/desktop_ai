/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  report: vi.fn(() => Promise.resolve({ success: true })),
  closeHandlers: new Set<(request: { webContentsId: number }) => void>(),
  ownership: [] as unknown[],
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    application: { reportBrowserWebContentsId: { invoke: mocks.report } },
    agentBrowser: {
      ownershipChanged: { on: () => () => {} },
      agentAction: { on: () => () => {} },
      getOwnership: { invoke: () => Promise.resolve({ success: true, data: mocks.ownership }) },
    },
    browser: {
      getDownloads: { invoke: vi.fn(() => Promise.resolve({ success: true, data: [] })) },
      downloadsChanged: { on: () => () => {} },
      // BrowserViewer mounts BookmarksButton and asks for address bar suggestions.
      bookmarks: { list: { invoke: () => Promise.resolve([]) }, changed: { on: () => () => {} } },
      suggestUrls: { invoke: () => Promise.resolve([]) },
      shortcut: { on: () => () => {} },
      closeTabRequested: {
        on: (handler: (request: { webContentsId: number }) => void) => {
          mocks.closeHandlers.add(handler);
          return () => mocks.closeHandlers.delete(handler);
        },
      },
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
};

beforeEach(() => {
  Object.assign(HTMLUnknownElement.prototype, stubs);
});

afterEach(() => {
  mocks.ownership = [];
  cleanup();
  vi.clearAllMocks();
  for (const name of Object.keys(stubs)) {
    delete (HTMLUnknownElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

const viewer = (
  active: boolean,
  onRequestClose?: (tabId: string, options?: { byUser?: boolean }) => void,
  agentOwnedHint?: boolean
) => (
  <BrowserViewer
    agentOwnedHint={agentOwnedHint}
    onRequestClose={onRequestClose}
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

  it('honours a close request once its webview is attached, before the page is dom-ready', () => {
    const onRequestClose = vi.fn();
    const { container } = render(viewer(true, onRequestClose));
    act(() => {
      container.querySelector('webview')?.dispatchEvent(new Event('did-attach'));
    });

    act(() => mocks.closeHandlers.forEach((handler) => handler({ webContentsId: 7 })));

    expect(onRequestClose).toHaveBeenCalledWith('tab-1', { byUser: false });
  });

  it('honours a close request that arrived before its webview was attached, once it is', () => {
    const onRequestClose = vi.fn();
    const { container } = render(viewer(true, onRequestClose));
    act(() => mocks.closeHandlers.forEach((handler) => handler({ webContentsId: 8 }))); // another tab's
    act(() => mocks.closeHandlers.forEach((handler) => handler({ webContentsId: 7 })));
    expect(onRequestClose).not.toHaveBeenCalled();

    act(() => {
      container.querySelector('webview')?.dispatchEvent(new Event('did-attach'));
    });

    expect(onRequestClose).toHaveBeenCalledTimes(1);
    expect(onRequestClose).toHaveBeenCalledWith('tab-1', { byUser: false });
  });

  it('keeps a hidden user tab invisible and inert, out of reach of the keyboard', async () => {
    const { container } = render(viewer(false));
    act(() => {
      container.querySelector('webview')?.dispatchEvent(new Event('dom-ready'));
    });

    const root = container.firstElementChild as HTMLElement;
    expect(root.hasAttribute('inert')).toBe(true);
    expect(root.style.visibility).toBe('hidden');
    expect(container.querySelector('webview')?.getAttribute('tabindex')).toBe('-1');
  });

  it('never makes a hidden agent tab inert (agent input must reach it), only takes it out of the tab order', async () => {
    mocks.ownership = [{ webContentsId: 7, owner: { clientId: 'c', label: 'claude' }, sharedWith: null }];
    const { container, rerender } = render(viewer(false));
    act(() => {
      container.querySelector('webview')?.dispatchEvent(new Event('dom-ready'));
    });
    await waitFor(() => expect(container.firstElementChild?.hasAttribute('inert')).toBe(false));
    expect(container.querySelector('webview')?.getAttribute('tabindex')).toBe('-1');
    // Chromium routes agent (CDP) mouse input by hit-testing the window: the page must stay rendered and
    // hit-testable (covered, transparent), never visibility:hidden or pointer-events:none.
    const root = container.firstElementChild as HTMLElement;
    expect([root.style.visibility, root.style.opacity, root.style.pointerEvents]).toEqual(['visible', '0', 'auto']);

    rerender(viewer(true));
    expect([root.style.visibility, root.style.opacity, root.style.pointerEvents]).toEqual(['', '', '']);
    expect(container.querySelector('webview')?.hasAttribute('tabindex')).toBe(false);
  });

  it('never makes a hidden tab the user shared with agents inert', async () => {
    mocks.ownership = [{ webContentsId: 7, owner: 'user', sharedWith: 'all' }];
    const { container } = render(viewer(false));
    act(() => {
      container.querySelector('webview')?.dispatchEvent(new Event('dom-ready'));
    });
    await waitFor(() => expect(container.firstElementChild?.hasAttribute('inert')).toBe(false));
  });

  it('keeps the chrome of a hidden agent tab inert, but never the page, and hides the tab from screen readers', async () => {
    mocks.ownership = [{ webContentsId: 7, owner: { clientId: 'c', label: 'claude' }, sharedWith: null }];
    const { container, rerender } = render(viewer(false));
    const webview = container.querySelector('webview') as HTMLElement;
    act(() => {
      webview.dispatchEvent(new Event('dom-ready'));
    });
    await waitFor(() => expect(container.firstElementChild?.hasAttribute('inert')).toBe(false));
    const root = container.firstElementChild as HTMLElement;
    const controls = [...container.querySelectorAll<HTMLElement>('.aion-url-viewer-toolbar button, input')];
    expect(controls.length).toBeGreaterThan(3);

    // jsdom does not implement inert; in Chromium an element under [inert] cannot take focus.
    expect(controls.every((control) => control.closest('[inert]') !== null)).toBe(true);
    expect(webview.closest('[inert]')).toBeNull(); // inert would also stop hit-testing for agent input
    expect(root.getAttribute('aria-hidden')).toBe('true');

    rerender(viewer(true));
    expect(container.querySelector('[inert]')).toBeNull();
    expect(root.hasAttribute('aria-hidden')).toBe(false);
  });

  it('hides a hidden user tab from screen readers, and only while hidden', () => {
    const { container, rerender } = render(viewer(false));
    const root = container.firstElementChild as HTMLElement;
    expect(root.getAttribute('aria-hidden')).toBe('true');

    rerender(viewer(true));
    expect(root.hasAttribute('aria-hidden')).toBe(false);
  });

  it('treats a tab the context created for an agent as agent-reachable before any ownership is known', () => {
    const { container } = render(viewer(false, undefined, true));

    const root = container.firstElementChild as HTMLElement;
    expect(root.hasAttribute('inert')).toBe(false);
    expect([root.style.visibility, root.style.opacity, root.style.pointerEvents]).toEqual(['visible', '0', 'auto']);
  });

  it('does not report before the webview is ready', () => {
    render(viewer(true));

    expect(mocks.report).not.toHaveBeenCalled();
  });
});
