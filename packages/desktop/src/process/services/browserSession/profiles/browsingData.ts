/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The browser's bookmarks and visit history, one of each for the whole app (like a Chrome profile's), kept as small
 * JSON files under userData. Only web pages (http/https) are ever kept. The address bar suggests from both; agents
 * may read the bookmarks.
 */
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import type { Bookmark, UrlSuggestion } from '@/common/types/browser';

export type Visit = { url: string; title: string; visits: number; lastVisit: number };

const MAX_BOOKMARKS = 500;
const MAX_TITLE_LENGTH = 300;
const DEFAULT_MAX_VISITS = 2000;
/** History is written at most this often while pages keep loading. */
const HISTORY_SAVE_DELAY_MS = 2000;

const isWebPage = (url: string): boolean => {
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

const cleanTitle = (title: unknown, url: string): string =>
  (typeof title === 'string' && title.trim() ? title.trim() : url).slice(0, MAX_TITLE_LENGTH);

/** Reads a JSON array; a missing or damaged file starts empty (logged when damaged). */
const readList = (file: string): unknown[] => {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf-8'));
    return Array.isArray(parsed) ? parsed : [];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
      console.warn(`[BrowsingData] ${file} is unreadable; starting it over:`, error);
    }
    return [];
  }
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null;

export function createBookmarkStore(file: string, now: () => number = Date.now) {
  let items: Bookmark[] = readList(file)
    .filter(isRecord)
    .filter((b) => typeof b.url === 'string' && isWebPage(b.url))
    .map((b) => ({
      url: b.url as string,
      title: cleanTitle(b.title, b.url as string),
      addedAt: typeof b.addedAt === 'number' ? b.addedAt : 0,
    }));
  const save = () => fs.writeFile(file, JSON.stringify(items));

  return {
    list: (): Bookmark[] => [...items],
    has: (url: string): boolean => items.some((b) => b.url === url),
    async add(url: string, title: string): Promise<void> {
      if (!isWebPage(url)) throw new Error('Only web pages (http or https) can be bookmarked');
      const existing = items.find((b) => b.url === url);
      if (existing) items = items.map((b) => (b.url === url ? { ...b, title: cleanTitle(title, url) } : b));
      else if (items.length >= MAX_BOOKMARKS) throw new Error(`At most ${MAX_BOOKMARKS} bookmarks`);
      else items = [...items, { url, title: cleanTitle(title, url), addedAt: now() }];
      await save();
    },
    async remove(url: string): Promise<void> {
      items = items.filter((b) => b.url !== url);
      await save();
    },
  };
}

export function createVisitHistory(
  file: string,
  { max = DEFAULT_MAX_VISITS, now = Date.now }: { max?: number; now?: () => number } = {}
) {
  let entries: Visit[] = readList(file)
    .filter(isRecord)
    .filter((v) => typeof v.url === 'string' && isWebPage(v.url))
    .map((v) => ({
      url: v.url as string,
      title: cleanTitle(v.title, v.url as string),
      visits: typeof v.visits === 'number' && v.visits > 0 ? v.visits : 1,
      lastVisit: typeof v.lastVisit === 'number' ? v.lastVisit : 0,
    }));
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const write = (): Promise<void> => {
    timer = null;
    const snapshot = JSON.stringify(entries);
    writing = writing
      .then(() => fs.writeFile(file, snapshot))
      .catch((error: unknown) => console.warn('[BrowsingData] could not save the browsing history:', error));
    return writing;
  };
  const scheduleSave = (): void => {
    if (!timer) timer = setTimeout(() => void write(), HISTORY_SAVE_DELAY_MS);
  };

  return {
    entries: (): Visit[] => [...entries],
    record(url: string, title?: string): void {
      if (!isWebPage(url)) return;
      const existing = entries.find((v) => v.url === url);
      const visit: Visit = existing
        ? {
            ...existing,
            visits: existing.visits + 1,
            lastVisit: now(),
            title: title ? cleanTitle(title, url) : existing.title,
          }
        : { url, title: cleanTitle(title, url), visits: 1, lastVisit: now() };
      const rest = entries.filter((v) => v.url !== url);
      // Oldest visits go first once over the cap.
      entries = [...rest, visit].toSorted((a, b) => a.lastVisit - b.lastVisit).slice(-max);
      scheduleSave();
    },
    setTitle(url: string, title: string): void {
      if (!entries.some((v) => v.url === url)) return;
      entries = entries.map((v) =>
        v.url === url ? { url, title: cleanTitle(title, url), visits: v.visits, lastVisit: v.lastVisit } : v
      );
      scheduleSave();
    },
    /** Writes any pending change now (tests, quit). */
    flush(): Promise<void> {
      if (timer) clearTimeout(timer);
      return write();
    },
  };
}

/** The address without its scheme and leading www., for matching what people type. */
const bareAddress = (url: string): string => url.replace(/^https?:\/\/(www\.)?/i, '').toLowerCase();

/**
 * Address bar suggestions for `query`: bookmarks first, then pages by visits and recency, each address once.
 * A match is the typed text anywhere in the address or the title, ranked higher when the address starts with it.
 */
export function suggestUrls(query: string, bookmarks: Bookmark[], visits: Visit[], limit: number): UrlSuggestion[] {
  const text = query.trim().toLowerCase();
  if (!text) return [];
  const matches = (url: string, title: string) => bareAddress(url).includes(text) || title.toLowerCase().includes(text);
  const prefix = (url: string) => (bareAddress(url).startsWith(text) ? 1 : 0);
  const marked = new Set(bookmarks.map((b) => b.url));
  const fromBookmarks = bookmarks
    .filter((b) => matches(b.url, b.title))
    .toSorted((a, b) => prefix(b.url) - prefix(a.url))
    .map((b) => ({ url: b.url, title: b.title, bookmarked: true }));
  const fromHistory = visits
    .filter((v) => !marked.has(v.url) && matches(v.url, v.title))
    .toSorted((a, b) => prefix(b.url) - prefix(a.url) || b.visits - a.visits || b.lastVisit - a.lastVisit)
    .map((v) => ({ url: v.url, title: v.title, bookmarked: false }));
  return [...fromBookmarks, ...fromHistory].slice(0, limit);
}
