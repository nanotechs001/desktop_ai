/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The agents' side of memory: `POST /api/memory/{search,read,save,log,retire}` on the token-guarded artifact server.
 * The vault is the chat's agent's (the chat's Pixebot, else the main agent) or the shared one; it is resolved from
 * the conversation here and never taken from the request. One chat may write a limited number of times per run.
 */

import { homedir } from 'node:os';
import path from 'node:path';

import { getEnvAwareName } from '@/common/config/appEnv';
import type {
  MemoryNote,
  MemoryNoteInput,
  MemoryNoteMeta,
  MemoryResult,
  MemoryVaultRef,
} from '@/common/types/agent/memory';
import { isChatId } from './memoryNote';
import { createMemoryStore, type MemoryStore } from './memoryStore';
import type { AgentResolution } from '../notes';

/** Writes (save, log, retire) one chat may make per app run. */
export const MEMORY_WRITES_PER_CHAT = 30;
const MAX_QUERY_CHARS = 200;
const DEFAULT_SEARCH_LIMIT = 5;
const MAX_SEARCH_LIMIT = 10;

export type MemoryApiDeps = {
  store: MemoryStore;
  resolveAgent: (conversationId: string) => Promise<AgentResolution>;
  writesPerChat?: number;
};

export type MemoryApiBody = Record<string, unknown> & { conversationId: string };
export type MemoryApiHandler = (op: string, body: MemoryApiBody) => Promise<unknown>;

type Scope = 'own' | 'shared';
type Reply = { ok: true; value: Record<string, unknown> } | { ok: false; error: string; message: string };

const badRequest = (message: string): Reply => ({ ok: false, error: 'bad-content', message });

/** A store failure as the API's answer (narrowed by hand: the union does not narrow on `ok` here). */
const failure = (result: MemoryResult<unknown>): Reply =>
  'error' in result ? { ok: false, error: result.error, message: result.message } : badRequest('Unexpected result');

const fromResult = <T>(result: MemoryResult<T>, toValue: (value: T) => Record<string, unknown>): Reply =>
  'value' in result ? { ok: true, value: toValue(result.value) } : failure(result);

/** What an agent sees of a note: page-sourced text is flagged, so it is never read as an instruction. */
const shown = (scope: Scope, note: MemoryNoteMeta | MemoryNote): Record<string, unknown> => ({
  scope,
  ...note,
  unverified: note.source === 'page',
});

const scopeOf = (value: unknown): Scope | null =>
  value === undefined || value === 'own' ? 'own' : value === 'shared' ? 'shared' : null;

const optionalOf = (b: MemoryApiBody, key: string, type: 'string' | 'boolean'): boolean =>
  b[key] === undefined || typeof b[key] === type;

/** The note fields of a save, as the store expects them; the store validates the values. */
const noteInput = (b: MemoryApiBody, fromChat: string): MemoryNoteInput => ({
  type: b.type as MemoryNoteInput['type'],
  title: b.title as string,
  summary: b.summary as string,
  body: b.body as string | undefined,
  tags: b.tags as string[] | undefined,
  confidence: b.confidence as MemoryNoteInput['confidence'],
  source: b.fromPage === true ? 'page' : 'agent',
  fromChat,
});

export function createMemoryApi({
  store,
  resolveAgent,
  writesPerChat = MEMORY_WRITES_PER_CHAT,
}: MemoryApiDeps): MemoryApiHandler {
  const writes = new Map<string, number>();

  const search = async (own: MemoryVaultRef, b: MemoryApiBody): Promise<Reply> => {
    if (typeof b.query !== 'string' || b.query.length > MAX_QUERY_CHARS) return badRequest('query must be text');
    const limit =
      typeof b.limit === 'number' ? Math.min(MAX_SEARCH_LIMIT, Math.max(1, Math.floor(b.limit))) : DEFAULT_SEARCH_LIMIT;
    const [mine, shared] = await Promise.all([
      store.search(own, b.query, limit),
      store.search({ kind: 'shared' }, b.query, limit),
    ]);
    if (!('value' in mine)) return failure(mine);
    if (!('value' in shared)) return failure(shared);
    const results = [
      ...mine.value.map((note) => shown('own', note)),
      ...shared.value.map((note) => shown('shared', note)),
    ];
    return { ok: true, value: { results } };
  };

  /** Notes the user wrote are theirs: an agent may read them but never change or retire them. */
  const refuseUserNote = async (vault: MemoryVaultRef, id: string): Promise<Reply | null> => {
    const note = await store.get(vault, id);
    if (!('value' in note)) return failure(note);
    return note.value.source === 'user' || note.value.type === 'instructions'
      ? { ok: false, error: 'forbidden', message: 'Only the user changes notes they wrote' }
      : null;
  };

  const save = async (vault: MemoryVaultRef, scope: Scope, b: MemoryApiBody): Promise<Reply> => {
    if (
      !optionalOf(b, 'id', 'string') ||
      !optionalOf(b, 'version', 'string') ||
      !optionalOf(b, 'supersede', 'boolean')
    ) {
      return badRequest('id and version must be text, supersede a boolean');
    }
    if (!optionalOf(b, 'fromPage', 'boolean')) return badRequest('fromPage must be a boolean');
    if (b.type === 'instructions') return badRequest('Only the user writes instructions');
    const input = noteInput(b, b.conversationId);
    const done = (action: string) => (note: MemoryNote) => ({
      saved: true,
      action,
      scope,
      id: note.id,
      version: note.version,
      title: note.title,
    });
    if (typeof b.id !== 'string') return fromResult(await store.create(vault, input), done('created'));
    const refused = await refuseUserNote(vault, b.id);
    if (refused) return refused;
    const version = b.version as string;
    if (b.supersede === true) return fromResult(await store.supersede(vault, b.id, input, version), done('superseded'));
    // Only the fields the agent sent change; an absent field must not wipe the note's value.
    const { source: _source, ...fields } = input;
    const patch = Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
    return fromResult(await store.update(vault, b.id, patch, version), done('updated'));
  };

  const write = async (op: string, own: MemoryVaultRef, b: MemoryApiBody): Promise<Reply> => {
    const scope = scopeOf(b.scope);
    if (!scope) return badRequest('scope must be "own" or "shared"');
    const vault: MemoryVaultRef = scope === 'shared' ? { kind: 'shared' } : own;
    if (op === 'save') return save(vault, scope, b);
    if (op === 'log') {
      if (scope !== 'own') return badRequest('Only your own memory has a log');
      return fromResult(await store.appendLog(own, b.text as string, b.conversationId), () => ({ logged: true }));
    }
    if (typeof b.id !== 'string') return badRequest('id must be text');
    const refused = await refuseUserNote(vault, b.id);
    if (refused) return refused;
    return fromResult(await store.retire(vault, b.id, b.reason as string), () => ({ retired: true }));
  };

  const read = async (own: MemoryVaultRef, b: MemoryApiBody): Promise<Reply> => {
    const scope = scopeOf(b.scope);
    if (!scope || typeof b.id !== 'string') return badRequest('Send a scope ("own" or "shared") and an id');
    const vault: MemoryVaultRef = scope === 'shared' ? { kind: 'shared' } : own;
    return fromResult(await store.get(vault, b.id), (note) => shown(scope, note));
  };

  return async (op, b) => {
    const isWrite = op === 'save' || op === 'log' || op === 'retire';
    if (!isWrite && op !== 'search' && op !== 'read') return badRequest(`Unknown memory operation: ${op}`);
    // Checked first: the id keys the write counter, so an arbitrary one must never reach it.
    if (!isChatId(b.conversationId)) return badRequest('Bad conversation id');
    // Reserved before the first await so parallel calls can't overshoot; a refused write gives its slot back.
    const used = writes.get(b.conversationId) ?? 0;
    if (isWrite && used >= writesPerChat) {
      return { ok: false, error: 'limit-reached', message: `A chat makes at most ${writesPerChat} memory writes` };
    }
    if (isWrite) writes.set(b.conversationId, used + 1);
    const agent = await resolveAgent(b.conversationId);
    const own: MemoryVaultRef | null = agent.ok ? { kind: 'agent', agentId: agent.agentId } : null;
    const reply = !own
      ? { ok: false as const, error: 'not-found', message: 'message' in agent ? agent.message : '' }
      : op === 'search'
        ? await search(own, b)
        : op === 'read'
          ? await read(own, b)
          : await write(op, own, b);
    if (isWrite && !reply.ok) {
      const left = (writes.get(b.conversationId) ?? 1) - 1;
      if (left > 0) writes.set(b.conversationId, left);
      else writes.delete(b.conversationId);
    }
    return reply;
  };
}

export const memoryRoot = (): string => path.join(homedir(), getEnvAwareName('.aionui'), 'agent-memory');

const listeners = new Set<(vault: MemoryVaultRef) => void>();
let appStore: MemoryStore | undefined;

/** The app's one memory store, shared by the agents' API, the rules and (later) the Memory panel. */
export const getMemoryStore = (): MemoryStore =>
  (appStore ??= createMemoryStore(memoryRoot(), {
    onChange: (vault) => listeners.forEach((listener) => listener(vault)),
  }));

/** Runs `listener` after every change to the app's memory; returns the unsubscribe. */
export const onMemoryChange = (listener: (vault: MemoryVaultRef) => void): (() => void) => {
  listeners.add(listener);
  return () => listeners.delete(listener);
};
