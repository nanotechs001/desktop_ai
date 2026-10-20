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
import type { ConversationRuntimeMode } from '@/common/types/platform/acpTypes';

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

/** What an "Always allow" covers: risky clicks and keys, or page-console scripts. Each kind has its own list. */
export type AllowKind = 'click' | 'script';

/** Allowed origin keys per kind. */
type AllowLists = Readonly<Record<AllowKind, ReadonlySet<string>>>;

/** The allow file's field per kind; `origins` predates kinds and stays the click list, so older files still read. */
const ALLOW_FIELDS: Readonly<Record<AllowKind, string>> = { click: 'origins', script: 'scriptOrigins' };

const kindOf = ({ kind }: Pick<ConfirmRequest, 'kind'>): AllowKind => (kind === 'script' ? 'script' : 'click');

const listIn = (parsed: unknown, field: string): ReadonlySet<string> => {
  const entries = (parsed as Record<string, unknown> | null)?.[field];
  const strings = Array.isArray(entries) ? entries.filter((o): o is string => typeof o === 'string') : [];
  return new Set(strings.slice(0, MAX_ALLOWED_ENTRIES));
};

/** Every kind's allowed origin keys; all empty when the file is missing, oversized or corrupt. */
function loadAllowLists(file: string): AllowLists {
  try {
    if (statSync(file).size > MAX_ALLOW_FILE_BYTES) return { click: new Set(), script: new Set() };
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return { click: listIn(parsed, ALLOW_FIELDS.click), script: listIn(parsed, ALLOW_FIELDS.script) };
  } catch {
    return { click: new Set(), script: new Set() };
  }
}

/** Origin keys the user chose "Always allow" for, for one kind (risky clicks by default). */
export const loadAllowedOrigins = (file: string, kind: AllowKind = 'click'): ReadonlySet<string> =>
  loadAllowLists(file)[kind];

/** When the file last changed; -1 when it is missing. */
const mtimeOf = (file: string): number => {
  try {
    return statSync(file).mtimeMs;
  } catch {
    return -1;
  }
};

/** Writes the allow lists atomically (temp file, then rename); the script list only once it has entries. */
function saveAllowLists(file: string, lists: AllowLists): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    const script = lists.script.size > 0 ? { [ALLOW_FIELDS.script]: [...lists.script] } : {};
    writeFileSync(tmp, JSON.stringify({ [ALLOW_FIELDS.click]: [...lists.click], ...script }, null, 2));
    renameSync(tmp, file);
  } finally {
    rmSync(tmp, { force: true }); // gone after a successful rename; removes the leftover after a failure
  }
}

/** How long a chat's looked-up permission mode holds; a mode switch counts from the next ask after this. */
export const YOLO_CACHE_MS = 2000;
/** A mode lookup slower than this answers "not YOLO", so the user is asked. */
export const MODE_LOOKUP_TIMEOUT_MS = 5000;

/**
 * Mode ids that skip every permission ask (ruling R12). Catalog `yolo_id`s are not used: OpenCode's and MiMo's `build`
 * and Cursor's `agent` are their everyday modes.
 */
export const TRUE_BYPASS_MODES: ReadonlySet<string> = new Set([
  'bypassPermissions',
  'agent-full-access',
  'full-access',
  'yolo',
  'yoloNoSandbox',
]);

/** True when `mode` skips every permission ask, for any engine. */
export const isYoloMode = (mode: string | null | undefined): boolean => !!mode && TRUE_BYPASS_MODES.has(mode);

/** What main asks aioncore to learn a chat's current permission mode. */
export type ChatModeDeps = {
  /** The chat's live runtime mode; null for an unknown chat (404). Idle and team chats answer `live: false`. */
  runtimeMode(conversationId: string): Promise<ConversationRuntimeMode | null>;
};

/**
 * Whether a chat runs in YOLO mode right now, from aioncore, each answer kept `ttlMs` per chat. Fails safe: no live
 * runtime, an unknown chat, or a failed or slow lookup is "not YOLO" (and a failure is not kept), so the user is asked.
 */
export function createYoloLookup(
  deps: ChatModeDeps,
  { now = Date.now, ttlMs = YOLO_CACHE_MS }: { now?: () => number; ttlMs?: number } = {}
): (conversationId: string) => Promise<boolean> {
  const known = new Map<string, { at: number; yolo: boolean }>();
  const lookUp = async (conversationId: string): Promise<boolean> => {
    const runtime = await deps.runtimeMode(conversationId);
    return runtime?.live === true && isYoloMode(runtime.mode);
  };
  return async (conversationId) => {
    const at = now();
    // Expired answers go on every lookup, so chats never asked about again do not pile up.
    known.forEach((entry, id) => {
      if (at - entry.at >= ttlMs) known.delete(id);
    });
    const cached = known.get(conversationId);
    if (cached) return cached.yolo;
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('mode lookup timed out')), MODE_LOOKUP_TIMEOUT_MS);
    });
    try {
      const yolo = await Promise.race([lookUp(conversationId), timeout]);
      known.set(conversationId, { at: now(), yolo });
      return yolo;
    } catch (error) {
      console.warn('[AgentBrowser] could not read the chat permission mode, asking:', error);
      return false;
    } finally {
      clearTimeout(timer);
    }
  };
}

type Open = { request: ConfirmRequest; resolve: (allow: boolean) => void; release: () => void };

/** Risky agent actions waiting for the user. Unanswered, aborted and unknown requests are all denials. */
export class PendingConfirms {
  private readonly open = new Map<string, Open>();
  private readonly listeners = new Set<(open: ConfirmRequest[]) => void>();
  private readonly file: string;
  /** The allow lists as of the file's `mtime`; read again whenever the file changed. */
  private allowed: { mtime: number; lists: AllowLists } | undefined;
  /** Whether the asking chat runs in YOLO mode; absent, every ask is asked. */
  private readonly isYolo: ((conversationId: string) => Promise<boolean>) | undefined;

  constructor({
    file = defaultAllowFile(),
    isYolo,
  }: { file?: string; isYolo?: (conversationId: string) => Promise<boolean> } = {}) {
    this.file = file;
    this.isYolo = isYolo;
  }

  /**
   * Resolves with the user's answer at once when the origin is always allowed or `yoloChat` is in YOLO mode, else
   * once they answer. Denies after `timeoutMs` and when `signal` aborts (the tab navigated or closed, the agent left).
   * `yoloChat` is the asking connection's own chat, given only for its own unshared tab (rulings R13, R15); never
   * `req.conversationId`, which may be the tab owner's chat and only says where the ask shows.
   */
  request(
    req: Omit<ConfirmRequest, 'id'>,
    timeoutMs = CONFIRM_TIMEOUT_MS,
    signal?: AbortSignal,
    yoloChat?: string
  ): Promise<boolean> {
    if (signal?.aborted) return Promise.resolve(false);
    const key = allowKey(req);
    if (key !== null && this.allowLists()[kindOf(req)].has(key)) return Promise.resolve(true);
    // "Leave site?" guards the user's own unsaved text, not an agent permission: YOLO never answers it.
    if (req.kind === 'leave' || !yoloChat || !this.isYolo) return this.ask(req, timeoutMs, signal);
    return this.isYolo(yoloChat)
      .catch(() => false)
      .then((yolo) => {
        if (signal?.aborted) return false;
        if (!yolo) return this.ask(req, timeoutMs, signal);
        // Never the label or the code: they are page text and agent code.
        console.info(`[AgentBrowser] ${req.origin} ${kindOf(req)} auto-allowed (yolo)`);
        return true;
      });
  }

  private ask(req: Omit<ConfirmRequest, 'id'>, timeoutMs: number, signal?: AbortSignal): Promise<boolean> {
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

  /**
   * Answers an open confirm; `alwaysForSite` on an Allow remembers its origin for that kind of ask only, and allows the
   * other open asks it covers too. The allow list is app-wide, not per chat (M9): it also settles other chats' open asks
   * on that site. False when the id is unknown.
   */
  reply(id: string, allow: boolean, alwaysForSite: boolean): boolean {
    const entry = this.open.get(id);
    if (!entry) return false;
    const key = allowKey(entry.request);
    const kind = kindOf(entry.request);
    const remembered = allow && alwaysForSite && key !== null;
    if (remembered) this.remember(kind, key);
    const settled = remembered
      ? [...this.open.values()].filter((o) => kindOf(o.request) === kind && allowKey(o.request) === key)
      : [entry];
    settled.forEach((o) => {
      o.release();
      this.open.delete(o.request.id);
    });
    this.notify();
    settled.forEach((o) => o.resolve(allow));
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

  private allowLists(): AllowLists {
    const mtime = mtimeOf(this.file);
    if (this.allowed?.mtime !== mtime) this.allowed = { mtime, lists: loadAllowLists(this.file) };
    return this.allowed.lists;
  }

  private remember(kind: AllowKind, key: string): void {
    const current = this.allowLists();
    // The newest entries win once the list is full.
    const lists = { ...current, [kind]: new Set([...current[kind], key].slice(-MAX_ALLOWED_ENTRIES)) };
    try {
      saveAllowLists(this.file, lists);
      this.allowed = { mtime: mtimeOf(this.file), lists };
    } catch (error) {
      // The answer still holds for this run: the unchanged file keeps the cached lists.
      this.allowed = { mtime: this.allowed?.mtime ?? mtimeOf(this.file), lists };
      console.error('[AgentBrowser] failed to save allowed sites:', error);
    }
  }

  private notify(): void {
    const snapshot = this.list();
    this.listeners.forEach((cb) => cb(snapshot));
  }
}
