/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '@arco-design/web-react';
import { Close } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { RateLimitWindowKind } from '@/common/adapter/ipcBridge';
import LimitSwitchActions from './LimitSwitchActions';
import {
  dismissUsageWarning,
  formatResetTime,
  isUsageWarningDismissed,
  pickUsageWarning,
  usageWarningKey,
} from './usageWarning';
import { useRateLimitInfo } from './useRateLimitInfo';

const PREFIX = 'conversation.usageWarning';

/** i18n key (under `windows`) of each window's display name. */
const WINDOW_KEYS: Record<RateLimitWindowKind, string> = {
  five_hour: 'fiveHour',
  seven_day: 'sevenDay',
  seven_day_opus: 'sevenDayOpus',
  seven_day_sonnet: 'sevenDaySonnet',
  seven_day_overage_included: 'sevenDayOverageIncluded',
  overage: 'overage',
};

/**
 * Warns above the send box when the agent reports its plan usage is near a limit, and offers the same
 * "switch and continue" choices as the limit-error card. Dismissing hides it until the window resets or the usage
 * crosses the next bucket.
 */
const UsageWarningBar: React.FC<{ conversationId: string }> = ({ conversationId }) => {
  const { t, i18n } = useTranslation();
  const info = useRateLimitInfo(conversationId);
  const [, setDismissals] = useState(0);
  const warning = info ? pickUsageWarning(info) : null;
  if (!warning) return null;
  const key = usageWarningKey(conversationId, warning);
  if (isUsageWarningDismissed(key)) return null;

  const windowName = t(`${PREFIX}.windows.${warning.window ? WINDOW_KEYS[warning.window] : 'unknown'}`);
  const usage =
    warning.pct === null
      ? t(`${PREFIX}.near`, { window: windowName })
      : t(`${PREFIX}.used`, { pct: warning.pct, window: windowName });
  const resets =
    warning.resetsAt === null
      ? null
      : t(`${PREFIX}.resets`, { time: formatResetTime(warning.resetsAt, i18n.language) });

  return (
    <div
      className='mb-6px flex flex-col gap-6px rounded-8px px-10px py-8px text-12px bg-warning-light-1 text-t-primary'
      role='status'
    >
      <div className='flex items-start justify-between gap-8px'>
        <span>{resets ? `${usage} · ${resets}` : usage}</span>
        <Button
          size='mini'
          type='text'
          aria-label={t(`${PREFIX}.dismiss`)}
          icon={<Close theme='outline' size='12' />}
          onClick={() => {
            dismissUsageWarning(key);
            setDismissals((n) => n + 1);
          }}
        />
      </div>
      <LimitSwitchActions conversationId={conversationId} reason='nearLimit' />
    </div>
  );
};

export default UsageWarningBar;
