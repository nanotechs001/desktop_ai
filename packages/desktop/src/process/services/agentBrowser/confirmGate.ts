/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// Also bundled into the standalone aion-browser MCP (isRiskyLabel): no electron imports here.
import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
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

/** Origins the user chose "Always allow" for; empty when the file is missing or corrupt. */
export function loadAllowedOrigins(file: string): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    const origins = (parsed as { origins?: unknown } | null)?.origins;
    return new Set(Array.isArray(origins) ? origins.filter((o): o is string => typeof o === 'string') : []);
  } catch {
    return new Set();
  }
}

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
  private allowed: ReadonlySet<string> | undefined;

  constructor({ file = defaultAllowFile() }: { file?: string } = {}) {
    this.file = file;
  }

  /**
   * Resolves with the user's answer at once when the origin is always allowed, else once they answer. Denies after
   * `timeoutMs` and when `signal` aborts (the tab navigated or closed, the agent left).
   */
  request(req: Omit<ConfirmRequest, 'id'>, timeoutMs = CONFIRM_TIMEOUT_MS, signal?: AbortSignal): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    if (this.allowedOrigins().has(req.origin)) return Promise.resolve(true);
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
    if (allow && alwaysForSite) this.remember(entry.request.origin);
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
    return (this.allowed ??= loadAllowedOrigins(this.file));
  }

  private remember(origin: string): void {
    this.allowed = new Set([...this.allowedOrigins(), origin]);
    try {
      saveAllowedOrigins(this.file, this.allowed);
    } catch (error) {
      // The answer still holds for this run.
      console.error('[AgentBrowser] failed to save allowed sites:', error);
    }
  }

  private notify(): void {
    const snapshot = this.list();
    this.listeners.forEach((cb) => cb(snapshot));
  }
}
