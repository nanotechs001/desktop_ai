/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { BrowserWindow, dialog, screen } from 'electron';
import { ipcBridge } from '@/common';
import type { MenuTranslate } from './contextMenu/contextMenu';
import { loadTranslate } from './contextMenu/contextMenuInstall';
import { partitionOfSession, profileOfSession } from './profiles/browserProfiles';
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

/** How agent browser control follows what a page opens; it sets them while it runs (see setWindowOpenHooks). */
export type WindowOpenHooks = {
  /** A page asks for a tab: the chat to open it in, when the opener is an agent's tab. */
  tabRequested?: (openerId: number, url: string, partition: string | null) => { conversationId?: string } | undefined;
  /** A page's popup window was created. */
  popupCreated?: (openerId: number, popup: Electron.WebContents) => void;
  /** A page's beforeunload blocked a navigation or close: what to do instead of only asking on the desktop. */
  unloadBlocked?: (webContentsId: number) => UnloadPlan;
};

/**
 * `leave`: an agent's own tab goes on unasked (nobody may be watching it). `ask`: "Leave site?" on the desktop and,
 * with `askChat`, in a chat too (resolves true for Leave; `signal` withdraws it once the other answered).
 */
export type UnloadPlan = { kind: 'leave' } | { kind: 'ask'; askChat?: (signal: AbortSignal) => Promise<boolean> };

let hooks: WindowOpenHooks = {};

/** Replaces the window-open hooks; `{}` removes them. The handler itself stays installed here only. */
export const setWindowOpenHooks = (next: WindowOpenHooks): void => {
  hooks = next;
};

/** Runs a hook; a throw is logged and never stops the tab or popup from opening. */
const runHook = <R>(name: string, call: () => R): R | undefined => {
  try {
    return call();
  } catch (error) {
    console.error(`[BrowserSession] window-open hook ${name} failed:`, error);
    return undefined;
  }
};

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

/** A popup's window title: the page title, then the page origin, so a sign-in popup shows where it is. */
export function popupTitle(title: string, url: string): string {
  let origin = url;
  try {
    const parsed = new URL(url).origin;
    if (parsed !== 'null') origin = parsed;
  } catch {
    // Not a URL: show it as it is.
  }
  return `${title} — ${origin}`;
}

/** `value` moved into [min, max]; `min` wins when the range is empty. */
const clampInto = (value: number, min: number, max: number): number => Math.max(min, Math.min(value, max));

/**
 * Window options for a popup: a child of `parent` on the opener's `partition` (its browser profile), so cookies
 * and `window.opener` are shared with the page that opened it. The size is clamped to a usable range
 * and to `workArea`; the popup is centred on the parent and kept inside `workArea`.
 *
 * This is the complete option set: the popup window is built from it alone (see createWindow in
 * installWindowOpenHandler), so none of the page's `window.open` features reach the window.
 */
export function popupWindowOptions(
  size: PopupSize,
  parent: Electron.BrowserWindow | null,
  workArea: Area,
  partition: string
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
      partition,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  };
}

/**
 * Routes `window.open` and `target=_blank` from a browser webContents: tabs are requested from
 * the renderer in the opener's profile (the native window is denied), popups open as child windows
 * on the opener's partition, and unsafe URLs are denied. Popup windows are browser contents too, so
 * they get this same handler.
 * This owns `setWindowOpenHandler` for browser contents: later code must not call it on them.
 * @param getParent returns the window popups attach to, or null when there is none
 */
export function installWindowOpenHandler(
  contents: Electron.WebContents,
  getParent: () => Electron.BrowserWindow | null,
  limiter: OpenLimiter = sharedLimiter
): void {
  const openerId = contents.id;
  const partition = partitionOfSession(contents.session);
  const profile = profileOfSession(contents.session) ?? undefined;
  contents.setWindowOpenHandler((details) => {
    const decision = classifyWindowOpen(details);
    if (decision.kind === 'tab') {
      if (limiter.tryOpenTab(openerId, Date.now())) {
        const extra = runHook('tabRequested', () => hooks.tabRequested?.(openerId, decision.url, partition));
        const conversationId = extra?.conversationId;
        ipcBridge.browser.openTabRequested.emit({
          url: decision.url,
          background: decision.background,
          profile,
          ...(conversationId ? { conversationId } : {}),
        });
      } else {
        console.warn(`[BrowserSession] blocked a tab: too many opened by webContents ${openerId}`);
      }
      return { action: 'deny' };
    }
    if (decision.kind === 'popup') {
      // Only browser contents get this handler, so the opener's partition is always known; fail closed if not.
      if (partition === null) return { action: 'deny' };
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
      const options = popupWindowOptions(decision, parent, workArea, partition);
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
          // Popups have no address bar, so the title is the only place the page origin can show.
          popup.on('page-title-updated', (event, title) => {
            event.preventDefault();
            popup.setTitle(popupTitle(title, popup.webContents.getURL()));
          });
          runHook('popupCreated', () => hooks.popupCreated?.(openerId, popup.webContents));
          return popup.webContents;
        },
      };
    }
    return { action: 'deny' };
  });
}

const LEAVE_KEY = 'preview.browserChrome.leave';
const LEAVE_BUTTON = 0;
const STAY_BUTTON = 1;
/** Loaded once, ahead of time: `will-prevent-unload` must be answered synchronously. */
let leaveTranslate: MenuTranslate | null = null;
let leaveTranslateLoading = false;

const preloadLeaveTranslate = (): void => {
  if (leaveTranslate || leaveTranslateLoading) return;
  leaveTranslateLoading = true;
  loadTranslate().then(
    (t) => {
      leaveTranslate = t;
    },
    (error: unknown) => {
      leaveTranslateLoading = false;
      console.error('[BrowserSession] could not load the leave-site dialog text:', error);
    }
  );
};

/** A Leave answered after the page stayed lets the tab's next unload attempt through unasked, for this long. */
const LEAVE_AGAIN_MS = 60_000;
/** Tabs whose next unload goes through unasked, until the time (ms) given. */
const leaveAgainUntil = new Map<number, number>();
/** Tabs with a desktop-and-chat ask open: a repeat attempt meanwhile stays without a second ask. */
const asking = new Set<number>();

const leaveOptions = (t: MenuTranslate) => ({
  type: 'question' as const,
  message: t(`${LEAVE_KEY}.title`),
  detail: t(`${LEAVE_KEY}.detail`),
  buttons: [t(`${LEAVE_KEY}.leave`), t(`${LEAVE_KEY}.stay`)],
  defaultId: LEAVE_BUTTON,
  cancelId: STAY_BUTTON,
  noLink: true,
});

/** True once, within {@link LEAVE_AGAIN_MS} of a Leave answered after the page stayed. */
const takeLeaveAgain = (webContentsId: number): boolean => {
  const until = leaveAgainUntil.get(webContentsId);
  leaveAgainUntil.delete(webContentsId);
  return until !== undefined && Date.now() <= until;
};

/**
 * The blocked load's url when it is a browser-initiated one (the address bar, an agent's Page.navigate): Chromium
 * shows its pending entry in `getURL()` before it commits. Null for a reload, back/forward or a link the page
 * followed, whose target main cannot see.
 */
const pendingUrlOf = (contents: Electron.WebContents): string | null => {
  const url = contents.getURL();
  return url && url !== contents.mainFrame.url && isSafeUrl(url) ? url : null;
};

/**
 * Asks on the desktop (a non-blocking box) and in the tab's chat at once; the first answer wins and withdraws the
 * other. The page has already stayed, so Leave runs the blocked load again when main knows it; otherwise the tab's
 * next attempt (the user's or the agent's retry) leaves unasked.
 */
const askDesktopAndChat = (
  contents: Electron.WebContents,
  owner: Electron.BrowserWindow,
  t: MenuTranslate,
  askChat: (signal: AbortSignal) => Promise<boolean>
): void => {
  const { id } = contents;
  if (asking.has(id)) return;
  asking.add(id);
  const pendingUrl = pendingUrlOf(contents);
  const settled = new AbortController();
  const desktop = dialog
    .showMessageBox(owner, { ...leaveOptions(t), signal: settled.signal })
    .then(({ response }) => response === LEAVE_BUTTON);
  const chat = askChat(settled.signal);
  void Promise.race([desktop, chat])
    .catch((error: unknown) => {
      console.error('[BrowserSession] the leave-site ask failed; the page stays:', error);
      return false;
    })
    .then((leave) => {
      settled.abort();
      asking.delete(id);
      if (!leave || contents.isDestroyed()) return;
      leaveAgainUntil.set(id, Date.now() + LEAVE_AGAIN_MS);
      if (pendingUrl) {
        contents.loadURL(pendingUrl).catch((error: unknown) => {
          console.warn('[BrowserSession] could not run the left navigation again:', error);
        });
      }
    });
};

/**
 * Answers "Leave site?" when a page's beforeunload handler blocks a navigation or close. An agent's own tab leaves
 * unasked. Otherwise it asks on the window that shows the page (the main window for a tab, the popup's own window):
 * Leave lets the page go; Stay, or no answer possible yet, keeps it. When a chat drives the tab, the chat asks too
 * (see {@link askDesktopAndChat}).
 */
export function installBeforeUnloadDialog(
  contents: Electron.WebContents,
  getMainWindow: () => Electron.BrowserWindow | null
): void {
  preloadLeaveTranslate();
  const { id } = contents;
  contents.once('destroyed', () => leaveAgainUntil.delete(id));
  contents.on('will-prevent-unload', (event) => {
    if (takeLeaveAgain(id)) return event.preventDefault();
    const plan = runHook('unloadBlocked', () => hooks.unloadBlocked?.(id));
    if (plan?.kind === 'leave') return event.preventDefault();
    const t = leaveTranslate;
    const owner = BrowserWindow.fromWebContents(contents.hostWebContents ?? contents) ?? getMainWindow();
    if (!t || !owner || owner.isDestroyed()) return;
    if (plan?.askChat) return askDesktopAndChat(contents, owner, t, plan.askChat);
    const choice = dialog.showMessageBoxSync(owner, leaveOptions(t));
    if (choice === LEAVE_BUTTON) event.preventDefault();
  });
}
