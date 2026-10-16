/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserWindow } from 'electron';
import { ipcBridge } from '@/common';
import type { BrowserShortcutAction, BrowserShortcutRequest } from '@/common/types/browser';

type ShortcutInput = Pick<Electron.Input, 'type' | 'key' | 'meta' | 'control' | 'shift' | 'alt'> & {
  code?: Electron.Input['code'];
};

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

/** Physical keys, for layouts whose `key` is not ASCII (Cyrillic, Persian, ...): code -> the ASCII key it stands for. */
const KEY_BY_CODE: Record<string, string> = {
  KeyF: 'f',
  KeyL: 'l',
  KeyT: 't',
  KeyW: 'w',
  KeyR: 'r',
  KeyP: 'p',
  BracketLeft: '[',
  BracketRight: ']',
  Equal: '=',
  Minus: '-',
  Digit0: '0',
  NumpadAdd: '+',
  NumpadSubtract: '-',
  Numpad0: '0',
};

const ASCII_LIMIT = 128;

/** The shortcuts main cannot finish itself; the renderer acts on the tab whose webContents id matches. */
const RENDERER_ACTIONS: ReadonlySet<BrowserShortcutAction> = new Set<BrowserShortcutRequest['action']>([
  'find',
  'focus-address',
  'new-tab',
  'close-tab',
  'escape',
]);

const isRendererAction = (action: BrowserShortcutAction): action is BrowserShortcutRequest['action'] =>
  RENDERER_ACTIONS.has(action);

/**
 * Maps a key press to a browser shortcut: Cmd on macOS, Ctrl elsewhere. Pure.
 * Anything else (Cmd+Q, plain keys, Alt combos, key-up) returns null and is left to the page and the app menu.
 * A non-ASCII `key` (e.g. Cmd+F on a Russian layout arrives as "а") falls back to the physical `code`.
 */
export function classifyBrowserShortcut(input: ShortcutInput, platform: NodeJS.Platform): BrowserShortcutAction | null {
  if (input.type !== 'keyDown') return null;
  if (input.key === 'Escape') return input.meta || input.control || input.shift || input.alt ? null : 'escape';

  const isDarwin = platform === 'darwin';
  const hasPlatformModifier = isDarwin ? input.meta : input.control;
  const hasOtherModifier = isDarwin ? input.control : input.meta;
  if (!hasPlatformModifier || hasOtherModifier || input.alt) return null;

  const isAscii = input.key.length === 1 && input.key.charCodeAt(0) < ASCII_LIMIT;
  const key = isAscii ? input.key.toLowerCase() : (KEY_BY_CODE[input.code ?? ''] ?? '');
  // Shift is only meaningful for hard-reload, and for "+" which US layouts type as Shift+=.
  if (input.shift) {
    if (key === 'r') return 'hard-reload';
    return key === '+' || key === '=' ? 'zoom-in' : null;
  }
  return SHORTCUT_BY_KEY[key] ?? null;
}

const clampZoom = (level: number): number => Math.min(MAX_ZOOM_LEVEL, Math.max(MIN_ZOOM_LEVEL, level));

/** Runs the shortcuts main can finish alone. */
const runLocal = (
  contents: Electron.WebContents,
  action: Exclude<BrowserShortcutAction, BrowserShortcutRequest['action']>
) => {
  switch (action) {
    case 'reload':
      return contents.reload();
    case 'hard-reload':
      return contents.reloadIgnoringCache();
    case 'back':
      return contents.navigationHistory.canGoBack() ? contents.navigationHistory.goBack() : undefined;
    case 'forward':
      return contents.navigationHistory.canGoForward() ? contents.navigationHistory.goForward() : undefined;
    case 'zoom-in':
      return contents.setZoomLevel(clampZoom(contents.getZoomLevel() + ZOOM_STEP));
    case 'zoom-out':
      return contents.setZoomLevel(clampZoom(contents.getZoomLevel() - ZOOM_STEP));
    case 'zoom-reset':
      return contents.setZoomLevel(0);
    case 'print':
      return contents.print();
  }
};

/**
 * Makes browser shortcuts work while a page has focus. Without this the keys go to the guest page,
 * or fall through to the app menu, where Cmd+R would reload and Cmd+= would zoom the whole AionUi window.
 *
 * A popup window has no tab in the preview panel to act on, so its renderer-owned shortcuts are
 * handled here (Cmd+W closes the window) or left to pass through (find, address bar, new tab).
 */
export function installBrowserShortcuts(
  contents: Electron.WebContents,
  platform: NodeJS.Platform = process.platform
): void {
  contents.on('before-input-event', (event, input) => {
    const action = classifyBrowserShortcut(input, platform);
    if (!action) return;

    try {
      if (!isRendererAction(action)) {
        event.preventDefault();
        runLocal(contents, action);
      } else if (contents.getType() === 'window') {
        if (action !== 'close-tab') return;
        event.preventDefault();
        BrowserWindow.fromWebContents(contents)?.close();
      } else {
        // Escape is only reported: the page may need it (closing a dialog, leaving fullscreen).
        if (action !== 'escape') event.preventDefault();
        ipcBridge.browser.shortcut.emit({ webContentsId: contents.id, action });
      }
    } catch (error) {
      console.error(`[BrowserSession] shortcut "${action}" failed:`, error);
    }
  });
}
