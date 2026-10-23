/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WebviewHost's Chrome-style address bar suggestions (from bookmarks and history) and the hovered-link status at the
 * bottom left. `<webview>` mounts as an HTMLUnknownElement under jsdom; its methods are stubbed on that prototype.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UrlSuggestion } from '@/common/types/browser';

vi.mock('@/common', () => ({
  ipcBridge: {
    application: { reportBrowserWebContentsId: { invoke: vi.fn(() => Promise.resolve({ success: true })) } },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import WebviewHost from '@/renderer/components/media/WebviewHost';

const WEBVIEW_STUBS = {
  executeJavaScript: () => Promise.resolve(),
  getWebContentsId: () => 7,
  getURL: () => 'https://start.test/',
  canGoBack: () => false,
  canGoForward: () => false,
  reload: () => {},
  setZoomFactor: () => {},
};

beforeEach(() => Object.assign(HTMLUnknownElement.prototype, WEBVIEW_STUBS));
afterEach(() => {
  cleanup();
  for (const name of Object.keys(WEBVIEW_STUBS)) {
    delete (HTMLUnknownElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

const SUGGESTIONS: UrlSuggestion[] = [
  { url: 'https://viziplatform.com/', title: 'Vizi Platform', bookmarked: true },
  { url: 'https://vizi.example/rare', title: 'Rare', bookmarked: false },
];

const renderHost = () => {
  const suggestUrls = vi.fn(async (_query: string) => SUGGESTIONS);
  const view = render(
    <WebviewHost url='https://start.test/' showNavBar interceptNavigation={false} suggestUrls={suggestUrls} />
  );
  const input = screen.getByPlaceholderText('preview.browser.addressPlaceholder') as HTMLInputElement;
  const webview = view.container.querySelector('webview') as HTMLElement;
  return { suggestUrls, input, webview };
};

describe('address bar suggestions', () => {
  it('suggests matching pages while the user types, bookmarks marked', async () => {
    const { suggestUrls, input } = renderHost();

    fireEvent.focus(input);
    expect(screen.queryByRole('listbox')).toBeNull(); // focusing alone suggests nothing
    fireEvent.change(input, { target: { value: 'vizi' } });

    expect(await screen.findByText('Vizi Platform')).toBeTruthy();
    expect(suggestUrls).toHaveBeenLastCalledWith('vizi');
    expect(screen.getAllByRole('option')).toHaveLength(2);
  });

  it('picks a suggestion with the arrow keys and Enter, loading it in the tab', async () => {
    const { input, webview } = renderHost();
    fireEvent.change(input, { target: { value: 'vizi' } });
    await screen.findByText('Rare');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(webview.getAttribute('src')).toBe('https://vizi.example/rare'));
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('loads a clicked suggestion, and Escape closes the list', async () => {
    const { input, webview } = renderHost();
    fireEvent.change(input, { target: { value: 'vizi' } });

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('listbox')).toBeNull();

    fireEvent.change(input, { target: { value: 'vizi ' } });
    fireEvent.click(await screen.findByText('Vizi Platform'));
    await waitFor(() => expect(webview.getAttribute('src')).toBe('https://viziplatform.com/'));
  });
});

describe('hovered link status', () => {
  it('shows the address of the link under the pointer at the bottom left, and hides it after', () => {
    const { webview } = renderHost();
    const hover = (url: string) =>
      act(() => {
        webview.dispatchEvent(Object.assign(new Event('update-target-url'), { url }));
      });

    hover('https://example.com/pricing');
    expect(screen.getByTestId('webview-link-status').textContent).toBe('https://example.com/pricing');

    hover('');
    expect(screen.queryByTestId('webview-link-status')).toBeNull();
  });
});
