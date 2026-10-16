/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import path from 'path';
import { ipcBridge } from '@/common';
import type { PermissionRequest, PromptPermission } from '@/common/types/browser';

export type PermissionDecision = 'allow' | 'deny' | 'ask';
/** origin -> permission -> decision */
export type PermissionStore = Record<string, Record<string, 'allow' | 'deny'>>;

const ASK_PERMISSIONS = new Set<string>([
  'media',
  'geolocation',
  'notifications',
  'clipboard-read',
  'midi',
  'midiSysex',
] satisfies PromptPermission[]);
const ALWAYS_ALLOW_PERMISSIONS = new Set(['fullscreen', 'pointerLock', 'clipboard-sanitized-write']);
const PROMPT_TIMEOUT_MS = 60_000;
/** Prompts the user dismissed without remembering, per origin+permission, before the site stops asking. */
const MAX_PROMPT_DISMISSALS = 3;
/** Bounds the prompt queue so a page cannot stack prompts (e.g. iframes on endless origins). */
export const MAX_OPEN_PERMISSION_PROMPTS = 3;

const isPromptPermission = (permission: string): permission is PromptPermission => ASK_PERMISSIONS.has(permission);

/** Always-allow permissions first, then a remembered answer for the origin; anything outside the ask set is denied. */
export function decidePermission(permission: string, origin: string, store: PermissionStore): PermissionDecision {
  if (ALWAYS_ALLOW_PERMISSIONS.has(permission)) return 'allow';
  if (!ASK_PERMISSIONS.has(permission)) return 'deny';
  return store[origin]?.[permission] ?? 'ask';
}

/** Returns a new store with the answer recorded; the input is left unchanged. */
export function rememberPermission(
  store: PermissionStore,
  origin: string,
  permission: string,
  allow: boolean
): PermissionStore {
  return { ...store, [origin]: { ...store[origin], [permission]: allow ? 'allow' : 'deny' } };
}

/** Reads the store; `{}` when the file is missing or corrupt. Entries that are not allow/deny are dropped. */
export function loadPermissionStore(file: string): PermissionStore {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {};
    const store: PermissionStore = {};
    for (const [origin, perms] of Object.entries(parsed)) {
      if (typeof perms !== 'object' || perms === null) continue;
      const valid: Record<string, 'allow' | 'deny'> = {};
      for (const [permission, value] of Object.entries(perms)) {
        if (value === 'allow' || value === 'deny') valid[permission] = value;
      }
      if (Object.keys(valid).length > 0) store[origin] = valid;
    }
    return store;
  } catch {
    return {};
  }
}

/** Writes the store atomically (temp file, then rename). */
export function savePermissionStore(file: string, store: PermissionStore): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, file);
  } finally {
    // After a successful rename the temp file is gone; after a failure this removes the leftover.
    rmSync(tmp, { force: true });
  }
}

type OpenRequest = { request: PermissionRequest; waiters: Array<(allow: boolean) => void>; timer: NodeJS.Timeout };

/** Open permission prompts. A request that is not answered within its timeout is denied. */
export class PendingPermissions {
  private readonly open = new Map<string, OpenRequest>();
  private readonly listeners = new Set<(open: PermissionRequest[]) => void>();

  /** Resolves with the user's answer; a request for an origin+permission that is already open shares its prompt. */
  request(req: Omit<PermissionRequest, 'id'>, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const existing = [...this.open.values()].find(
        (o) => o.request.origin === req.origin && o.request.permission === req.permission
      );
      if (existing) {
        existing.waiters.push(resolve);
        const mediaTypes = [...new Set([...existing.request.mediaTypes, ...req.mediaTypes])];
        if (mediaTypes.length > existing.request.mediaTypes.length) {
          // Replace rather than mutate so earlier snapshots stay intact; the prompt must show what Allow grants.
          this.open.set(existing.request.id, { ...existing, request: { ...existing.request, mediaTypes } });
          this.notify();
        }
        return;
      }
      if (this.open.size >= MAX_OPEN_PERMISSION_PROMPTS) {
        console.warn(`[BrowserSession] too many open permission prompts; denied ${req.permission} for ${req.origin}`);
        resolve(false);
        return;
      }
      const id = randomUUID();
      const timer = setTimeout(() => this.reply(id, false), timeoutMs);
      this.open.set(id, { request: { ...req, id }, waiters: [resolve], timer });
      this.notify();
    });
  }

  /** @returns false when the request is unknown (already answered or timed out) */
  reply(id: string, allow: boolean): boolean {
    const entry = this.open.get(id);
    if (!entry) return false;
    clearTimeout(entry.timer);
    this.open.delete(id);
    this.notify();
    entry.waiters.forEach((waiter) => waiter(allow));
    return true;
  }

  list(): PermissionRequest[] {
    return [...this.open.values()].map((o) => o.request);
  }

  onChange(cb: (open: PermissionRequest[]) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private notify(): void {
    const snapshot = this.list();
    this.listeners.forEach((cb) => cb(snapshot));
  }
}

const pending = new PendingPermissions();
let store: PermissionStore | undefined;
/** `origin permission` -> denials the user did not remember, this app session only. */
let dismissals = new Map<string, number>();

const dismissalKey = (origin: string, permission: string): string => `${origin} ${permission}`;

const storeFile = (): string => path.join(homedir(), '.aionui', 'browser-permissions.json');
const currentStore = (): PermissionStore => (store ??= loadPermissionStore(storeFile()));

/**
 * The origin of `url`, or null when it does not parse or is opaque (about:blank, data:, file:).
 * Extension pages are `chrome-extension://<id>`: URL gives non-web schemes an opaque origin.
 */
const originOf = (url: string | undefined): string | null => {
  if (!url) return null;
  try {
    const { origin, protocol, host } = new URL(url);
    if (protocol === 'chrome-extension:') return host ? `chrome-extension://${host}` : null;
    return origin === 'null' ? null : origin;
  } catch {
    return null;
  }
};

/** Prompts currently waiting for an answer. */
export function getPermissionRequests(): PermissionRequest[] {
  return pending.list();
}

/**
 * Answers an open prompt; with `remember` the answer is stored for the site.
 * @returns false when the prompt is unknown or already timed out
 */
export function replyPermission(id: string, allow: boolean, remember: boolean): boolean {
  const request = pending.list().find((r) => r.id === id);
  if (!request || !pending.reply(id, allow)) return false;
  // Esc, the mask, the close button and Block without "Remember" all land here. After a few, the
  // site is denied silently until restart so it cannot re-raise the prompt in a loop.
  if (!allow && !remember) {
    const key = dismissalKey(request.origin, request.permission);
    dismissals = new Map(dismissals).set(key, (dismissals.get(key) ?? 0) + 1);
  }
  if (remember) {
    store = rememberPermission(currentStore(), request.origin, request.permission, allow);
    try {
      savePermissionStore(storeFile(), store);
    } catch (error) {
      // The answer still holds for this run.
      console.error('[BrowserSession] failed to save permission decisions:', error);
    }
  }
  return true;
}

/** Applies the permission policy to a session and publishes open prompts to the renderer. */
export function installPermissions(browserSession: Electron.Session): void {
  pending.onChange((open) => ipcBridge.browser.permissionRequested.emit(open));

  browserSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = originOf(details.requestingUrl ?? webContents.getURL());
    if (!origin) return callback(false);
    const decision = decidePermission(permission, origin, currentStore());
    if (decision !== 'ask' || !isPromptPermission(permission)) return callback(decision === 'allow');
    if ((dismissals.get(dismissalKey(origin, permission)) ?? 0) >= MAX_PROMPT_DISMISSALS) return callback(false);
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
    void pending.request({ origin, permission, mediaTypes }, PROMPT_TIMEOUT_MS).then(callback);
  });

  // Never prompts: it only reports what is already allowed.
  browserSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const origin = originOf(details.requestingUrl ?? requestingOrigin);
    return origin !== null && decidePermission(permission, origin, currentStore()) === 'allow';
  });
}

/** Test-only: drop open prompts and the cached store. */
export function __resetPermissionsForTests(): void {
  pending.list().forEach((r) => pending.reply(r.id, false));
  store = undefined;
  dismissals = new Map();
}
