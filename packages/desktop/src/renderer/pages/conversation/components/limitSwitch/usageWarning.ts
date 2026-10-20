/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IConversationRateLimitUpdatedEvent, RateLimitWindowKind } from '@/common/adapter/ipcBridge';

/** Usage fraction from which the near-limit warning shows. */
export const USAGE_WARNING_THRESHOLD = 0.9;

/** Dismissal buckets (fractions); crossing into the next one brings a dismissed warning back. */
const DISMISS_BUCKETS = [1, 0.95, USAGE_WARNING_THRESHOLD] as const;

export type UsageWarning = {
  /** The window the warning is about; null when the agent named none. */
  window: RateLimitWindowKind | null;
  /** Whole percent used; null when the agent reported no utilization. */
  pct: number | null;
  /** Epoch seconds. */
  resetsAt: number | null;
  /** 100, 95 or 90 by usage; 0 when only the status or a threshold triggered the warning. */
  bucket: number;
};

type Reading = { window: RateLimitWindowKind | null; utilization: number | null; resetsAt: number | null };

const toBucket = (utilization: number | null): number => {
  const bucket = DISMISS_BUCKETS.find((b) => utilization !== null && utilization >= b);
  return bucket === undefined ? 0 : Math.round(bucket * 100);
};

/**
 * The near-limit warning for a usage reading, or null when there is none to show: it shows when any window is at
 * 90% or more, on `allowed_warning`, or when a threshold was surpassed, and never once the limit is hit (`rejected`),
 * where the limit-error card takes over. It reports the most-used window, else the reading's own window.
 */
export function pickUsageWarning(info: IConversationRateLimitUpdatedEvent): UsageWarning | null {
  if (info.status === 'rejected') return null;
  const headline: Reading = { window: info.rate_limit_type, utilization: info.utilization, resetsAt: info.resets_at };
  const readings: Reading[] = [
    ...info.windows.map((w) => ({ window: w.kind, utilization: w.utilization, resetsAt: w.resets_at })),
    headline,
  ];
  const top = readings.reduce<Reading | null>(
    (best, r) => (r.utilization !== null && (best?.utilization ?? -1) < r.utilization ? r : best),
    null
  );
  const nearLimit = top !== null && (top.utilization ?? 0) >= USAGE_WARNING_THRESHOLD;
  if (!nearLimit && info.status !== 'allowed_warning' && info.surpassed_threshold === null) return null;
  const shown = nearLimit ? top : headline;
  return {
    window: shown.window,
    pct: shown.utilization === null ? null : Math.floor(shown.utilization * 100),
    resetsAt: shown.resetsAt,
    bucket: toBucket(shown.utilization),
  };
}

/** Dismissal identity: the conversation, the window, its reset and the usage bucket. */
export const usageWarningKey = (conversationId: string, warning: UsageWarning): string =>
  [conversationId, warning.window ?? 'unknown', warning.resetsAt ?? 'none', warning.bucket].join('|');

const STORAGE_PREFIX = 'usageWarningDismissed:';
const dismissedInMemory = new Set<string>();

export function isUsageWarningDismissed(key: string): boolean {
  if (dismissedInMemory.has(key)) return true;
  try {
    return sessionStorage.getItem(STORAGE_PREFIX + key) !== null;
  } catch {
    return false;
  }
}

export function dismissUsageWarning(key: string): void {
  dismissedInMemory.add(key);
  try {
    sessionStorage.setItem(STORAGE_PREFIX + key, '1');
  } catch {
    // shortcut: storage unavailable, so the dismissal lasts only until reload
  }
}

const SECONDS_TO_MS = 1000;

/** The reset moment in the user's locale: the time alone when it is today, else with the date. */
export function formatResetTime(resetsAt: number, locale: string, now: Date = new Date()): string {
  const at = new Date(resetsAt * SECONDS_TO_MS);
  const sameDay = at.toDateString() === now.toDateString();
  const options: Intl.DateTimeFormatOptions = sameDay
    ? { hour: 'numeric', minute: '2-digit' }
    : { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' };
  try {
    return new Intl.DateTimeFormat(locale, options).format(at);
  } catch {
    return new Intl.DateTimeFormat(undefined, options).format(at);
  }
}
