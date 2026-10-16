/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserWindow, screen } from 'electron';
import { ipcBridge } from '@/common';
import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';
import { isSafeUrl } from './urlSafety';

/** What to do with a page's `window.open` / `target=_blank` request. */
export type WindowOpenDecision =
  | { kind: 'tab'; url: string; background: boolean }
  | { kind: 'popup'; url: string; width: number; height: number }
  | { kind: 'deny' };

type WindowOpenDetails = { url: string; disposition: string; features: string };
type PopupSize = { width: number; height: number };
type Area = { x: number; y: number; width: number; height: number };
/** Electron hands createWindow the new guest as `options.webContents` and takes it back the same way; its types omit the key. */
type WithGuest = Electron.BrowserWindowConstructorOptions & { webContents: Electron.WebContents };

const DEFAULT_POPUP_SIZE: PopupSize = { width: 600, height: 700 };
const POPUP_WIDTH_RANGE = { min: 400, max: 1400 };
const POPUP_HEIGHT_RANGE = { min: 300, max: 1000 };
/** Values of the `popup` feature that mean "off", per the HTML window features rules. */
const POPUP_OFF_VALUES = new Set(['0', 'no', 'false']);

const MAX_POPUPS_PER_OPENER = 2;
const MAX_POPUPS_TOTAL = 5;
const MAX_TABS_PER_OPENER = 3;
const TAB_RATE_WINDOW_MS = 10_000;

/**
 * The popup blocker: at most 2 open popups per opening page and 5 in all, and at most 3 new tabs
 * per opening page in any 10 s. Openers are webContents ids.
 */
export class OpenLimiter {
  private popups = new Map<number, number>();
  private tabOpens = new Map<number, number[]>();

  canOpenPopup(openerId: number): boolean {
    const total = [...this.popups.values()].reduce((sum, count) => sum + count, 0);
    return (this.popups.get(openerId) ?? 0) < MAX_POPUPS_PER_OPENER && total < MAX_POPUPS_TOTAL;
  }

  /** Counts a popup for `openerId` until the returned release runs (extra calls are ignored). */
  reservePopup(openerId: number): () => void {
    this.popups.set(openerId, (this.popups.get(openerId) ?? 0) + 1);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.popups.get(openerId) ?? 1) - 1;
      if (left > 0) this.popups.set(openerId, left);
      else this.popups.delete(openerId);
    };
  }

  /** Records a tab open at `now` (ms); false, and not recorded, when the opener is over its rate. */
  tryOpenTab(openerId: number, now: number): boolean {
    const recent = (this.tabOpens.get(openerId) ?? []).filter((at) => now - at < TAB_RATE_WINDOW_MS);
    if (recent.length >= MAX_TABS_PER_OPENER) {
      this.tabOpens.set(openerId, recent);
      return false;
    }
    this.tabOpens.set(openerId, [...recent, now]);
    return true;
  }
}

const sharedLimiter = new OpenLimiter();

const clamp = (value: number, { min, max }: { min: number; max: number }): number =>
  Math.min(max, Math.max(min, value));

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

/** `value` moved into [min, max]; `min` wins when the range is empty. */
const clampInto = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

/**
 * Window options for a popup: a child of `parent` on the browser partition, so cookies and
 * `window.opener` are shared with the page that opened it. The size is clamped to a usable range
 * and to `workArea`; the popup is centred on the parent and kept inside `workArea`.
 *
 * This is the complete option set: the popup window is built from it alone (see createWindow in
 * installWindowOpenHandler), so none of the page's `window.open` features reach the window.
 */
export function popupWindowOptions(
  size: PopupSize,
  parent: Electron.BrowserWindow | null,
  workArea: Area
): Electron.BrowserWindowConstructorOptions {
  const width = Math.min(clamp(size.width, POPUP_WIDTH_RANGE), workArea.width);
  const height = Math.min(clamp(size.height, POPUP_HEIGHT_RANGE), workArea.height);
  const bounds = parent?.getBounds();
  const centred = (start: number, span: number, inner: number) => Math.round(start + (span - inner) / 2);
  return {
    parent: parent ?? undefined,
    width,
    height,
    x: bounds
      ? clampInto(centred(bounds.x, bounds.width, width), workArea.x, workArea.x + workArea.width - width)
      : undefined,
    y: bounds
      ? clampInto(centred(bounds.y, bounds.height, height), workArea.y, workArea.y + workArea.height - height)
      : undefined,
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
 * This owns `setWindowOpenHandler` for browser contents: later code must not call it on them.
 * @param getParent returns the window popups attach to, or null when there is none
 */
export function installWindowOpenHandler(
  contents: Electron.WebContents,
  getParent: () => Electron.BrowserWindow | null,
  limiter: OpenLimiter = sharedLimiter
): void {
  const openerId = contents.id;
  contents.setWindowOpenHandler((details) => {
    const decision = classifyWindowOpen(details);
    if (decision.kind === 'tab') {
      if (limiter.tryOpenTab(openerId, Date.now())) {
        ipcBridge.browser.openTabRequested.emit({ url: decision.url, background: decision.background });
      } else {
        console.warn(`[BrowserSession] blocked a tab: too many opened by webContents ${openerId}`);
      }
      return { action: 'deny' };
    }
    if (decision.kind === 'popup') {
      if (!limiter.canOpenPopup(openerId)) {
        console.warn(`[BrowserSession] blocked a popup: too many open from webContents ${openerId}`);
        return { action: 'deny' };
      }
      // Reserved now, not in createWindow: a burst of window.open calls all reach this handler first.
      // shortcut: a popup Electron never creates (opener torn down in between) keeps its slot until restart.
      const release = limiter.reservePopup(openerId);
      const candidate = getParent();
      const parent = candidate && !candidate.isDestroyed() ? candidate : null;
      const workArea = (parent ? screen.getDisplayMatching(parent.getBounds()) : screen.getPrimaryDisplay()).workArea;
      const options = popupWindowOptions(decision, parent, workArea);
      return {
        action: 'allow',
        // Sets the new page's web preferences; the window itself comes from createWindow.
        overrideBrowserWindowOptions: { webPreferences: options.webPreferences },
        // Electron passes the page's features (show, opacity, type, ...) merged into the options
        // here; only the guest webContents is taken from them, so window.opener keeps working.
        createWindow: (pageOptions) => {
          const guestOptions: WithGuest = { ...options, webContents: (pageOptions as WithGuest).webContents };
          const popup = new BrowserWindow(guestOptions);
          popup.on('closed', release);
          return popup.webContents;
        },
      };
    }
    return { action: 'deny' };
  });
}
