/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Bookmark } from '@/common/types/browser';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  add: vi.fn(() => Promise.resolve({ success: true })),
  remove: vi.fn(() => Promise.resolve({ success: true })),
  changed: null as ((items: Bookmark[]) => void) | null,
  messageError: vi.fn(),
}));

// Arco's imperative Message needs a legacy ReactDOM.render, which React 19 lacks in jsdom.
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...actual, Message: { ...actual.Message, error: mocks.messageError } };
});
vi.mock('@/common', () => ({
  ipcBridge: {
    browser: {
      bookmarks: {
        list: { invoke: mocks.list },
        add: { invoke: mocks.add },
        remove: { invoke: mocks.remove },
        changed: {
          on: (handler: (items: Bookmark[]) => void) => {
            mocks.changed = handler;
            return () => {};
          },
        },
      },
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import BookmarksButton from '@/renderer/pages/conversation/Preview/browser/BrowserChrome/BookmarksButton';

const KEY = 'preview.browserChrome.bookmarks';
const DOCS: Bookmark = { url: 'https://docs.example.com/', title: 'Docs', addedAt: 1 };

const renderButton = async (items: Bookmark[], url = 'https://page.test/') => {
  mocks.list.mockResolvedValue(items);
  const onOpen = vi.fn();
  render(<BookmarksButton url={url} getTitle={() => 'Page title'} onOpen={onOpen} />);
  await act(async () => {});
  return onOpen;
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.changed = null;
});
afterEach(cleanup);

describe('BookmarksButton', () => {
  it('bookmarks the page on screen with its title, from the star', async () => {
    await renderButton([]);

    fireEvent.click(screen.getByRole('button', { name: `${KEY}.add` }));

    expect(mocks.add).toHaveBeenCalledWith({ url: 'https://page.test/', title: 'Page title' });
  });

  it('shows a bookmarked page as such, and the star removes it', async () => {
    await renderButton([DOCS], DOCS.url);

    fireEvent.click(screen.getByRole('button', { name: `${KEY}.remove` }));

    expect(mocks.remove).toHaveBeenCalledWith({ url: DOCS.url });
  });

  it('has no star on a page that cannot be bookmarked', async () => {
    await renderButton([], 'about:blank');
    expect(screen.queryByRole('button', { name: `${KEY}.add` })).toBeNull();
  });

  it('lists the bookmarks, opens one in this tab, and follows changes from other tabs', async () => {
    const onOpen = await renderButton([DOCS]);

    fireEvent.click(screen.getByRole('button', { name: `${KEY}.menu` }));
    fireEvent.click(await screen.findByText('Docs'));
    expect(onOpen).toHaveBeenCalledWith(DOCS.url);

    act(() => mocks.changed?.([]));
    fireEvent.click(screen.getByRole('button', { name: `${KEY}.menu` }));
    expect(await screen.findByText(`${KEY}.empty`)).toBeTruthy();
  });

  it('says so when a bookmark could not be saved', async () => {
    mocks.add.mockResolvedValueOnce({ success: false, msg: 'disk full' } as never);
    await renderButton([]);

    fireEvent.click(screen.getByRole('button', { name: `${KEY}.add` }));
    await act(async () => {});

    expect(mocks.messageError).toHaveBeenCalledWith(`${KEY}.failed`);
  });
});
