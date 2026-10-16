/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { isSafeUrl } from './urlSafety';

export type MenuAction =
  | 'back'
  | 'forward'
  | 'reload'
  | 'openLinkInNewTab'
  | 'copyLink'
  | 'openImageInNewTab'
  | 'copyImage'
  | 'saveImageAs'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'selectAll'
  | 'searchSelection'
  | 'replaceMisspelling'
  | 'addToDictionary'
  | 'inspect';

export type MenuEntry = { action: MenuAction; label: string; enabled: boolean; arg?: string } | { separator: true };

export type ContextMenuParams = Pick<
  Electron.ContextMenuParams,
  | 'linkURL'
  | 'srcURL'
  | 'mediaType'
  | 'selectionText'
  | 'isEditable'
  | 'misspelledWord'
  | 'dictionarySuggestions'
  | 'editFlags'
>;

/** `options.text` fills the `{{text}}` placeholder of the "Search Google for …" label. */
export type MenuTranslate = (key: string, options?: Record<string, string>) => string;

const MAX_SUGGESTIONS = 5;
const MAX_SELECTION_LABEL_CHARS = 30;

/** Cuts by code point so a surrogate pair is never split. */
const truncate = (text: string, max: number): string => Array.from(text).slice(0, max).join('');

/**
 * Builds the Chrome-style right-click menu for a browser page as plain data (no Electron
 * import, so it is easy to test). Sections are divided by separators; the caller maps entries
 * to native menu items and appends extension items after them.
 */
export function buildContextMenuEntries(
  params: ContextMenuParams,
  nav: { canGoBack: boolean; canGoForward: boolean },
  t: MenuTranslate
): MenuEntry[] {
  const item = (action: MenuAction, enabled = true, arg?: string, text?: string): MenuEntry => ({
    action,
    label: t(`preview.browserChrome.menu.${action}`, text === undefined ? undefined : { text }),
    enabled,
    ...(arg === undefined ? {} : { arg }),
  });

  const selection = params.selectionText.trim();
  const isImage = params.mediaType === 'image' && params.srcURL !== '';
  const sections: MenuEntry[][] = [];

  if (params.linkURL) {
    sections.push([
      ...(isSafeUrl(params.linkURL) ? [item('openLinkInNewTab', true, params.linkURL)] : []),
      item('copyLink', true, params.linkURL),
    ]);
  }
  if (isImage) {
    sections.push([
      ...(isSafeUrl(params.srcURL) ? [item('openImageInNewTab', true, params.srcURL)] : []),
      item('copyImage', true, params.srcURL),
      item('saveImageAs', true, params.srcURL),
    ]);
  }
  if (params.isEditable && params.misspelledWord) {
    sections.push([
      ...params.dictionarySuggestions
        .slice(0, MAX_SUGGESTIONS)
        .map((word): MenuEntry => ({ action: 'replaceMisspelling', label: word, enabled: true, arg: word })),
      item('addToDictionary', true, params.misspelledWord),
    ]);
  }

  const editing: MenuEntry[] = [];
  if (params.isEditable) {
    const { canCut, canCopy, canPaste, canSelectAll } = params.editFlags;
    editing.push(item('cut', canCut), item('copy', canCopy), item('paste', canPaste), item('selectAll', canSelectAll));
  } else if (selection) {
    editing.push(item('copy'));
  }
  if (selection) {
    const ellipsis = Array.from(selection).length > MAX_SELECTION_LABEL_CHARS ? '…' : '';
    const text = truncate(selection, MAX_SELECTION_LABEL_CHARS).replace(/\s+/g, ' ') + ellipsis;
    // The label shows the shortened text; the arg keeps the full selection for the query.
    editing.push(item('searchSelection', true, selection, text));
  }
  if (editing.length > 0) sections.push(editing);

  if (!params.linkURL && !isImage && !params.isEditable && !selection) {
    sections.push([item('back', nav.canGoBack), item('forward', nav.canGoForward), item('reload')]);
  }
  sections.push([item('inspect')]);

  return sections.flatMap((section, index) => (index === 0 ? section : [{ separator: true }, ...section]));
}
