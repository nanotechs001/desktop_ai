/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const shortcut = vi.hoisted(() => ({ emit: null as null | ((r: { webContentsId: number; action: string }) => void) }));

vi.mock('@/common', () => ({
  ipcBridge: {
    application: { reportBrowserWebContentsId: { invoke: vi.fn(() => Promise.resolve({ success: true })) } },
    browser: {
      getDownloads: { invoke: vi.fn(() => Promise.resolve({ success: true, data: [] })) },
      downloadsChanged: { on: () => () => {} },
      shortcut: {
        on: (handler: (r: { webContentsId: number; action: string }) => void) => {
          shortcut.emit = handler;
          return () => {};
        },
      },
      closeTabRequested: { on: () => () => {} },
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => ({ openBrowserTab: vi.fn() }),
}));

import BrowserViewer from '@/renderer/pages/conversation/Preview/browser/BrowserViewer';

const KEY = 'preview.browserChrome.crash';
const URL = 'https://example.com';

const stubs = {
  executeJavaScript: () => Promise.resolve(),
  getWebContentsId: () => 7,
  canGoBack: () => false,
  canGoForward: () => false,
  reload: vi.fn(),
  setZoomFactor: () => {},
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

const mount = () => {
  const { container } = render(
    <BrowserViewer url={URL} tabId='tab-1' onUrlChange={vi.fn()} onTitleChange={vi.fn()} onFaviconChange={vi.fn()} />
  );
  const webview = container.querySelector('webview') as HTMLElement;
  act(() => {
    webview.dispatchEvent(new Event('dom-ready'));
  });
  const emit = (type: string, details?: { reason: string }) =>
    act(() => {
      webview.dispatchEvent(Object.assign(new Event(type), details ? { details } : {}));
    });
  return { webview, emit };
};

describe('BrowserViewer crash recovery', () => {
  it('shows the crashed overlay after render-process-gone; Reload keeps it, loading, until did-finish-load', () => {
    const { emit } = mount();

    emit('render-process-gone', { reason: 'crashed' });
    expect(screen.getByRole('alert')).toBeTruthy();
    expect(screen.getByText(`${KEY}.crashed`)).toBeTruthy();
    expect(screen.getByText(`${KEY}.reload`).closest('button')?.className).not.toContain('arco-btn-loading');

    fireEvent.click(screen.getByText(`${KEY}.reload`));
    expect(stubs.reload).toHaveBeenCalledTimes(1);
    expect(screen.getByText(`${KEY}.crashed`)).toBeTruthy();
    expect(screen.getByText(`${KEY}.reload`).closest('button')?.className).toContain('arco-btn-loading');

    emit('did-finish-load');
    expect(screen.queryByText(`${KEY}.crashed`)).toBeNull();
  });

  it('a load finished any other way (nav bar, address bar) also clears the overlay', () => {
    const { emit } = mount();

    emit('render-process-gone', { reason: 'crashed' });
    emit('did-finish-load');

    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('crashing again during a reload stops the loading state and keeps the overlay', () => {
    const { emit } = mount();

    emit('render-process-gone', { reason: 'crashed' });
    fireEvent.click(screen.getByText(`${KEY}.reload`));
    emit('render-process-gone', { reason: 'crashed' });

    expect(screen.getByText(`${KEY}.crashed`)).toBeTruthy();
    expect(screen.getByText(`${KEY}.reload`).closest('button')?.className).not.toContain('arco-btn-loading');
  });

  it('moves focus to Reload when the overlay appears', () => {
    const { emit } = mount();

    emit('render-process-gone', { reason: 'crashed' });

    expect(document.activeElement).toBe(screen.getByText(`${KEY}.reload`).closest('button'));
  });

  it('a crash closes an open find bar', () => {
    const { emit } = mount();
    act(() => shortcut.emit?.({ webContentsId: 7, action: 'find' }));
    const placeholder = 'preview.browserChrome.find.placeholder';
    expect(screen.getByPlaceholderText(placeholder)).toBeTruthy();

    emit('render-process-gone', { reason: 'crashed' });

    expect(screen.queryByPlaceholderText(placeholder)).toBeNull();
  });

  it('a clean-exit shows no overlay', () => {
    const { emit } = mount();

    emit('render-process-gone', { reason: 'clean-exit' });

    expect(screen.queryByText(`${KEY}.crashed`)).toBeNull();
  });

  it('unresponsive shows the hang overlay; Wait and responsive both clear it', () => {
    const { emit } = mount();

    emit('unresponsive');
    expect(screen.getByText(`${KEY}.unresponsive`)).toBeTruthy();
    fireEvent.click(screen.getByText(`${KEY}.wait`));
    expect(screen.queryByText(`${KEY}.unresponsive`)).toBeNull();
    expect(stubs.reload).not.toHaveBeenCalled();

    emit('unresponsive');
    emit('responsive');
    expect(screen.queryByText(`${KEY}.unresponsive`)).toBeNull();
  });

  it('a crash while unresponsive switches to the crashed overlay', () => {
    const { emit } = mount();

    emit('unresponsive');
    emit('render-process-gone', { reason: 'oom' });

    expect(screen.getByText(`${KEY}.crashed`)).toBeTruthy();
    expect(screen.queryByText(`${KEY}.unresponsive`)).toBeNull();
  });

  it('a reload that throws falls back to re-assigning src and does not throw', () => {
    const { webview, emit } = mount();
    const assigned = vi.fn();
    Object.defineProperty(webview, 'src', { set: assigned, get: () => URL, configurable: true });
    stubs.reload.mockImplementationOnce(() => {
      throw new Error('guest is gone');
    });
    emit('render-process-gone', { reason: 'crashed' });

    expect(() => fireEvent.click(screen.getByText(`${KEY}.reload`))).not.toThrow();

    expect(assigned).toHaveBeenCalledWith(URL);
    emit('did-finish-load');
    expect(screen.queryByText(`${KEY}.crashed`)).toBeNull();
  });
});
