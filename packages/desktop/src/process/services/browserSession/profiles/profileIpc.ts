/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import { app, session } from 'electron';
import { ipcBridge } from '@/common';
import { browserExtensionsSettled, ensureBrowserSession } from '../browserSession';
import {
  agentPartition,
  clearBrowsingData,
  deleteAgentBrowserData,
  parseBrowserTabProfile,
  partitionOfProfile,
} from './browserProfiles';

type Reply<D = undefined> = { success: boolean; data?: D; msg?: string };

const INVALID: Reply = { success: false, msg: 'Invalid arguments' };

const failure = (error: unknown): Reply => {
  console.error('[BrowserProfiles] IPC handler failed:', error);
  return { success: false, msg: error instanceof Error ? error.message : String(error) };
};

/** The request's `agentId` when it is a string; the profile helpers validate it as an Agent id. */
const agentIdOf = (request: unknown): string | null => {
  const agentId = (request as { agentId?: unknown } | null)?.agentId;
  return typeof agentId === 'string' ? agentId : null;
};

/** The renderer's browser-profile IPC: a tab's partition (its session set up first), and clearing or deleting data. */
export function registerBrowserProfileIpc(): void {
  ipcBridge.browser.profilePartition.provider(async (request) => {
    const profile = parseBrowserTabProfile(request);
    if (!profile) return INVALID;
    try {
      const partition = partitionOfProfile(profile);
      ensureBrowserSession(partition);
      // Its first tab must reach chrome.tabs too, so answer once the profile's extensions are up.
      await browserExtensionsSettled(partition);
      return { success: true, data: partition };
    } catch (error) {
      return failure(error);
    }
  });
  ipcBridge.browser.clearProfileData.provider(async (request) => {
    const agentId = agentIdOf(request);
    if (agentId === null) return INVALID;
    try {
      await clearBrowsingData(session.fromPartition(agentPartition(agentId)));
      return { success: true };
    } catch (error) {
      return failure(error);
    }
  });
  ipcBridge.browser.deleteProfileData.provider(async (request) => {
    const agentId = agentIdOf(request);
    if (agentId === null) return INVALID;
    try {
      await deleteAgentBrowserData(agentId, {
        userDataDir: app.getPath('userData'),
        fromPartition: (partition) => session.fromPartition(partition),
        removeDir: (dir) => fs.rm(dir, { recursive: true, force: true }),
      });
      return { success: true };
    } catch (error) {
      return failure(error);
    }
  });
}
