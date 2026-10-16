/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import {
  cancelDownload,
  getDownloads,
  openDownload,
  showDownloadInFolder,
} from '@process/services/browserSession/downloads';

/** Registers the in-app browser's IPC providers. The download actions return failures instead of throwing. */
export function initBrowserBridge(): void {
  ipcBridge.browser.getDownloads.provider(async () => ({ success: true, data: getDownloads() }));
  ipcBridge.browser.openDownload.provider(({ id }) => openDownload(id));
  ipcBridge.browser.showDownloadInFolder.provider(async ({ id }) => showDownloadInFolder(id));
  ipcBridge.browser.cancelDownload.provider(async ({ id }) => cancelDownload(id));
}
