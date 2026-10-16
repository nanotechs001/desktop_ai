/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';

/** What to do with a page's `window.open` / `target=_blank` request. */
export type WindowOpenDecision =
  | { kind: 'tab'; url: string; background: boolean }
  | { kind: 'popup'; url: string; width: number; height: number }
  | { kind: 'deny' };

type WindowOpenDetails = { url: string; disposition: string; features: string };
type PopupSize = { width: number; height: number };

const DEFAULT_POPUP_SIZE: PopupSize = { width: 600, height: 700 };
const POPUP_WIDTH_RANGE = { min: 400, max: 1400 };
const POPUP_HEIGHT_RANGE = { min: 300, max: 1000 };
/** Values of the `popup` feature that mean "off", per the HTML window features rules. */
const POPUP_OFF_VALUES = new Set(['0', 'no', 'false']);

const clamp = (value: number, { min, max }: { min: number; max: number }): number =>
  Math.min(max, Math.max(min, value));

/** Only web pages and the blank page that sign-in flows open and then navigate are allowed. */
const isSafeUrl = (url: string): boolean => {
  if (url === 'about:blank') return true;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

/** Parses a `window.open` features string ("width=500, popup") into lower-cased key/value pairs. */
const parseFeatures = (features: string): Map<string, string> =>
  new Map(
    features.split(',').flatMap((part) => {
      const [key, value = ''] = part.split('=').map((piece) => piece.trim().toLowerCase());
      return key ? [[key, value] as const] : [];
    })
  );

const toPositiveInt = (value: string | undefined): number | undefined => {
  const parsed = Number.parseInt(value ?? '', 10);
  return parsed > 0 ? parsed : undefined;
};

/**
 * Decides how the in-app browser handles a page's request to open a URL.
 * Links and plain `window.open` become tabs; requests that ask for a window (a `new-window`
 * disposition, the `popup` feature, or a size) become popups so `window.opener` keeps working
 * for sign-in flows; anything that is not http(s) or about:blank is denied.
 */
export function classifyWindowOpen(details: WindowOpenDetails): WindowOpenDecision {
  const { url, disposition } = details;
  if (!isSafeUrl(url)) return { kind: 'deny' };
  if (disposition === 'foreground-tab' || disposition === 'background-tab') {
    return { kind: 'tab', url, background: disposition === 'background-tab' };
  }

  const features = parseFeatures(details.features);
  const requestedWidth = toPositiveInt(features.get('width'));
  const requestedHeight = toPositiveInt(features.get('height'));
  const popupFlag = features.get('popup');
  const wantsPopup =
    disposition === 'new-window' ||
    requestedWidth !== undefined ||
    requestedHeight !== undefined ||
    (popupFlag !== undefined && !POPUP_OFF_VALUES.has(popupFlag));
  if (!wantsPopup) return { kind: 'tab', url, background: false };

  return {
    kind: 'popup',
    url,
    width: requestedWidth ?? DEFAULT_POPUP_SIZE.width,
    height: requestedHeight ?? DEFAULT_POPUP_SIZE.height,
  };
}

/**
 * Window options for a popup: a child of `parent` on the browser partition, so cookies and
 * `window.opener` are shared with the page that opened it. The size is clamped to a usable range.
 */
export function popupWindowOptions(
  size: PopupSize,
  parent: Electron.BrowserWindow | null
): Electron.BrowserWindowConstructorOptions {
  return {
    parent: parent ?? undefined,
    width: clamp(size.width, POPUP_WIDTH_RANGE),
    height: clamp(size.height, POPUP_HEIGHT_RANGE),
    autoHideMenuBar: true,
    webPreferences: {
      partition: BROWSER_SESSION_PARTITION,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
}

/**
 * Routes `window.open` and `target=_blank` from a browser webContents: tabs are requested from
 * the renderer (the native window is denied), popups open as child windows, and unsafe URLs are
 * denied. Popup windows are browser contents too, so they get this same handler.
 * @param getParent returns the window popups attach to, or null when there is none
 */
export function installWindowOpenHandler(
  contents: Electron.WebContents,
  getParent: () => Electron.BrowserWindow | null
): void {
  contents.setWindowOpenHandler((details) => {
    const decision = classifyWindowOpen(details);
    if (decision.kind === 'tab') {
      ipcBridge.browser.openTabRequested.emit({ url: decision.url, background: decision.background });
      return { action: 'deny' };
    }
    if (decision.kind === 'popup') {
      const parent = getParent();
      return {
        action: 'allow',
        overrideBrowserWindowOptions: popupWindowOptions(decision, parent && !parent.isDestroyed() ? parent : null),
      };
    }
    return { action: 'deny' };
  });
}
