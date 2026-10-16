/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

type Waiter<T> = { url: string; resolve: (contents: T) => void; reject: (error: Error) => void };

/** A new tab that reports its navigations; Electron's WebContents satisfies it. */
export type NavigatingContents = {
  on(event: 'did-start-navigation', listener: (details: { url: string; isMainFrame: boolean }) => void): unknown;
  removeListener(
    event: 'did-start-navigation',
    listener: (details: { url: string; isMainFrame: boolean }) => void
  ): unknown;
};

/** The form two urls are compared in: WHATWG-serialized when parsable, else as given. */
export const normalizeTabUrl = (url: string): string => {
  try {
    return new URL(url).href;
  } catch {
    return url;
  }
};

/**
 * Pairs "open a tab at <url>" requests with the browser tabs that appear afterwards. The renderer
 * reports no request id back, so a new tab is matched by the url of its first main-frame navigation:
 * the oldest waiter for that url takes it, and a tab nobody asked for (the user's) is never handed out.
 */
export class CreateTabWaiter<T> {
  private pending: Waiter<T>[] = [];

  /** True while some request is waiting for its tab. */
  get waiting(): boolean {
    return this.pending.length > 0;
  }

  /** Resolves with the tab that first navigates to `url`; rejects with 'tab-create-timeout' or a {@link refuse} error. */
  wait(url: string, timeoutMs: number): Promise<T> {
    return new Promise((resolve, reject) => {
      const waiter: Waiter<T> = {
        url: normalizeTabUrl(url),
        resolve: (contents) => {
          clearTimeout(timer);
          resolve(contents);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      };
      const timer = setTimeout(() => {
        this.pending = this.pending.filter((entry) => entry !== waiter);
        console.warn(`[CreateTabWaiter] no browser tab opened ${url}`);
        reject(new Error('tab-create-timeout'));
      }, timeoutMs);
      this.pending = [...this.pending, waiter];
    });
  }

  /** The pane will not open `url` (e.g. its tab cap): the oldest request for it fails now with `error`. */
  refuse(url: string, error: Error): boolean {
    const normalized = normalizeTabUrl(url);
    const match = this.pending.find((entry) => entry.url === normalized);
    if (!match) return false;
    this.pending = this.pending.filter((entry) => entry !== match);
    match.reject(error);
    return true;
  }

  /** Offers a new tab whose first main-frame navigation went to `url`; true when a waiter took it. */
  offer(contents: T, url: string): boolean {
    const normalized = normalizeTabUrl(url);
    const match = this.pending.find((entry) => entry.url === normalized);
    if (!match) return false;
    this.pending = this.pending.filter((entry) => entry !== match);
    match.resolve(contents);
    return true;
  }
}

/** Calls `cb` once with the url of the tab's first main-frame navigation. */
export function onFirstMainFrameNavigation(contents: NavigatingContents, cb: (url: string) => void): void {
  const listener = (details: { url: string; isMainFrame: boolean }): void => {
    if (!details.isMainFrame) return;
    contents.removeListener('did-start-navigation', listener);
    cb(details.url);
  };
  contents.on('did-start-navigation', listener);
}

/** Feeds a newly created tab to `waiter` once its first navigation reveals which request it answers. */
export function offerNewTab<T extends NavigatingContents>(waiter: CreateTabWaiter<T>, contents: T): void {
  if (!waiter.waiting) return;
  onFirstMainFrameNavigation(contents, (url) => waiter.offer(contents, url));
}
