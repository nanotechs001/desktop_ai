/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { Button, Message, Popover } from '@arco-design/web-react';
import { Bookmark, Close, Star } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { Bookmark as BookmarkEntry } from '@/common/types/browser';

const KEY = 'preview.browserChrome.bookmarks';
const isWebPage = (url: string): boolean => /^https?:\/\//i.test(url);

type BookmarksButtonProps = {
  /** The page on screen. */
  url: string;
  /** Its title, read when the user bookmarks it. */
  getTitle: () => string;
  /** Opens a bookmark in this tab. */
  onOpen: (url: string) => void;
};

/**
 * Nav-bar bookmarks, like Chrome's: a star that bookmarks (or un-bookmarks) the page on screen, and a menu of every
 * bookmark that opens one in this tab. One list for the whole app, kept in main; agents can read it too.
 */
const BookmarksButton: React.FC<BookmarksButtonProps> = ({ url, getTitle, onOpen }) => {
  const { t } = useTranslation();
  const [items, setItems] = useState<BookmarkEntry[]>([]);
  const [menuOpen, setMenuOpen] = useState(false);
  const gotEvent = useRef(false);

  useEffect(() => {
    const off = ipcBridge.browser.bookmarks.changed.on((next) => {
      gotEvent.current = true;
      setItems(next);
    });
    // A change that arrived first is newer than this read, so it wins.
    void ipcBridge.browser.bookmarks.list
      .invoke()
      .then((list) => {
        if (!gotEvent.current) setItems(list);
      })
      .catch((error: unknown) => console.warn('[BookmarksButton] could not read the bookmarks:', error));
    return off;
  }, []);

  const run = (request: Promise<{ success: boolean; msg?: string }>): void => {
    void request
      .then((res) => {
        if (!res.success) {
          console.warn('[BookmarksButton] bookmark change refused:', res.msg);
          Message.error(t(`${KEY}.failed`));
        }
      })
      .catch((error: unknown) => {
        console.warn('[BookmarksButton] bookmark change failed:', error);
        Message.error(t(`${KEY}.failed`));
      });
  };

  const bookmarked = items.some((item) => item.url === url);
  const toggle = (): void =>
    run(
      bookmarked
        ? ipcBridge.browser.bookmarks.remove.invoke({ url })
        : ipcBridge.browser.bookmarks.add.invoke({ url, title: getTitle() || url })
    );

  const content = (
    <div className='w-280px max-h-360px overflow-y-auto'>
      <div className='font-bold mb-8px'>{t(`${KEY}.menu`)}</div>
      {items.length === 0 ? (
        <div className='text-t-secondary'>{t(`${KEY}.empty`)}</div>
      ) : (
        items.map((item) => (
          <div key={item.url} className='flex items-center gap-4px'>
            <Button
              type='text'
              size='mini'
              long
              className='min-w-0 !justify-start'
              title={item.url}
              onClick={() => {
                setMenuOpen(false);
                onOpen(item.url);
              }}
            >
              <span className='truncate'>{item.title}</span>
            </Button>
            <Button
              type='text'
              size='mini'
              aria-label={t(`${KEY}.removeItem`)}
              icon={<Close theme='outline' size='12' />}
              onClick={() => run(ipcBridge.browser.bookmarks.remove.invoke({ url: item.url }))}
            />
          </div>
        ))
      )}
    </div>
  );

  return (
    <>
      {isWebPage(url) && (
        <Button
          type='text'
          size='mini'
          aria-label={t(bookmarked ? `${KEY}.remove` : `${KEY}.add`)}
          title={t(bookmarked ? `${KEY}.remove` : `${KEY}.add`)}
          aria-pressed={bookmarked}
          icon={
            <Star
              theme={bookmarked ? 'filled' : 'outline'}
              size='16'
              fill={bookmarked ? 'rgb(var(--warning-6))' : 'currentColor'}
            />
          }
          onClick={toggle}
        />
      )}
      <Popover trigger='click' position='br' content={content} popupVisible={menuOpen} onVisibleChange={setMenuOpen}>
        <Button
          type='text'
          size='mini'
          aria-label={t(`${KEY}.menu`)}
          title={t(`${KEY}.menu`)}
          icon={<Bookmark theme='outline' size='16' />}
        />
      </Popover>
    </>
  );
};

export default BookmarksButton;
