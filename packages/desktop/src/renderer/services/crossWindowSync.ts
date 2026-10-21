/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { mutate } from 'swr';
import { ipcBridge } from '@/common';
import { configService } from '@/common/config/configService';

/**
 * Every renderer window (the main window, each robot) keeps its own settings cache and SWR cache. A save in one of
 * them (the robot's embedded Agent editor, a switch and continue) is announced through main to the others, so a
 * later read-modify-write there does not drop it. Each window tags its news, so it ignores its own echo.
 */
const ORIGIN = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

const warn = (error: unknown) => console.warn('[crossWindowSync] could not tell the other windows:', error);

/** Desktop app only (the WebUI has one window). Returns the uninstall. */
export function installCrossWindowSync(): () => void {
  // Never throws into the write: the settings are saved either way.
  const offWrite = configService.onWrite((entries) => {
    try {
      ipcBridge.agentWidget.broadcastConfig.invoke({ origin: ORIGIN, entries }).catch(warn);
    } catch (error) {
      warn(error);
    }
  });
  const offConfig = ipcBridge.agentWidget.configChanged.on(({ origin, entries }) => {
    if (origin !== ORIGIN) configService.applyRemote(entries);
  });
  const offAssistants = ipcBridge.agentWidget.assistantsChanged.on(({ origin }) => {
    if (origin !== ORIGIN) void mutate('assistants.list');
  });
  return () => {
    offWrite();
    offConfig();
    offAssistants();
  };
}

/**
 * After this window changed an Agent (saved, created, deleted, re-pinned): the other windows reload the list. Never
 * throws: the change is already saved.
 */
export function afterAssistantsChanged(): void {
  try {
    ipcBridge.agentWidget.broadcastAssistantsChanged.invoke({ origin: ORIGIN }).catch(warn);
  } catch (error) {
    warn(error);
  }
}
