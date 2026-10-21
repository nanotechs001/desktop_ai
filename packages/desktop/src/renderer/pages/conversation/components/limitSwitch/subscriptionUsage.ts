/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useSyncExternalStore } from 'react';
import { ipcBridge } from '@/common';
import type { IConversationRateLimitUpdatedEvent, RateLimitWindowKind } from '@/common/adapter/ipcBridge';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import { resolvePresetAssistantInfo } from '@/renderer/hooks/agent/usePresetAssistantInfo';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { resolveConversationBackend } from '@/renderer/pages/conversation/utils/conversationAssistantIdentity';

/** localStorage key of the persisted store. */
export const SUBSCRIPTION_USAGE_STORAGE_KEY = 'subscription-usage:v1';

/** Fraction used (0..1, may exceed 1); `resets_at` in epoch seconds. */
export type UsageWindow = { utilization: number; resets_at: number | null };
export type BackendUsage = { windows: Partial<Record<RateLimitWindowKind, UsageWindow>>; updated_at: number };
/** Keyed by engine id (`claude`, `codex`, …): plan usage is per account, not per chat. */
export type SubscriptionUsageState = Record<string, BackendUsage>;

const SECONDS_TO_MS = 1000;
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
 * when it names one they lack (claude reports weekly Opus/Sonnet only as the headline).
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
  if (Object.keys(incoming).length === 0) return state;
  const headline = event.rate_limit_type;
  if (headline && event.utilization !== null && !incoming[headline]) {
    incoming[headline] = { utilization: event.utilization, resets_at: event.resets_at };
  }
  return {
    ...state,
    [backend]: { windows: { ...state[backend]?.windows, ...incoming }, updated_at: now },
  };
}

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

/** The indicator's gate: a 5-hour or weekly window is known for this engine. */
export const hasSubscriptionWindows = (usage: BackendUsage | null | undefined): boolean =>
  Boolean(usage?.windows.five_hour || usage?.windows.seven_day);

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
let feedStarted = false;

function apply(backend: string, event: IConversationRateLimitUpdatedEvent): void {
  const next = mergeReading(state, backend, event, Date.now());
  if (next === state) return;
  state = next;
  try {
    localStorage.setItem(SUBSCRIPTION_USAGE_STORAGE_KEY, JSON.stringify(state));
  } catch {
    // shortcut: storage unavailable, so the usage lasts only until reload
  }
  listeners.forEach((listener) => listener());
}

/** The engine of a chat that is not on screen, preset-aware like the on-screen chat's (`ChatConversation`). */
async function lookUpBackend(conversationId: string): Promise<string | undefined> {
  const [conversation, assistantsList] = await Promise.all([
    getConversationOrNull(conversationId),
    ipcBridge.assistants.list.invoke().catch(() => [] as Assistant[]),
  ]);
  if (!conversation) return undefined;
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

/** Feeds every reading, from any chat, into the store. Idempotent; the app starts it at launch (`Layout`). */
export function startSubscriptionUsageFeed(): void {
  if (feedStarted) return;
  feedStarted = true;
  ipcBridge.conversation.rateLimitUpdated.on((event) => {
    const known = backendByConversation.get(event.conversation_id);
    if (known) return apply(known, event);
    if (!event.windows.some((w) => w.utilization !== null)) return;
    lookUpBackend(event.conversation_id)
      .then((backend) => {
        if (backend) apply(backend, event);
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
 * subscription reading has arrived for it. Apply {@link currentWindows} before showing it.
 */
export function useSubscriptionUsage(backend: string, conversationId: string): BackendUsage | null {
  useEffect(() => {
    backendByConversation.set(conversationId, backend);
    return () => {
      if (backendByConversation.get(conversationId) === backend) backendByConversation.delete(conversationId);
    };
  }, [backend, conversationId]);
  return useSyncExternalStore(subscribe, () => state[backend] ?? null);
}
