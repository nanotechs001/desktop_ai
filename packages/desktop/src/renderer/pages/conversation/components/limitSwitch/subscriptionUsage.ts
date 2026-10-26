/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useSyncExternalStore } from 'react';
import { ipcBridge } from '@/common';
import type { IConversationRateLimitUpdatedEvent, RateLimitWindowKind } from '@/common/adapter/ipcBridge';
import type { TChatConversation } from '@/common/config/storage';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import { resolvePresetAssistantInfo } from '@/renderer/hooks/agent/usePresetAssistantInfo';
import { getWidgetConversationId } from '@/renderer/pages/agentWidget/chatLocation';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { resolveConversationBackend } from '@/renderer/pages/conversation/utils/conversationAssistantIdentity';

/** localStorage key of the persisted store. */
export const SUBSCRIPTION_USAGE_STORAGE_KEY = 'subscription-usage:v1';

/** Fraction used (0..1, may exceed 1); `resets_at` in epoch seconds. */
export type UsageWindow = { utilization: number; resets_at: number | null };
export type BackendUsage = { windows: Partial<Record<RateLimitWindowKind, UsageWindow>>; updated_at: number };
/**
 * Keyed by the chat's engine row id (`extra.agent_id`), else its backend (`claude`, `codex`, …): plan usage is per
 * login, not per chat, and each account of an engine is its own row.
 */
export type SubscriptionUsageState = Record<string, BackendUsage>;

const SECONDS_TO_MS = 1000;
/** A reading older than this is no longer shown: the login may have changed, and a window without a reset ends here. */
export const MAX_READING_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const WINDOW_KINDS: readonly RateLimitWindowKind[] = [
  'five_hour',
  'seven_day',
  'seven_day_opus',
  'seven_day_sonnet',
  'seven_day_overage_included',
  'overage',
];

/**
 * `state` with the reading's windows merged into `backend`'s. Only subscription readings carry windows (API-key,
 * Bedrock and Vertex sessions never do), so a reading without any changes nothing. Its headline window joins them
 * when it names one they lack (claude reports weekly Opus/Sonnet only as the headline). `now` is the reading's
 * arrival: one that arrived before the stored reading changes nothing.
 */
export function mergeReading(
  state: SubscriptionUsageState,
  backend: string,
  event: IConversationRateLimitUpdatedEvent,
  now: number
): SubscriptionUsageState {
  const incoming: Partial<Record<RateLimitWindowKind, UsageWindow>> = {};
  for (const w of event.windows) {
    if (w.utilization !== null) incoming[w.kind] = { utilization: w.utilization, resets_at: w.resets_at };
  }
  if (Object.keys(incoming).length === 0 || (state[backend]?.updated_at ?? -Infinity) > now) return state;
  const headline = event.rate_limit_type;
  if (headline && event.utilization !== null && !incoming[headline]) {
    incoming[headline] = { utilization: event.utilization, resets_at: event.resets_at };
  }
  return {
    ...state,
    [backend]: { windows: { ...state[backend]?.windows, ...incoming }, updated_at: now },
  };
}

/**
 * The stored usage of an engine row: its own reading, else (for an engine's main login, never an account) one filed by
 * backend from a chat without a row.
 */
export const usageOfEngine = (
  state: SubscriptionUsageState,
  engine: { id: string; backend?: string; agent_source_info?: { account_of?: string } }
): BackendUsage | undefined =>
  state[engine.id] ?? (engine.agent_source_info?.account_of ? undefined : state[engine.backend ?? engine.id]);

/** The windows as they stand at `now`: one whose reset has passed is back at 0%. */
export function currentWindows(
  usage: BackendUsage | null | undefined,
  now: number
): Partial<Record<RateLimitWindowKind, UsageWindow>> {
  const result: Partial<Record<RateLimitWindowKind, UsageWindow>> = {};
  for (const [kind, w] of Object.entries(usage?.windows ?? {}) as [RateLimitWindowKind, UsageWindow][]) {
    const reset = w.resets_at !== null && w.resets_at * SECONDS_TO_MS <= now;
    result[kind] = reset ? { utilization: 0, resets_at: null } : w;
  }
  return result;
}

/** The indicator's gate: a recent reading with a 5-hour or weekly window that has not reset yet. */
export function hasSubscriptionWindows(usage: BackendUsage | null | undefined, now: number): boolean {
  if (!usage || now - usage.updated_at > MAX_READING_AGE_MS) return false;
  return [usage.windows.five_hour, usage.windows.seven_day].some(
    (w) => w && (w.resets_at === null || w.resets_at * SECONDS_TO_MS > now)
  );
}

const hasWindows = (event: IConversationRateLimitUpdatedEvent): boolean =>
  event.windows.some((w) => w.utilization !== null);

const isFiniteNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The stored value, validated: it is user-writable, so anything malformed is dropped rather than trusted. */
function parseStored(raw: string | null): SubscriptionUsageState {
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return {};
    const state: SubscriptionUsageState = {};
    for (const [backend, value] of Object.entries(parsed as Record<string, unknown>)) {
      const usage = value as { windows?: unknown; updated_at?: unknown } | null;
      if (
        backend === '__proto__' ||
        !usage ||
        !isFiniteNumber(usage.updated_at) ||
        !usage.windows ||
        typeof usage.windows !== 'object'
      )
        continue;
      const windows: Partial<Record<RateLimitWindowKind, UsageWindow>> = {};
      for (const kind of WINDOW_KINDS) {
        const w = (usage.windows as Record<string, { utilization?: unknown; resets_at?: unknown } | undefined>)[kind];
        const resetsAt = w?.resets_at === null ? null : isFiniteNumber(w?.resets_at) ? w.resets_at : undefined;
        if (w && isFiniteNumber(w.utilization) && resetsAt !== undefined) {
          windows[kind] = { utilization: w.utilization, resets_at: resetsAt };
        }
      }
      if (Object.keys(windows).length > 0) state[backend] = { windows, updated_at: usage.updated_at };
    }
    return state;
  } catch {
    return {};
  }
}

const readStorage = (): SubscriptionUsageState => {
  try {
    return parseStored(localStorage.getItem(SUBSCRIPTION_USAGE_STORAGE_KEY));
  } catch {
    return {};
  }
};

let state: SubscriptionUsageState = readStorage();
const listeners = new Set<() => void>();
/** Engine of each chat that has a send box mounted, so its readings need no lookup. */
const backendByConversation = new Map<string, string>();
/** Engine lookups of chats not on screen, one per chat. */
const backendLookups = new Map<string, Promise<string | undefined>>();
/** Chats whose latest reading had no windows: an API-key session, whatever the account store holds. */
const windowlessConversations = new Set<string>();
let feedStarted = false;
let lastArrival = 0;

const notify = (): void => listeners.forEach((listener) => listener());

function apply(backend: string, event: IConversationRateLimitUpdatedEvent, arrivedAt: number): void {
  const next = mergeReading(state, backend, event, arrivedAt);
  if (next === state) return;
  state = next;
  // Every window gets each reading; only the main one stores it, and robot windows follow its `storage` events.
  if (getWidgetConversationId() === null) {
    try {
      localStorage.setItem(SUBSCRIPTION_USAGE_STORAGE_KEY, JSON.stringify(state));
    } catch {
      // shortcut: storage unavailable, so the usage lasts only until reload
    }
  }
  notify();
}

/** The usage key of a chat: its engine row, so two logins of one engine stay apart. */
export const usageKeyOf = (conversation: TChatConversation | null | undefined): string | undefined =>
  (conversation?.extra as { agent_id?: string } | undefined)?.agent_id || undefined;

/**
 * The usage key of a chat that is not on screen: its engine row, else its engine, preset-aware like the on-screen
 * chat's (`ChatConversation`).
 */
async function lookUpBackend(conversationId: string): Promise<string | undefined> {
  const [conversation, assistantsList] = await Promise.all([
    getConversationOrNull(conversationId),
    ipcBridge.assistants.list.invoke().catch(() => [] as Assistant[]),
  ]);
  if (!conversation) return undefined;
  const rowKey = usageKeyOf(conversation);
  if (rowKey) return rowKey;
  // shortcut: no agent logos or extension adapters (they pick a logo, not an engine), upgrade if a legacy row resolves wrong.
  const preset = resolvePresetAssistantInfo(conversation, {
    locale: '',
    logos: {},
    assistantsList,
    isLoadingAssistants: false,
    extensionAcpAdapters: undefined,
    isLoadingExtAdapters: false,
  });
  return resolveConversationBackend(conversation, preset.info?.backend);
}

/** {@link lookUpBackend}, once per chat; a failed or empty lookup is tried again next time. */
function cachedBackend(conversationId: string): Promise<string | undefined> {
  let lookup = backendLookups.get(conversationId);
  if (!lookup) {
    lookup = lookUpBackend(conversationId).then(
      (backend) => {
        if (!backend) backendLookups.delete(conversationId);
        return backend;
      },
      (error: unknown) => {
        backendLookups.delete(conversationId);
        throw error;
      }
    );
    backendLookups.set(conversationId, lookup);
  }
  return lookup;
}

/**
 * Feeds every reading, from any chat, into the store, and follows what other windows (each robot keeps its own copy)
 * store. Idempotent; the app starts it at launch (`Layout`), a robot window when its usage indicator mounts.
 */
export function startSubscriptionUsageFeed(): void {
  if (feedStarted) return;
  feedStarted = true;
  // What other windows stored since this module loaded (every write is persisted, so nothing is lost).
  state = readStorage();
  window.addEventListener('storage', (event) => {
    if (event.key !== SUBSCRIPTION_USAGE_STORAGE_KEY) return;
    state = parseStored(event.newValue);
    notify();
  });
  ipcBridge.conversation.rateLimitUpdated.on((event) => {
    // Strictly increasing, so readings that arrive in the same millisecond keep their order.
    const arrivedAt = (lastArrival = Math.max(Date.now(), lastArrival + 1));
    const windowless = !hasWindows(event);
    if (windowless !== windowlessConversations.has(event.conversation_id)) {
      if (windowless) windowlessConversations.add(event.conversation_id);
      else windowlessConversations.delete(event.conversation_id);
      notify();
    }
    if (windowless) return;
    const known = backendByConversation.get(event.conversation_id);
    if (known) return apply(known, event, arrivedAt);
    cachedBackend(event.conversation_id)
      .then((backend) => {
        if (backend) apply(backend, event, arrivedAt);
      })
      .catch((error: unknown) => {
        console.warn('[subscriptionUsage] could not resolve the engine of a usage reading', error);
      });
  });
}

const subscribe = (listener: () => void): (() => void) => {
  startSubscriptionUsageFeed();
  listeners.add(listener);
  return () => listeners.delete(listener);
};

/**
 * The account's latest plan usage for an engine, shared by every chat on it and kept across reloads. Null when no
 * subscription reading has arrived for it, or when this chat's own latest reading had no windows. Apply
 * {@link currentWindows} before showing it.
 */
export function useSubscriptionUsage(backend: string, conversationId: string): BackendUsage | null {
  useEffect(() => {
    backendByConversation.set(conversationId, backend);
    return () => {
      if (backendByConversation.get(conversationId) === backend) backendByConversation.delete(conversationId);
    };
  }, [backend, conversationId]);
  return useSyncExternalStore(subscribe, () =>
    windowlessConversations.has(conversationId) ? null : (state[backend] ?? null)
  );
}

/** Every engine's stored plan usage, kept current across windows like {@link useSubscriptionUsage}. */
export function useAllSubscriptionUsage(): SubscriptionUsageState {
  return useSyncExternalStore(subscribe, () => state);
}
