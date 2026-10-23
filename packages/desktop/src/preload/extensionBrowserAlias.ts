/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Makes `browser` the full extension API in Chrome extension pages and service workers.
 *
 * Electron gives extension contexts its own `browser` object with only a few APIs (action, extension, i18n,
 * management, runtime, storage, tabs; no windows, contextMenus, cookies...). electron-chrome-extensions fills in the
 * rest on `chrome` only, so an extension that prefers `browser` (LastPass: `typeof browser !== 'undefined' ? browser
 * : chrome`) crashed on `browser.windows` and its background never started. Registered after the library's preload,
 * so `chrome` is complete when this runs. Web pages are left alone.
 */
import { contextBridge } from 'electron';

const isExtensionContext =
  process.type === 'service-worker' || (typeof location !== 'undefined' && location.protocol === 'chrome-extension:');

if (isExtensionContext) {
  try {
    contextBridge.executeInMainWorld({
      func: () => {
        const api = (globalThis as { chrome?: { runtime?: unknown } }).chrome;
        if (!api || !api.runtime) return;
        Object.defineProperty(globalThis, 'browser', { value: api, configurable: true, writable: true });
      },
    });
  } catch (error) {
    console.error('[extensionBrowserAlias] could not alias browser to chrome:', error);
  }
}
