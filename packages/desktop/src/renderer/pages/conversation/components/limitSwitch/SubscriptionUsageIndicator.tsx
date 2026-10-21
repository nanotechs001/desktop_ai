/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Popover, Progress } from '@arco-design/web-react';
import type { TFunction } from 'i18next';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RateLimitWindowKind } from '@/common/adapter/ipcBridge';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { formatResetTime } from './usageWarning';
import {
  currentWindows,
  hasSubscriptionWindows,
  MAX_READING_AGE_MS,
  useSubscriptionUsage,
  type UsageWindow,
} from './subscriptionUsage';

const PREFIX = 'conversation.subscriptionUsage';
const WARNING_PCT = 75;
const DANGER_PCT = 90;
const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;
const SECONDS_TO_MS = 1000;
/** setTimeout's longest delay; a later reset is waited for in steps. */
const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Popover rows in order, with the i18n key (under `windows`) of each name. */
const ROWS: readonly [RateLimitWindowKind, string][] = [
  ['five_hour', 'fiveHour'],
  ['seven_day', 'sevenDay'],
  ['seven_day_opus', 'sevenDayOpus'],
  ['seven_day_sonnet', 'sevenDaySonnet'],
];

/** Product names, not translated. */
const ENGINE_NAMES: Record<string, string> = { claude: 'Claude', codex: 'Codex' };

type Level = 'normal' | 'warning' | 'danger';
const levelOf = (pct: number): Level => (pct >= DANGER_PCT ? 'danger' : pct >= WARNING_PCT ? 'warning' : 'normal');
const PROGRESS_STATUS: Record<Level, 'normal' | 'warning' | 'error'> = {
  normal: 'normal',
  warning: 'warning',
  danger: 'error',
};

const toPct = (w: UsageWindow | undefined): number => Math.round((w?.utilization ?? 0) * 100);

/** A span as "45m", "2h 14m" or "3d". */
function formatDuration(ms: number, t: TFunction): string {
  if (ms >= DAY_MS) return t(`${PREFIX}.duration.days`, { d: Math.floor(ms / DAY_MS) });
  const m = Math.floor((ms % HOUR_MS) / MINUTE_MS);
  if (ms < HOUR_MS) return t(`${PREFIX}.duration.minutes`, { m });
  return t(`${PREFIX}.duration.hoursMinutes`, { h: Math.floor(ms / HOUR_MS), m });
}

/** "resets in 2h 14m" within a day, the reset date beyond it, "reset" once it has. */
function resetText(w: UsageWindow, now: number, t: TFunction, locale: string): string {
  if (w.resets_at === null) return t(`${PREFIX}.reset`);
  const left = w.resets_at * SECONDS_TO_MS - now;
  return left < DAY_MS
    ? t(`${PREFIX}.resetsIn`, { duration: formatDuration(left, t) })
    : t(`${PREFIX}.resetsAt`, { time: formatResetTime(w.resets_at, locale, new Date(now)) });
}

/**
 * The plan usage of a subscription login (5-hour and weekly windows) beside the context ring in the send box. Shows
 * only once the engine has reported such a window: API-key and custom-endpoint sessions never do.
 */
const SubscriptionUsageIndicator: React.FC<{ backend: string; conversationId: string }> = ({
  backend,
  conversationId,
}) => {
  const { t, i18n } = useTranslation();
  const isMobile = Boolean(useLayoutContext()?.isMobile);
  const usage = useSubscriptionUsage(backend, conversationId);
  // Re-render at the next reset (or when the reading grows too old), so the ring never shows a window past it.
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!usage) return;
    const now = Date.now();
    const next = Math.min(
      ...[
        ...Object.values(usage.windows).map((w) => (w.resets_at ?? 0) * SECONDS_TO_MS),
        usage.updated_at + MAX_READING_AGE_MS,
      ].filter((at) => at > now)
    );
    if (!Number.isFinite(next)) return;
    const timer = setTimeout(() => setTick((n) => n + 1), Math.min(next - now, MAX_TIMEOUT_MS));
    return () => clearTimeout(timer);
  }, [usage, tick]);

  const now = Date.now();
  if (!usage || !hasSubscriptionWindows(usage, now)) return null;

  const windows = currentWindows(usage, now);
  const pct = Math.max(toPct(windows.five_hour), toPct(windows.seven_day));
  const level = levelOf(pct);
  const engine = ENGINE_NAMES[backend] ?? backend;
  const updatedAgo = now - usage.updated_at;

  const content = (
    <div className='flex min-w-220px flex-col gap-10px p-4px'>
      {ROWS.map(([kind, nameKey]) => {
        const w = windows[kind];
        if (!w) return null;
        const rowPct = toPct(w);
        return (
          <div key={kind} className='flex flex-col gap-2px'>
            <span className='text-12px text-t-primary'>{t(`${PREFIX}.windows.${nameKey}`)}</span>
            <Progress
              percent={Math.min(rowPct, 100)}
              status={PROGRESS_STATUS[levelOf(rowPct)]}
              showText={false}
              size='small'
            />
            <span className='text-12px text-t-secondary'>
              {`${t(`${PREFIX}.used`, { pct: rowPct })} · ${resetText(w, now, t, i18n.language)}`}
            </span>
          </div>
        );
      })}
      <span className='text-12px text-t-tertiary'>
        {updatedAgo < MINUTE_MS
          ? t(`${PREFIX}.updatedJustNow`)
          : t(`${PREFIX}.updatedAgo`, { duration: formatDuration(updatedAgo, t) })}
      </span>
    </div>
  );

  return (
    <Popover
      title={t(`${PREFIX}.title`, { engine })}
      content={content}
      position='top'
      trigger={isMobile ? 'click' : 'hover'}
    >
      <div
        role='button'
        tabIndex={0}
        aria-label={t(`${PREFIX}.ariaLabel`, { engine, pct })}
        data-level={level}
        className='flex h-32px w-32px cursor-pointer items-center justify-center'
      >
        <Progress
          type='circle'
          size='mini'
          width={20}
          strokeWidth={2}
          percent={Math.min(pct, 100)}
          status={PROGRESS_STATUS[level]}
          showText={false}
        />
      </div>
    </Popover>
  );
};

export default SubscriptionUsageIndicator;
