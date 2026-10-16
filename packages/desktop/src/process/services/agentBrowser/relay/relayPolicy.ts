/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TabOwnership } from '@/common/types/browser';
import { isSafeUrl } from '@process/services/browserSession/urlSafety';
import type { RelayClient } from './targetRegistry';

export type PolicyContext = {
  client: RelayClient;
  method: string;
  params: Record<string, unknown>;
  /** The tab the command's session belongs to; null once it is gone. */
  tab: TabOwnership | null;
  /** Execution contexts this session created with `Page.createIsolatedWorld`. */
  ownContexts: ReadonlySet<number>;
};

export type PolicyDecision = { allow: true } | { allow: false; code: number; message: string };

export const POLICY_ERROR_CODE = -32000;

/** Methods an agent may send on a tab session (spec §3.2). `Input.*` is allowed by prefix. */
const ALLOWED_METHODS = new Set([
  'Runtime.evaluate',
  'Runtime.callFunctionOn',
  'Page.enable',
  'Page.navigate',
  'Page.reload',
  'Page.stopLoading',
  'Page.getNavigationHistory',
  'Page.navigateToHistoryEntry',
  'Page.getFrameTree',
  'Page.createIsolatedWorld',
  'Page.captureScreenshot',
  'Page.getLayoutMetrics',
  'Page.handleJavaScriptDialog',
  'Page.setInterceptFileChooserDialog',
  'DOM.enable',
  'DOM.getDocument',
  'DOM.getFrameOwner',
  'DOM.getBoxModel',
  'DOM.describeNode',
  'DOM.setFileInputFiles',
  'Emulation.setFocusEmulationEnabled',
]);

const deny = (message: string): PolicyDecision => ({ allow: false, code: POLICY_ERROR_CODE, message });

/** True when `client` may drive the tab: it opened it, or the user shared it. */
export const mayAct = (tab: TabOwnership | null, client: RelayClient): boolean =>
  tab !== null && (tab.sharedWith === 'all' || (tab.owner !== 'user' && tab.owner.clientId === client.clientId));

const isOwnContext = (value: unknown, ownContexts: ReadonlySet<number>): boolean =>
  typeof value === 'number' && ownContexts.has(value);

/** Script may only run in isolated worlds this session created, never in the page's main world. */
const decideRuntime = ({ method, params, ownContexts }: PolicyContext): PolicyDecision => {
  const ownWorld =
    method === 'Runtime.evaluate'
      ? params.uniqueContextId === undefined && isOwnContext(params.contextId, ownContexts)
      : params.objectId === undefined && isOwnContext(params.executionContextId, ownContexts);
  return ownWorld ? { allow: true } : deny(`${method} needs an isolated-world context this client created`);
};

/**
 * Decides whether an agent's command on a tab session may reach the page (spec §3.2): the method
 * allowlist, tab ownership, the user take-over pause, own isolated worlds and web-only navigation.
 */
export function decideRelayCommand(ctx: PolicyContext): PolicyDecision {
  const { method, params, tab } = ctx;
  const isInput = method.startsWith('Input.');
  if (!isInput && !ALLOWED_METHODS.has(method)) return deny(`${method} is not allowed for agents`);
  if (!tab) return deny('No such target: the tab is gone');
  if (!mayAct(tab, ctx.client)) return deny('This tab is not shared with agents');
  if (isInput && tab.paused) return deny('Paused: the user took over this tab. Wait for the user to resume.');
  if (method.startsWith('Runtime.')) return decideRuntime(ctx);
  if (method === 'Page.navigate' && !(typeof params.url === 'string' && isSafeUrl(params.url))) {
    return deny('Page.navigate only accepts http(s) urls');
  }
  return { allow: true };
}
