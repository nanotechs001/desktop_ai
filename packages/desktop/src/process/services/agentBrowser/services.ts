/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { onBrowserContentsCreated } from '@process/services/browserSession/browserSession';
import { PendingConfirms } from './confirmGate';
import { startRelayServer } from './relay/relayServer';
import { createTargetRegistry, type TargetRegistry } from './relay/targetRegistry';
import { CreateTabWaiter, offerNewTab } from './tabWaiter';

export type AgentBrowserServices = { url: string; token: string; close(): Promise<void> };

export type AgentBrowserOptions = {
  /** The user's "let agents drive the browser" setting; when off only the IPC answers (with an error). */
  enabled: boolean;
  /** Loopback ports agents must not open besides the relay's own, e.g. the backend's. */
  blockedPorts: () => readonly number[];
};

type Reply<D = undefined> = { success: boolean; data?: D; msg?: string };

const TAB_CREATE_TIMEOUT_MS = 15_000;
/** A keyDown of one of these alone is not the user taking over (e.g. Cmd held for a shortcut). */
const MODIFIER_KEYS = new Set(['Meta', 'Shift', 'Alt', 'Control']);
const OFF: Reply = { success: false, msg: 'Agent browser control is off' };
const UNKNOWN_TAB: Reply = { success: false, msg: 'No such browser tab' };
const INVALID: Reply = { success: false, msg: 'Invalid arguments' };
const UNKNOWN_CONFIRM: Reply = { success: false, msg: 'No such confirmation' };

/** Pauses agent input on a tab the user types or clicks in (agent-owned or shared tabs only). */
const watchUserInput = (contents: Electron.WebContents, registry: TargetRegistry): void => {
  contents.on('before-input-event', (_event, input) => {
    if (input.type === 'keyDown' && !MODIFIER_KEYS.has(input.key)) {
      registry.noteUserInput(contents.id, { kind: 'key', key: input.key, code: input.code });
    }
  });
  contents.on('before-mouse-event', (_event, mouse) => {
    if (mouse.type !== 'mouseDown') return;
    // Electron reports zoomed (DIP) coordinates; CDP input uses CSS px (measured on 37.10.3).
    const zoom = contents.getZoomFactor() || 1;
    registry.noteUserInput(contents.id, { kind: 'mouse', x: mouse.x / zoom, y: mouse.y / zoom });
  });
};

const guard = async <D>(handler: () => Reply<D>): Promise<Reply<D>> => {
  try {
    return handler();
  } catch (error) {
    console.error('[AgentBrowser] IPC handler failed:', error);
    return { success: false, msg: error instanceof Error ? error.message : String(error) };
  }
};

/** The pane's IPC: answered always, with an error while the relay is off. WebUI clients count as the owner. */
const registerProviders = (getRegistry: () => TargetRegistry | null, confirms: PendingConfirms): void => {
  ipcBridge.agentBrowser.getOwnership.provider(() =>
    guard(() => {
      const registry = getRegistry();
      return registry ? { success: true, data: registry.all() } : OFF;
    })
  );
  ipcBridge.agentBrowser.share.provider(({ webContentsId, on }) =>
    guard(() => {
      if (!Number.isInteger(webContentsId) || typeof on !== 'boolean') return INVALID;
      const registry = getRegistry();
      if (!registry) return OFF;
      if (!registry.ownership(webContentsId)) return UNKNOWN_TAB;
      registry.share(webContentsId, on);
      return { success: true };
    })
  );
  ipcBridge.agentBrowser.resume.provider(({ webContentsId }) =>
    guard(() => {
      if (!Number.isInteger(webContentsId)) return INVALID;
      const registry = getRegistry();
      if (!registry) return OFF;
      if (!registry.ownership(webContentsId)) return UNKNOWN_TAB;
      registry.setPaused(webContentsId, false);
      return { success: true };
    })
  );
  ipcBridge.agentBrowser.getConfirmRequests.provider(() => guard(() => ({ success: true, data: confirms.list() })));
  ipcBridge.agentBrowser.replyConfirm.provider(({ id, allow, alwaysForSite }) =>
    guard(() => {
      if (typeof id !== 'string' || typeof allow !== 'boolean' || typeof alwaysForSite !== 'boolean') return INVALID;
      return confirms.reply(id, allow, alwaysForSite) ? { success: true } : UNKNOWN_CONFIRM;
    })
  );
};

/**
 * Registers the agent-browser IPC and, when enabled, starts the agent relay over the in-app browser's
 * tabs. Call before the backend spawns (its env carries the relay url/token) and before the renderer
 * loads, so every browser tab is seen as it is created. Resolves null when disabled.
 */
export async function startAgentBrowserServices(options: AgentBrowserOptions): Promise<AgentBrowserServices | null> {
  let active: TargetRegistry | null = null;
  const confirms = new PendingConfirms();
  registerProviders(() => active, confirms);
  if (!options.enabled) return null;

  const registry = createTargetRegistry();
  const waiter = new CreateTabWaiter<Electron.WebContents>();
  // One listener, so a new tab is tracked before the relay's createTarget waiter receives it.
  onBrowserContentsCreated((contents) => {
    registry.track(contents);
    watchUserInput(contents, registry);
    if (contents.getType() === 'webview') offerNewTab(waiter, contents);
  });
  registry.onChange((all) => ipcBridge.agentBrowser.ownershipChanged.emit(all));
  confirms.onChange((open) => ipcBridge.agentBrowser.confirmRequested.emit(open));

  const relay = await startRelayServer({
    registry,
    openTab: (url) => ipcBridge.browser.openTabRequested.emit({ url, background: false }),
    waitForTab: (url) => waiter.wait(url, TAB_CREATE_TIMEOUT_MS),
    closeTab: (webContentsId) => ipcBridge.browser.closeTabRequested.emit({ webContentsId }),
    onAgentAction: (event) => ipcBridge.agentBrowser.agentAction.emit(event),
    requestConfirm: (request, signal) => confirms.request(request, undefined, signal),
    blockedPorts: options.blockedPorts,
  });
  active = registry;
  return { url: relay.url, token: relay.token, close: relay.close };
}
