/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Chrome-style address bar suggestions for WebviewHost: what the user is typing, matched against their bookmarks and
 * history (the caller supplies the lookup). Shown only while typing; arrow keys move the highlight, Enter opens it,
 * Escape closes the list (a second Escape is the address bar's own: back to the page's address).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { History, Star } from '@icon-park/react';
import type { UrlSuggestion } from '@/common/types/browser';

export type SuggestUrls = (query: string) => Promise<UrlSuggestion[]>;

/** Waits this long after the last keystroke before asking. */
const SUGGEST_DEBOUNCE_MS = 120;

/**
 * Suggestions for `query`, which is null while the user is not typing in the address bar.
 * `onKeyDown` handles the list's keys and reports whether it took the key.
 */
export function useUrlSuggestions(suggest: SuggestUrls | undefined, query: string | null) {
  const [items, setItems] = useState<UrlSuggestion[]>([]);
  const [highlight, setHighlight] = useState(-1);
  // The query the user dismissed with Escape: its late answer must not reopen the list.
  const dismissed = useRef<string | null>(null);

  useEffect(() => {
    setHighlight(-1);
    if (!suggest || query === null || !query.trim()) {
      setItems([]);
      return undefined;
    }
    let live = true;
    const timer = setTimeout(() => {
      suggest(query)
        .then((list) => {
          if (live && dismissed.current !== query) setItems(list);
        })
        .catch((error: unknown) => console.warn('[UrlSuggestions] could not look up suggestions:', error));
    }, SUGGEST_DEBOUNCE_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [suggest, query]);

  const close = useCallback(() => {
    dismissed.current = query;
    setItems([]);
    setHighlight(-1);
  }, [query]);

  const onKeyDown = (event: React.KeyboardEvent, pick: (url: string) => void): boolean => {
    if (items.length === 0) return false;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      // -1 is "nothing highlighted" (Enter goes to what was typed); the highlight wraps through it.
      setHighlight((current) => {
        const next = current + step;
        if (next >= items.length) return -1;
        return next < -1 ? items.length - 1 : next;
      });
      return true;
    }
    if (event.key === 'Enter' && highlight >= 0 && items[highlight]) {
      event.preventDefault();
      pick(items[highlight].url);
      close();
      return true;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      close();
      return true;
    }
    return false;
  };

  return { items, highlight, close, onKeyDown };
}

type UrlSuggestionListProps = {
  items: UrlSuggestion[];
  highlight: number;
  onPick: (url: string) => void;
};

/** The dropdown under the address bar. Rows keep the address bar's focus (mousedown is not let through). */
export const UrlSuggestionList: React.FC<UrlSuggestionListProps> = ({ items, highlight, onPick }) => {
  if (items.length === 0) return null;
  return (
    <div
      role='listbox'
      className='absolute start-0 end-0 top-full mt-4px z-30 bg-1 border border-solid border-[var(--border-base)] rd-8px py-4px shadow-lg'
    >
      {items.map((item, index) => (
        <div
          key={item.url}
          role='option'
          aria-selected={index === highlight}
          title={item.url}
          className={`flex items-center gap-8px px-10px h-30px cursor-pointer text-12px ${index === highlight ? 'bg-fill-2' : 'hover:bg-fill-1'}`}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onPick(item.url)}
        >
          {item.bookmarked ? (
            <Star theme='filled' size='12' fill='rgb(var(--warning-6))' className='flex-shrink-0' />
          ) : (
            <History theme='outline' size='12' className='flex-shrink-0 text-t-tertiary' />
          )}
          <span className='truncate text-t-primary'>{item.title}</span>
          <span className='truncate text-t-tertiary min-w-0 flex-1'>{item.url}</span>
        </div>
      ))}
    </div>
  );
};
