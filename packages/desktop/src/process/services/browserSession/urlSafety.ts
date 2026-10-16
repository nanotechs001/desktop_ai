/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Only web pages and the blank page that sign-in flows open and then navigate are allowed.
 * Dependency-free so pure modules (e.g. the context-menu builder) can use it without the IPC bridge.
 */
export const isSafeUrl = (url: string): boolean => {
  if (url === 'about:blank') return true;
  try {
    const { protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};
