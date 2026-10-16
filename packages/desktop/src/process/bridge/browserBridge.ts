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
import { getPermissionRequests, replyPermission } from '@process/services/browserSession/permissions';

type ActionResult = { success: boolean; msg?: string };

const INVALID: ActionResult = { success: false, msg: 'Invalid request' };

/** The renderer's `{ id }`, or null unless it is a non-empty string: IPC input is not trusted. */
const idOf = (params: unknown): string | null => {
  const id = (params as { id?: unknown } | null | undefined)?.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

/** Runs `action` on a valid id; anything else is answered with a failure. */
const withId =
  (action: (id: string) => ActionResult | Promise<ActionResult>) =>
  async (params: unknown): Promise<ActionResult> => {
    const id = idOf(params);
    return id ? action(id) : INVALID;
  };

/** Registers the in-app browser's IPC providers. Actions validate their input and return failures instead of throwing. */
export function initBrowserBridge(): void {
  ipcBridge.browser.getDownloads.provider(async () => ({ success: true, data: getDownloads() }));
  ipcBridge.browser.openDownload.provider(withId(openDownload));
  ipcBridge.browser.showDownloadInFolder.provider(withId(showDownloadInFolder));
  ipcBridge.browser.cancelDownload.provider(withId(cancelDownload));
  ipcBridge.browser.getPermissionRequests.provider(async () => ({ success: true, data: getPermissionRequests() }));
  ipcBridge.browser.replyPermission.provider(async (params) => {
    const id = idOf(params);
    if (!id) return INVALID;
    // Only a literal true grants or remembers; anything else from the renderer counts as false.
    const allow = params.allow === true;
    const remember = params.remember === true;
    return replyPermission(id, allow, remember)
      ? { success: true }
      : { success: false, msg: 'Unknown or expired request' };
  });
}
