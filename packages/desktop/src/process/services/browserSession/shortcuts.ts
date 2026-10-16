/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { BrowserShortcutAction, BrowserShortcutRequest } from '@/common/types/browser';

type ShortcutInput = Pick<Electron.Input, 'type' | 'key' | 'meta' | 'control' | 'shift' | 'alt'>;

const ZOOM_STEP = 0.5;
const MIN_ZOOM_LEVEL = -3;
const MAX_ZOOM_LEVEL = 5;

const SHORTCUT_BY_KEY: Record<string, BrowserShortcutAction> = {
  f: 'find',
  l: 'focus-address',
  t: 'new-tab',
  w: 'close-tab',
  r: 'reload',
  '[': 'back',
  ']': 'forward',
  '=': 'zoom-in',
  '+': 'zoom-in',
  '-': 'zoom-out',
  '0': 'zoom-reset',
  p: 'print',
};

/**
 * Maps a key press to a browser shortcut: Cmd on macOS, Ctrl elsewhere. Pure.
 * Anything else (Cmd+Q, plain keys, Alt combos, key-up) returns null and is left to the page and the app menu.
 */
export function classifyBrowserShortcut(input: ShortcutInput, platform: NodeJS.Platform): BrowserShortcutAction | null {
  if (input.type !== 'keyDown') return null;
  if (input.key === 'Escape') return input.meta || input.control || input.shift || input.alt ? null : 'escape';

  const isDarwin = platform === 'darwin';
  const hasPlatformModifier = isDarwin ? input.meta : input.control;
  const hasOtherModifier = isDarwin ? input.control : input.meta;
  if (!hasPlatformModifier || hasOtherModifier || input.alt) return null;

  const key = input.key.toLowerCase();
  // Shift is only meaningful for hard-reload, and for "+" which US layouts type as Shift+=.
  if (input.shift) {
    if (key === 'r') return 'hard-reload';
    return key === '+' ? 'zoom-in' : null;
  }
  return SHORTCUT_BY_KEY[key] ?? null;
}

const clampZoom = (level: number): number => Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, level));

/** Runs the shortcuts main can finish alone; returns false for the ones the renderer owns. */
const runLocal = (contents: Electron.WebContents, action: BrowserShortcutAction): boolean => {
  switch (action) {
    case 'reload':
      contents.reload();
      return true;
    case 'hard-reload':
      contents.reloadIgnoringCache();
      return true;
    case 'back':
      if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack();
      return true;
    case 'forward':
      if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward();
      return true;
    case 'zoom-in':
      contents.setZoomLevel(clampZoom(contents.getZoomLevel() + ZOOM_STEP));
      return true;
    case 'zoom-out':
      contents.setZoomLevel(clampZoom(contents.getZoomLevel() - ZOOM_STEP));
      return true;
    case 'zoom-reset':
      contents.setZoomLevel(0);
      return true;
    case 'print':
      contents.print();
      return true;
    default:
      return false;
  }
};

/**
 * Makes browser shortcuts work while a page has focus. Without this the keys go to the guest page,
 * or fall through to the app menu, where Cmd+R would reload and Cmd+= would zoom the whole AionUi window.
 */
export function installBrowserShortcuts(
  contents: Electron.WebContents,
  platform: NodeJS.Platform = process.platform
): void {
  contents.on('before-input-event', (event, input) => {
    const action = classifyBrowserShortcut(input, platform);
    if (!action) return;

    // Escape is only reported: the page may need it (closing a dialog, leaving fullscreen).
    if (action !== 'escape') event.preventDefault();
    try {
      if (runLocal(contents, action)) return;
    } catch (error) {
      console.error(`[BrowserSession] shortcut "${action}" failed:`, error);
      return;
    }
    ipcBridge.browser.shortcut.emit({
      webContentsId: contents.id,
      action: action as BrowserShortcutRequest['action'],
    });
  });
}
