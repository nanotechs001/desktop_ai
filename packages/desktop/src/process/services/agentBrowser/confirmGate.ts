/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Also bundled into the standalone aion-browser MCP (isRiskyLabel): no electron imports here.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import type { ConfirmRequest } from '@/common/types/browser';

/** An unanswered confirm is denied after this long. */
export const CONFIRM_TIMEOUT_MS = 120_000;

const RISKY_WORDS =
  /\b(?:publish|send|pay|purchase|place\s+order|checkout|delete|remove|transfer|subscribe|unsubscribe|post|submit)\b/i;

/** True when a control's label names an action that is hard to undo (whole words, case-insensitive). */
export const isRiskyLabel = (label: string): boolean => RISKY_WORDS.test(label);

/** The origin of an http(s) page url; null for anything else (about:, data:, file:, extensions, garbage). */
export const webOriginOf = (url: string): string | null => {
  try {
    const { origin, protocol } = new URL(url);
    return protocol === 'http:' || protocol === 'https:' ? origin : null;
  } catch {
    return null;
  }
};

const defaultAllowFile = (): string => path.join(homedir(), '.aionui', 'browser-allow.json');

/** The file is a short list; anything bigger is not ours and reads as empty. */
const MAX_ALLOW_FILE_BYTES = 64 * 1024;
const MAX_ALLOWED_ENTRIES = 500;

/**
 * What "Always allow" remembers: the page origin, and, for a control in a frame of another origin, the pair
 * `page|frame`, so a site allowed at the top never covers a risky control inside an embedded cross-origin frame.
 */
export const allowKey = ({ origin, frameOrigin }: Pick<ConfirmRequest, 'origin' | 'frameOrigin'>): string | null => {
  if (frameOrigin === null) return null; // an opaque origin is nobody in particular
  return origin === frameOrigin ? origin : `${origin}|${frameOrigin}`;
};

/** Origin keys the user chose "Always allow" for; empty when the file is missing, oversized or corrupt. */
export function loadAllowedOrigins(file: string): ReadonlySet<string> {
  try {
    if (statSync(file).size > MAX_ALLOW_FILE_BYTES) return new Set();
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const origins = (parsed as { origins?: unknown } | null)?.origins;
    const strings = Array.isArray(origins) ? origins.filter((o): o is string => typeof o === 'string') : [];
    return new Set(strings.slice(0, MAX_ALLOWED_ENTRIES));
  } catch {
    return new Set();
  }
}

/** When the file last changed; -1 when it is missing. */
const mtimeOf = (file: string): number => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
};

/** Writes the allowed origins atomically (temp file, then rename). */
function saveAllowedOrigins(file: string, origins: ReadonlySet<string>): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify({ origins: [...origins] }, null, 2));
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true }); // gone after a successful rename; removes the leftover after a failure
  }
}

type Open = { request: ConfirmRequest; resolve: (allow: boolean) => void; release: () => void };

/** Risky agent actions waiting for the user. Unanswered, aborted and unknown requests are all denials. */
export class PendingConfirms {
  private readonly open = new Map<string, Open>();
  private readonly listeners = new Set<(open: ConfirmRequest[]) => void>();
  private readonly file: string;
  /** The allow list as of the file's `mtime`; read again whenever the file changed. */
  private allowed: { mtime: number; origins: ReadonlySet<string> } | undefined;

  constructor({ file = defaultAllowFile() }: { file?: string } = {}) {
    this.file = file;
  }

  /**
   * Resolves with the user's answer at once when the origin is always allowed, else once they answer. Denies after
   * `timeoutMs` and when `signal` aborts (the tab navigated or closed, the agent left).
   */
  request(req: Omit<ConfirmRequest, 'id'>, timeoutMs = CONFIRM_TIMEOUT_MS, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    const key = allowKey(req);
    if (key !== null && this.allowedOrigins().has(key)) return Promise.resolve(true);
    return new Promise((resolve) => {
      const id = randomUUID();
      const deny = (): void => void this.reply(id, false, false);
      const timer = setTimeout(deny, timeoutMs);
      signal?.addEventListener('abort', deny, { once: true });
      const release = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', deny);
      };
      this.open.set(id, { request: { ...req, id }, resolve, release });
      this.notify();
    });
  }

  /** Answers an open confirm; `alwaysForSite` on an Allow remembers its origin. False when the id is unknown. */
  reply(id: string, allow: boolean, alwaysForSite: boolean): boolean {
    const entry = this.open.get(id);
    if (!entry) return false;
    entry.release();
    this.open.delete(id);
    const key = allowKey(entry.request);
    if (allow && alwaysForSite && key !== null) this.remember(key);
    this.notify();
    entry.resolve(allow);
    return true;
  }

  list(): ConfirmRequest[] {
    return [...this.open.values()].map((o) => o.request);
  }

  onChange(cb: (open: ConfirmRequest[]) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }

  private allowedOrigins(): ReadonlySet<string> {
    const mtime = mtimeOf(this.file);
    if (this.allowed?.mtime !== mtime) this.allowed = { mtime, origins: loadAllowedOrigins(this.file) };
    return this.allowed.origins;
  }

  private remember(key: string): void {
    // The newest entries win once the list is full.
    const origins = new Set([...this.allowedOrigins(), key].slice(-MAX_ALLOWED_ENTRIES));
    try {
      saveAllowedOrigins(this.file, origins);
      this.allowed = { mtime: mtimeOf(this.file), origins };
    } catch (error) {
      // The answer still holds for this run: the unchanged file keeps the cached list.
      this.allowed = { mtime: this.allowed?.mtime ?? mtimeOf(this.file), origins };
      console.error('[AgentBrowser] failed to save allowed sites:', error);
    }
  }

  private notify(): void {
    const snapshot = this.list();
    this.listeners.forEach((cb) => cb(snapshot));
  }
}
