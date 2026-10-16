/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import FindBar from '@/renderer/pages/conversation/Preview/browser/BrowserChrome/FindBar';

const KEY = 'preview.browserChrome.find';

/** A stand-in for <webview>: a real element for events, plus the two find methods. */
const makeWebview = () =>
  Object.assign(document.createElement('div'), {
    findInPage: vi.fn(),
    stopFindInPage: vi.fn(),
    focus: vi.fn(),
  });

type FakeWebview = ReturnType<typeof makeWebview>;

const renderBar = (webview: FakeWebview, onClose = vi.fn()) => {
  render(<FindBar webview={webview as unknown as Electron.WebviewTag} onClose={onClose} focusToken={0} />);
  return { onClose, input: screen.getByPlaceholderText(`${KEY}.placeholder`) };
};

const found = (webview: FakeWebview, result: { activeMatchOrdinal: number; matches: number; finalUpdate: boolean }) =>
  act(() => {
    webview.dispatchEvent(Object.assign(new Event('found-in-page'), { result }));
  });

describe('FindBar', () => {
  let webview: FakeWebview;

  beforeEach(() => {
    webview = makeWebview();
  });
  afterEach(cleanup);

  it('typing calls webview.findInPage(text); Enter -> findNext:true; Shift+Enter -> forward:false', () => {
    const { input } = renderBar(webview);

    fireEvent.change(input, { target: { value: 'hello' } });
    expect(webview.findInPage).toHaveBeenLastCalledWith('hello');

    fireEvent.keyDown(input, { key: 'Enter' });
    expect(webview.findInPage).toHaveBeenLastCalledWith('hello', { findNext: true });

    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(webview.findInPage).toHaveBeenLastCalledWith('hello', { forward: false, findNext: true });
  });

  it('the previous and next buttons search backward and forward', () => {
    const { input } = renderBar(webview);
    fireEvent.change(input, { target: { value: 'hello' } });

    fireEvent.click(screen.getByLabelText(`${KEY}.next`));
    expect(webview.findInPage).toHaveBeenLastCalledWith('hello', { findNext: true });
    fireEvent.click(screen.getByLabelText(`${KEY}.previous`));
    expect(webview.findInPage).toHaveBeenLastCalledWith('hello', { forward: false, findNext: true });
  });

  it('clearing the text stops the search instead of searching for an empty string', () => {
    const { input } = renderBar(webview);
    fireEvent.change(input, { target: { value: 'a' } });
    webview.findInPage.mockClear();

    fireEvent.change(input, { target: { value: '' } });

    expect(webview.findInPage).not.toHaveBeenCalled();
    expect(webview.stopFindInPage).toHaveBeenCalledWith('clearSelection');
  });

  it('shows "<active> / <matches>" from the found-in-page event, and "no matches" at zero', () => {
    const { input } = renderBar(webview);
    fireEvent.change(input, { target: { value: 'hello' } });

    found(webview, { activeMatchOrdinal: 2, matches: 5, finalUpdate: true });
    expect(screen.getByText('2 / 5')).toBeTruthy();

    found(webview, { activeMatchOrdinal: 0, matches: 0, finalUpdate: true });
    expect(screen.getByText(`${KEY}.noMatches`)).toBeTruthy();
  });

  it('stops listening to found-in-page after unmount', () => {
    const removeSpy = vi.spyOn(webview, 'removeEventListener');
    const { unmount } = render(
      <FindBar webview={webview as unknown as Electron.WebviewTag} onClose={vi.fn()} focusToken={0} />
    );

    unmount();

    expect(removeSpy).toHaveBeenCalledWith('found-in-page', expect.any(Function));
  });

  it('Escape and the close button call stopFindInPage("clearSelection") and hide the bar', () => {
    const { input, onClose } = renderBar(webview);

    fireEvent.keyDown(input, { key: 'Escape' });
    expect(webview.stopFindInPage).toHaveBeenLastCalledWith('clearSelection');
    expect(onClose).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByLabelText(`${KEY}.close`));
    expect(webview.stopFindInPage).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledTimes(2);
  });
});
