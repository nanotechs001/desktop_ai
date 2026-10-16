/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import {
  buildContextMenuEntries,
  type ContextMenuParams,
  type MenuEntry,
} from '@process/services/browserSession/contextMenu/contextMenu';

const ALL_FLAGS = { canCut: true, canCopy: true, canPaste: true, canSelectAll: true };

const params = (overrides: Partial<ContextMenuParams> = {}): ContextMenuParams => ({
  linkURL: '',
  srcURL: '',
  mediaType: 'none',
  selectionText: '',
  isEditable: false,
  misspelledWord: '',
  dictionarySuggestions: [],
  editFlags: ALL_FLAGS,
  ...overrides,
});

const NAV = { canGoBack: true, canGoForward: false };
const t = (key: string, options?: { text: string }) => (options ? `${key}|${options.text}` : key);
const build = (overrides: Partial<ContextMenuParams> = {}, nav = NAV) =>
  buildContextMenuEntries(params(overrides), nav, t);

const actionsOf = (entries: MenuEntry[]) => entries.map((entry) => ('separator' in entry ? '-' : entry.action));
const find = (entries: MenuEntry[], action: string) =>
  entries.find(
    (entry): entry is Exclude<MenuEntry, { separator: true }> => 'action' in entry && entry.action === action
  );

describe('buildContextMenuEntries', () => {
  it('plain page → Back (disabled when !canGoBack), Forward, Reload, separator, Inspect', () => {
    const entries = build({}, { canGoBack: false, canGoForward: true });
    expect(actionsOf(entries)).toEqual(['back', 'forward', 'reload', '-', 'inspect']);
    expect(find(entries, 'back')?.enabled).toBe(false);
    expect(find(entries, 'forward')?.enabled).toBe(true);
    expect(find(entries, 'reload')?.enabled).toBe(true);
  });

  it('link → Open link in new tab, Copy link address first; javascript: links get no Open entry', () => {
    const entries = build({ linkURL: 'https://a.test/x' });
    expect(actionsOf(entries).slice(0, 2)).toEqual(['openLinkInNewTab', 'copyLink']);
    expect(find(entries, 'openLinkInNewTab')?.arg).toBe('https://a.test/x');
    expect(find(entries, 'copyLink')?.arg).toBe('https://a.test/x');

    const unsafe = build({ linkURL: 'javascript:alert(1)' });
    expect(actionsOf(unsafe)).not.toContain('openLinkInNewTab');
    expect(actionsOf(unsafe)).toContain('copyLink');
  });

  it('image (mediaType "image") → Open image in new tab, Copy image, Save image as…', () => {
    const entries = build({ mediaType: 'image', srcURL: 'https://a.test/i.png' });
    expect(actionsOf(entries).slice(0, 3)).toEqual(['openImageInNewTab', 'copyImage', 'saveImageAs']);
    expect(find(entries, 'saveImageAs')?.arg).toBe('https://a.test/i.png');

    const dataImage = build({ mediaType: 'image', srcURL: 'data:image/png;base64,AAAA' });
    expect(actionsOf(dataImage)).not.toContain('openImageInNewTab');
    expect(actionsOf(dataImage)).toContain('copyImage');
  });

  it('selection → Copy and Search Google for "<first 30 chars>…"', () => {
    const entries = build({ selectionText: '  hello world  ' });
    expect(actionsOf(entries).slice(0, 2)).toEqual(['copy', 'searchSelection']);
    expect(find(entries, 'copy')?.enabled).toBe(true);
    expect(find(entries, 'searchSelection')).toMatchObject({
      label: 'preview.browserChrome.menu.searchSelection|hello world',
      arg: 'hello world',
    });

    const long = 'x'.repeat(31);
    expect(find(build({ selectionText: long }), 'searchSelection')).toMatchObject({
      label: `preview.browserChrome.menu.searchSelection|${'x'.repeat(30)}…`,
      arg: long,
    });
    const exact = 'y'.repeat(30);
    expect(find(build({ selectionText: exact }), 'searchSelection')?.label).toContain(`|${exact}`);
    expect(find(build({ selectionText: exact }), 'searchSelection')?.label).not.toContain('…');
  });

  it('editable with misspelling → suggestions (max 5, action replaceMisspelling, arg = word), Add to dictionary, separator, Cut/Copy/Paste/Select all honoring editFlags', () => {
    const entries = build({
      isEditable: true,
      misspelledWord: 'helo',
      dictionarySuggestions: ['hello', 'help', 'hero', 'halo', 'hell', 'held'],
      editFlags: { canCut: false, canCopy: false, canPaste: true, canSelectAll: true },
    });
    expect(actionsOf(entries).slice(0, 12)).toEqual([
      'replaceMisspelling',
      'replaceMisspelling',
      'replaceMisspelling',
      'replaceMisspelling',
      'replaceMisspelling',
      'addToDictionary',
      '-',
      'cut',
      'copy',
      'paste',
      'selectAll',
      '-',
    ]);
    const suggestions = entries.filter((entry) => 'action' in entry && entry.action === 'replaceMisspelling');
    expect(suggestions.map((entry) => ('label' in entry ? entry.label : ''))).toEqual([
      'hello',
      'help',
      'hero',
      'halo',
      'hell',
    ]);
    expect(suggestions.map((entry) => ('arg' in entry ? entry.arg : ''))).toEqual([
      'hello',
      'help',
      'hero',
      'halo',
      'hell',
    ]);
    expect(find(entries, 'addToDictionary')?.arg).toBe('helo');
    expect(find(entries, 'cut')?.enabled).toBe(false);
    expect(find(entries, 'copy')?.enabled).toBe(false);
    expect(find(entries, 'paste')?.enabled).toBe(true);
    expect(find(entries, 'selectAll')?.enabled).toBe(true);
    expect(actionsOf(entries).at(-1)).toBe('inspect');
  });

  it('labels come from t("preview.browserChrome.menu.<action>")', () => {
    const entries = build({ isEditable: true });
    expect(find(entries, 'cut')?.label).toBe('preview.browserChrome.menu.cut');
    expect(find(build(), 'reload')?.label).toBe('preview.browserChrome.menu.reload');
    expect(find(build(), 'inspect')?.label).toBe('preview.browserChrome.menu.inspect');
  });
});
