/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  createBookmarkStore,
  createVisitHistory,
  suggestUrls,
} from '@process/services/browserSession/profiles/browsingData';

const tempFile = (name: string): string => path.join(mkdtempSync(path.join(os.tmpdir(), 'browsing-data-')), name);

describe('bookmarks', () => {
  it('adds, lists in the order added, renames on a second add, and removes by address', async () => {
    const file = tempFile('bookmarks.json');
    const store = createBookmarkStore(file, () => 100);

    await store.add('https://a.test/', 'A');
    await store.add('https://b.test/page', 'B');
    await store.add('https://a.test/', 'A renamed');
    expect(store.list().map((b) => [b.url, b.title])).toEqual([
      ['https://a.test/', 'A renamed'],
      ['https://b.test/page', 'B'],
    ]);

    await store.remove('https://a.test/');
    expect(store.list().map((b) => b.url)).toEqual(['https://b.test/page']);
    expect(
      createBookmarkStore(file)
        .list()
        .map((b) => b.url)
    ).toEqual(['https://b.test/page']); // stored
  });

  it('only keeps web pages, and survives a damaged file', async () => {
    const file = tempFile('bookmarks.json');
    writeFileSync(file, '{not json');
    const store = createBookmarkStore(file);
    expect(store.list()).toEqual([]);

    await expect(store.add('javascript:alert(1)', 'x')).rejects.toThrow();
    await expect(store.add('file:///etc/passwd', 'x')).rejects.toThrow();
    expect(store.list()).toEqual([]);
  });
});

describe('visit history', () => {
  it('counts visits to a page, keeps its title, and skips pages that are not on the web', () => {
    let clock = 1;
    const history = createVisitHistory(tempFile('history.json'), { now: () => clock++ });

    history.record('https://docs.example.com/guide', 'Guide');
    history.record('https://docs.example.com/guide');
    history.record('about:blank');
    history.record('chrome-extension://abc/popup.html');

    expect(history.entries()).toEqual([
      { url: 'https://docs.example.com/guide', title: 'Guide', visits: 2, lastVisit: 2 },
    ]);
  });

  it('forgets the least recently visited pages beyond its cap', () => {
    let clock = 1;
    const history = createVisitHistory(tempFile('history.json'), { max: 2, now: () => clock++ });
    history.record('https://one.test/');
    history.record('https://two.test/');
    history.record('https://one.test/');
    history.record('https://three.test/');

    expect(history.entries().map((e) => e.url)).toEqual(['https://one.test/', 'https://three.test/']);
  });

  it('is written to disk, and read back', async () => {
    const file = tempFile('history.json');
    const history = createVisitHistory(file, { now: () => 5 });
    history.record('https://kept.test/', 'Kept');
    await history.flush();

    expect(JSON.parse(readFileSync(file, 'utf-8'))).toHaveLength(1);
    expect(
      createVisitHistory(file)
        .entries()
        .map((e) => e.url)
    ).toEqual(['https://kept.test/']);
  });
});

describe('address bar suggestions', () => {
  it('matches the typed text in address or title: bookmarks, then addresses starting with it, then the most visited', () => {
    const bookmarks = [{ url: 'https://viziplatform.com/', title: 'Vizi Platform', addedAt: 1 }];
    const visits = [
      { url: 'https://viziplatform.com/', title: 'Vizi Platform', visits: 1, lastVisit: 1 },
      { url: 'https://hoxieveterinaryservice.viziglobal.com/', title: 'Hoxie Vet', visits: 9, lastVisit: 2 },
      { url: 'https://vizi.example/rare', title: 'Rare', visits: 1, lastVisit: 3 },
      { url: 'https://mail.google.com/', title: 'Inbox', visits: 50, lastVisit: 4 },
    ];

    const found = suggestUrls('vizi', bookmarks, visits, 8);

    // An address that starts with the text (what you are typing) beats one that only contains it, like Chrome.
    expect(found.map((s) => [s.url, s.bookmarked])).toEqual([
      ['https://viziplatform.com/', true],
      ['https://vizi.example/rare', false],
      ['https://hoxieveterinaryservice.viziglobal.com/', false],
    ]);
    expect(suggestUrls('inbox', bookmarks, visits, 8).map((s) => s.url)).toEqual(['https://mail.google.com/']);
    expect(suggestUrls('  ', bookmarks, visits, 8)).toEqual([]);
    expect(suggestUrls('vizi', bookmarks, visits, 1)).toHaveLength(1);
  });
});
