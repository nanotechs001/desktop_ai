/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { onBrowserContentsCreated } from '@process/services/browserSession/browserSession';
import { CreateTabWaiter } from '@process/services/browserSession/extensions';
import { startRelayServer } from './relay/relayServer';
import { createTargetRegistry, type TargetRegistry } from './relay/targetRegistry';

export type AgentBrowserServices = { url: string; token: string; close(): Promise<void> };

const TAB_CREATE_TIMEOUT_MS = 15_000;

/** Pauses agent input on a tab the user types or clicks in (agent-owned or shared tabs only). */
const watchUserInput = (contents: Electron.WebContents, registry: TargetRegistry): void => {
  contents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown') registry.noteUserInput(contents.id);
  });
  contents.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type === 'mouseDown') registry.noteUserInput(contents.id);
  });
};

const unknownTab = { success: false, msg: 'No such browser tab' };

/**
 * Starts the agent relay over the in-app browser's tabs and its IPC (ownership, share, resume).
 * Call before the backend spawns (its env carries the relay url/token) and before the renderer
 * loads, so every browser tab is seen as it is created.
 */
export async function startAgentBrowserServices(): Promise<AgentBrowserServices> {
  const registry = createTargetRegistry();
  const waiter = new CreateTabWaiter();

  // One listener, so a new tab is tracked before the relay's createTarget waiter receives it.
  onBrowserContentsCreated((contents) => {
    registry.track(contents);
    watchUserInput(contents, registry);
    if (contents.getType() === 'webview') waiter.onAttached(contents);
  });
  registry.onChange((all) => ipcBridge.agentBrowser.ownershipChanged.emit(all));

  ipcBridge.agentBrowser.getOwnership.provider(async () => registry.all());
  ipcBridge.agentBrowser.share.provider(async ({ webContentsId, on }) => {
    if (!registry.ownership(webContentsId)) return unknownTab;
    registry.share(webContentsId, on);
    return { success: true };
  });
  ipcBridge.agentBrowser.resume.provider(async ({ webContentsId }) => {
    if (!registry.ownership(webContentsId)) return unknownTab;
    registry.setPaused(webContentsId, false);
    return { success: true };
  });

  const relay = await startRelayServer({
    registry,
    openTab: (url) => ipcBridge.browser.openTabRequested.emit({ url, background: false }),
    waitForTab: (url) => waiter.wait(url, TAB_CREATE_TIMEOUT_MS),
    closeTab: (webContentsId) => ipcBridge.browser.closeTabRequested.emit({ webContentsId }),
    onAgentAction: (event) => ipcBridge.agentBrowser.agentAction.emit(event),
  });
  return { url: relay.url, token: relay.token, close: relay.close };
}
