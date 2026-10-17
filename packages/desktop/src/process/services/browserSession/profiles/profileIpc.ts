/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import { BrowserWindow, app, session, webContents } from 'electron';
import { z } from 'zod';
import { ipcBridge } from '@/common';
import { DEFAULT_AGENT_ID } from '@/common/types/agent/defaultAgent';
import { browserExtensionsSettled, ensureBrowserSession, forgetBrowserSession } from '../browserSession';
import { forgetPermissions } from '../permissions';
import {
  agentPartition,
  clearBrowsingData,
  deleteAgentBrowserData,
  parseBrowserTabProfile,
  partitionOfProfile,
} from './browserProfiles';
import { detectBrowserSources } from './cookieImport/detect';
import { importCookies } from './cookieImport/importCookies';

type Reply<D = undefined> = { success: boolean; data?: D; msg?: string };

/** How long a closing page may take before deletion goes on without it. */
const CLOSE_TIMEOUT_MS = 3000;

/** Closes every live page of `target` (tabs, popups, extension pages) and waits until each is gone or times out. */
const closeSessionContents = async (target: Electron.Session): Promise<void> => {
  const live = webContents.getAllWebContents().filter((contents) => contents.session === target);
  await Promise.all(
    live.map(
      (contents) =>
        new Promise<void>((resolve) => {
          if (contents.isDestroyed()) return resolve();
          const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
          contents.once('destroyed', () => {
            clearTimeout(timer);
            resolve();
          });
          const popup = contents.getType() === 'window' ? BrowserWindow.fromWebContents(contents) : null;
          if (popup) popup.destroy();
          else contents.close();
        })
    )
  );
};

const unloadExtensions = (target: Electron.Session): void => {
  for (const extension of target.extensions.getAllExtensions()) target.extensions.removeExtension(extension.id);
};

const INVALID: Reply = { success: false, msg: 'Invalid arguments' };

const failure = (error: unknown): Reply => {
  console.error('[BrowserProfiles] IPC handler failed:', error);
  return { success: false, msg: error instanceof Error ? error.message : String(error) };
};

/**
 * The request's `agentId` when it is a string, but never the default Agent's: its profile is shared by every chat
 * without an Agent and is not the user's to clear or delete. The profile helpers validate it as an Agent id.
 */
const agentIdOf = (request: unknown): string | null => {
  const agentId = (request as { agentId?: unknown } | null)?.agentId;
  return typeof agentId === 'string' && agentId !== DEFAULT_AGENT_ID ? agentId : null;
};

/** A lowercase host name such as `gohighlevel.com`. */
const DOMAIN_RE = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/;
const MAX_IMPORT_DOMAINS = 100;
const MAX_PROFILE_DIR_CHARS = 255;

/** A cookie import request; the source is named, never a path: main looks its cookie DB up itself. */
const cookieImportRequest = z
  .object({
    browser: z.enum(['chrome', 'brave', 'edge', 'arc', 'vivaldi']),
    profileDir: z.string().min(1).max(MAX_PROFILE_DIR_CHARS),
    target: z.unknown(),
    domains: z.array(z.string().regex(DOMAIN_RE)).min(1).max(MAX_IMPORT_DOMAINS).nullable(),
  })
  .strict();

/** The renderer's cookie import (spec R7): user-initiated from the UI only, and it answers with counts. */
function registerCookieImportIpc(): void {
  ipcBridge.browser.cookieImport.listSources.provider(async () => {
    try {
      const sources = await detectBrowserSources(app.getPath('home'));
      return {
        success: true,
        data: sources.map(({ browser, profileDir, profileName }) => ({ browser, profileDir, profileName })),
      };
    } catch (error) {
      return failure(error);
    }
  });
  ipcBridge.browser.cookieImport.run.provider(async (request) => {
    const parsed = cookieImportRequest.safeParse(request);
    const target = parsed.success ? parseBrowserTabProfile(parsed.data.target) : null;
    if (!parsed.success || !target) return INVALID;
    const { browser, profileDir, domains } = parsed.data;
    try {
      const sources = await detectBrowserSources(app.getPath('home'));
      const source = sources.find((known) => known.browser === browser && known.profileDir === profileDir);
      if (!source) return { success: false, msg: 'That browser profile was not found' };
      return { success: true, data: await importCookies(source, target, domains) };
    } catch (error) {
      return failure(error);
    }
  });
}

/** The renderer's browser-profile IPC: a tab's partition (its session set up first), and clearing or deleting data. */
export function registerBrowserProfileIpc(): void {
  registerCookieImportIpc();
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
      const partition = agentPartition(agentId);
      await clearBrowsingData(session.fromPartition(partition));
      forgetPermissions(partition);
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
        closeLiveContents: async (target) => {
          // The pane drops the profile's tabs (on screen, background and stored); main closes whatever is left.
          ipcBridge.browser.profileRemoved.emit({ agentId });
          await closeSessionContents(target as Electron.Session);
        },
        unloadExtensions: (target) => unloadExtensions(target as Electron.Session),
        removeDir: (dir) => fs.rm(dir, { recursive: true, force: true }),
        forgetPartition: (partition) => {
          forgetBrowserSession(partition);
          forgetPermissions(partition);
        },
      });
      return { success: true };
    } catch (error) {
      return failure(error);
    }
  });
}
