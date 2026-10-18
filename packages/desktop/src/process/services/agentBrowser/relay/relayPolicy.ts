/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/*
 * Threat model (controller ruling P2-H). Agents with shell access already run with the user's full
 * permissions, and agent-spawned processes inherit the relay token, so the relay cannot sandbox a
 * shell-capable agent; keeping agents out of the user's logged-in sites would also defeat the product.
 * The relay's job is therefore:
 *   (a) keep web pages and non-app processes out (loopback, token, no Origin, no HTTP discovery);
 *   (b) give the MCP tools (our code) a minimal, safe CDP surface (this file);
 *   (c) keep the user in control: ownership, take-over pause and confirmation.
 * No per-origin approval, by design. Each Agent browses in its own profile (Task 14), and sharing reaches only the
 * shared tab's profile (ruling N-16).
 *
 * Accepted under P2-H: the url check guards the explicit navigation APIs (Page.navigate,
 * Target.createTarget), it is not a sandbox. Setting `location` from the agent's own isolated world, or
 * clicking a link, can still reach a blocked url.
 */

import type { TabOwnership } from '@/common/types/browser';
import { isAgentNavigableUrl } from './agentUrl';
import type { RelayClient } from './targetRegistry';

export type PolicyContext = {
  client: RelayClient;
  method: string;
  params: Record<string, unknown>;
  /** The tab the command's session belongs to; null once it is gone. */
  tab: TabOwnership | null;
  /** Execution contexts this session created with `Page.createIsolatedWorld` in the current document. */
  ownContexts: ReadonlySet<number>;
  /** Loopback ports agents must never navigate to (the relay's own, the backend's). */
  blockedPorts: ReadonlySet<number>;
};

export type PolicyDecision = { allow: true } | { allow: false; code: number; message: string };

export const POLICY_ERROR_CODE = -32000;

const keys = (...names: string[]): ReadonlySet<string> => new Set(names);
const MOUSE_KEYS = ['type', 'x', 'y', 'modifiers', 'timestamp', 'button', 'buttons', 'clickCount'] as const;

/**
 * Methods an agent may send on a tab session and the params each accepts (spec §3.2, ruling P2-G:
 * no file inputs or file choosers). Anything else, and any unknown param, is denied.
 */
const ALLOWED_PARAMS: Readonly<Record<string, ReadonlySet<string>>> = {
  'Runtime.evaluate': keys(
    'expression',
    'contextId',
    'objectGroup',
    'includeCommandLineAPI',
    'silent',
    'returnByValue',
    'generatePreview',
    'userGesture',
    'awaitPromise',
    'throwOnSideEffect',
    'timeout',
    'allowUnsafeEvalBlockedByCSP',
    'serializationOptions'
  ),
  'Runtime.callFunctionOn': keys(
    'functionDeclaration',
    'executionContextId',
    'arguments',
    'silent',
    'returnByValue',
    'generatePreview',
    'userGesture',
    'awaitPromise',
    'objectGroup',
    'throwOnSideEffect',
    'serializationOptions'
  ),
  'Page.enable': keys(),
  'Page.navigate': keys('url', 'frameId', 'transitionType', 'referrer', 'referrerPolicy'),
  // Handled by the relay with webContents.reload(): CDP Page.reload on a webview guest reloads the
  // embedder (the AionUi window), measured on Electron 37.10.3.
  'Page.reload': keys('ignoreCache'),
  'Page.stopLoading': keys(),
  'Page.getNavigationHistory': keys(),
  // No Page.navigateToHistoryEntry: the entry's url would bypass the url check; agents go back with keys.
  'Page.getFrameTree': keys(),
  'Page.createIsolatedWorld': keys('frameId', 'worldName'),
  'Page.captureScreenshot': keys(
    'format',
    'quality',
    'clip',
    'fromSurface',
    'captureBeyondViewport',
    'optimizeForSpeed'
  ),
  'Page.getLayoutMetrics': keys(),
  'Page.handleJavaScriptDialog': keys('accept', 'promptText'),
  'DOM.enable': keys(),
  'DOM.getDocument': keys('depth', 'pierce'),
  'DOM.getFrameOwner': keys('frameId'),
  'DOM.getBoxModel': keys('nodeId', 'backendNodeId', 'objectId'),
  'DOM.describeNode': keys('nodeId', 'backendNodeId', 'objectId', 'depth', 'pierce'),
  // Only into the client's own isolated world (decideValues): act compares a frame's owner iframe with a hit test.
  'DOM.resolveNode': keys('backendNodeId', 'executionContextId'),
  'Emulation.setFocusEmulationEnabled': keys('enabled'),
  'Input.dispatchMouseEvent': keys(
    ...MOUSE_KEYS,
    'deltaX',
    'deltaY',
    'pointerType',
    'force',
    'tiltX',
    'tiltY',
    'twist',
    'tangentialPressure'
  ),
  'Input.dispatchKeyEvent': keys(
    'type',
    'modifiers',
    'timestamp',
    'text',
    'unmodifiedText',
    'keyIdentifier',
    'code',
    'key',
    'windowsVirtualKeyCode',
    'nativeVirtualKeyCode',
    'autoRepeat',
    'isKeypad',
    'isSystemKey',
    'location',
    'commands'
  ),
  'Input.insertText': keys('text'),
  'Input.imeSetComposition': keys('text', 'selectionStart', 'selectionEnd', 'replacementStart', 'replacementEnd'),
  'Input.dispatchTouchEvent': keys('type', 'touchPoints', 'modifiers', 'timestamp'),
  'Input.setInterceptDrags': keys('enabled'),
  'Input.dispatchDragEvent': keys('type', 'x', 'y', 'data', 'modifiers'),
};

/** Refused while the user has taken over the tab. */
const PAUSED_PREFIXES = ['Input.', 'Runtime.'];
// Everything that moves the page or answers its dialogs (a beforeunload "Leave" navigates too).
const PAUSED_METHODS = new Set(['Page.navigate', 'Page.reload', 'Page.stopLoading', 'Page.handleJavaScriptDialog']);

const ALLOWED = { allow: true } as const;
const deny = (message: string): PolicyDecision => ({ allow: false, code: POLICY_ERROR_CODE, message });

/** True when `client` may drive the tab: it opened it, or the user shared it with the agents of its profile. */
export const mayAct = (tab: TabOwnership | null, client: RelayClient): boolean => {
  if (tab === null) return false;
  if (tab.owner !== 'user' && tab.owner.clientId === client.clientId) return true;
  if (tab.sharedWith !== 'all') return false;
  // Ruling N-16: a shared Personal tab is open to every client; a shared Agent-profile tab only to that Agent's.
  if (tab.profile.kind === 'personal') return true;
  // A regular chat's temporary tab is only ever its own chat's: nothing crosses between chats.
  if (tab.profile.kind === 'temporary') {
    return client.profile?.kind === 'temporary' && client.profile.conversationId === tab.profile.conversationId;
  }
  return client.profile?.kind === 'agent' && client.profile.agentId === tab.profile.agentId;
};

const isOwnContext = (value: unknown, ownContexts: ReadonlySet<number>): boolean =>
  typeof value === 'number' && ownContexts.has(value);

/** Script may only run in isolated worlds this session created, never in the page's main world. */
const decideRuntime = ({ method, params, ownContexts }: PolicyContext): PolicyDecision => {
  if (params.includeCommandLineAPI === true || params.allowUnsafeEvalBlockedByCSP === true) {
    return deny(`${method}: includeCommandLineAPI and allowUnsafeEvalBlockedByCSP are not allowed`);
  }
  const contextId = method === 'Runtime.evaluate' ? params.contextId : params.executionContextId;
  return isOwnContext(contextId, ownContexts)
    ? ALLOWED
    : deny(`${method} needs an isolated-world context this client created in the current page`);
};

const hasDraggedFiles = (data: unknown): boolean => {
  const files = data && typeof data === 'object' ? (data as { files?: unknown }).files : undefined;
  return Array.isArray(files) && files.length > 0;
};

/** Value checks for the few methods whose allowed params can still do harm. */
const decideValues = (ctx: PolicyContext): PolicyDecision => {
  const { method, params } = ctx;
  if (method.startsWith('Runtime.')) return decideRuntime(ctx);
  if (method === 'Page.navigate') {
    const url = params.url;
    if (typeof url === 'string' && isAgentNavigableUrl(url, ctx.blockedPorts)) return ALLOWED;
    return deny('Page.navigate only accepts web urls outside link-local, metadata and app-internal addresses');
  }
  if (method === 'DOM.resolveNode' && !isOwnContext(params.executionContextId, ctx.ownContexts)) {
    return deny('DOM.resolveNode needs an isolated-world context this client created in the current page');
  }
  if (method === 'Input.dispatchDragEvent' && hasDraggedFiles(params.data))
    return deny('Dragging files is not allowed');
  return ALLOWED;
};

/**
 * Decides whether an agent's command on a tab session may reach the page (spec §3.2): the method and
 * param allowlist, tab ownership, the user take-over pause, own isolated worlds and safe navigation.
 */
export function decideRelayCommand(ctx: PolicyContext): PolicyDecision {
  const { method, params, tab } = ctx;
  const allowedParams = Object.hasOwn(ALLOWED_PARAMS, method) ? ALLOWED_PARAMS[method] : undefined;
  if (!allowedParams) return deny(`${method} is not allowed for agents`);
  const unknown = Object.keys(params).find((key) => !allowedParams.has(key));
  if (unknown) return deny(`${method}: param "${unknown}" is not allowed for agents`);
  if (!tab) return deny('No such target: the tab is gone');
  if (!mayAct(tab, ctx.client)) return deny('This tab is not shared with agents');
  // Switching drag interception off ends an agent drag the user interrupted; left on, it would eat the user's drags.
  const endsDrag = method === 'Input.setInterceptDrags' && params.enabled === false;
  const pausable =
    !endsDrag && (PAUSED_METHODS.has(method) || PAUSED_PREFIXES.some((prefix) => method.startsWith(prefix)));
  if (tab.paused && pausable) return deny('Paused: the user took over this tab. Wait for the user to resume.');
  return decideValues(ctx);
}
