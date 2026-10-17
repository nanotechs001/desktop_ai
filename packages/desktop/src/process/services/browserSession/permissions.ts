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
import { BROWSER_SESSION_PARTITION } from '@/common/config/constants';
import type { PermissionRequest, PromptPermission } from '@/common/types/browser';
import { profileOfPartition } from './profiles/browserProfiles';

export type PermissionDecision = 'allow' | 'deny' | 'ask';
/** origin -> permission -> decision */
export type PermissionStore = Record<string, Record<string, 'allow' | 'deny'>>;
/** browser partition -> its own remembered decisions (ruling N-17) */
export type PermissionStores = Record<string, PermissionStore>;

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

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** One partition's decisions from untrusted JSON; entries that are not allow/deny are dropped. */
const parseStore = (value: unknown): PermissionStore => {
  const store: PermissionStore = {};
  if (!isRecord(value)) return store;
  for (const [origin, perms] of Object.entries(value)) {
    if (!isRecord(perms)) continue;
    const valid: Record<string, 'allow' | 'deny'> = {};
    for (const [permission, decision] of Object.entries(perms)) {
      if (decision === 'allow' || decision === 'deny') valid[permission] = decision;
    }
    if (Object.keys(valid).length > 0) store[origin] = valid;
  }
  return store;
};

/**
 * Reads every partition's decisions from `{ partitions: { <partition>: store } }`; `{}` when the file is missing or
 * corrupt. A flat file from before browser profiles is Personal's store.
 */
export function loadPermissionStores(file: string): PermissionStores {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    if (!isRecord(parsed)) return {};
    if (!isRecord(parsed.partitions)) {
      const personal = parseStore(parsed);
      return Object.keys(personal).length > 0 ? { [BROWSER_SESSION_PARTITION]: personal } : {};
    }
    return Object.fromEntries(
      Object.entries(parsed.partitions)
        .filter(([, store]) => isRecord(store))
        .map(([partition, store]) => [partition, parseStore(store)])
    );
  } catch {
    return {};
  }
}

/** Writes every partition's decisions atomically (temp file, then rename). */
export function savePermissionStores(file: string, stores: PermissionStores): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ partitions: stores }, null, 2));
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

  /**
   * Resolves with the user's answer; a request for an origin+permission that is already open in the same partition
   * shares its prompt.
   */
  request(req: Omit<PermissionRequest, 'id'>, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const existing = [...this.open.values()].find(
        (o) =>
          o.request.origin === req.origin &&
          o.request.permission === req.permission &&
          o.request.partition === req.partition
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
let stores: PermissionStores | undefined;
/** `partition origin permission` -> denials the user did not remember, this app session only. */
let dismissals = new Map<string, number>();

const dismissalKey = (partition: string, origin: string, permission: string): string =>
  `${partition} ${origin} ${permission}`;

const storeFile = (): string => path.join(homedir(), '.aionui', 'browser-permissions.json');
const currentStores = (): PermissionStores => (stores ??= loadPermissionStores(storeFile()));
const storeOf = (partition: string): PermissionStore => currentStores()[partition] ?? {};

const saveStores = (next: PermissionStores): void => {
  stores = next;
  try {
    savePermissionStores(storeFile(), next);
  } catch (error) {
    // The decisions still hold for this run.
    console.error('[BrowserSession] failed to save permission decisions:', error);
  }
};

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
    const key = dismissalKey(request.partition, request.origin, request.permission);
    dismissals = new Map(dismissals).set(key, (dismissals.get(key) ?? 0) + 1);
  }
  if (remember) {
    const { partition, origin, permission } = request;
    saveStores({ ...currentStores(), [partition]: rememberPermission(storeOf(partition), origin, permission, allow) });
  }
  return true;
}

/** Drops every decision remembered in a partition (its Agent's browser data was cleared or deleted). */
export function forgetPermissions(partition: string): void {
  dismissals = new Map([...dismissals].filter(([key]) => !key.startsWith(`${partition} `)));
  if (!(partition in currentStores())) return;
  saveStores(Object.fromEntries(Object.entries(currentStores()).filter(([key]) => key !== partition)));
}

/** Every browser profile shares one prompt list, so it is published once however many sessions install it. */
let publishing = false;

/**
 * Applies the permission policy to the browser session of `partition`, with that partition's own remembered
 * decisions, and publishes open prompts to the renderer.
 */
export function installPermissions(browserSession: Electron.Session, partition: string): void {
  const profile = profileOfPartition(partition);
  if (!profile) throw new Error(`Not a browser profile partition: ${partition}`);
  if (!publishing) {
    publishing = true;
    pending.onChange((open) => ipcBridge.browser.permissionRequested.emit(open));
  }

  browserSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
    const origin = originOf(details.requestingUrl ?? webContents.getURL());
    if (!origin) return callback(false);
    const decision = decidePermission(permission, origin, storeOf(partition));
    if (decision !== 'ask' || !isPromptPermission(permission)) return callback(decision === 'allow');
    if ((dismissals.get(dismissalKey(partition, origin, permission)) ?? 0) >= MAX_PROMPT_DISMISSALS) {
      return callback(false);
    }
    const mediaTypes = 'mediaTypes' in details ? (details.mediaTypes ?? []) : [];
    void pending.request({ origin, permission, mediaTypes, partition, profile }, PROMPT_TIMEOUT_MS).then(callback);
  });

  // Never prompts: it only reports what is already allowed.
  browserSession.setPermissionCheckHandler((_webContents, permission, requestingOrigin, details) => {
    const origin = originOf(details.requestingUrl ?? requestingOrigin);
    return origin !== null && decidePermission(permission, origin, storeOf(partition)) === 'allow';
  });
}

/** Test-only: drop open prompts and the cached store. */
export function __resetPermissionsForTests(): void {
  pending.list().forEach((r) => pending.reply(r.id, false));
  stores = undefined;
  dismissals = new Map();
}
