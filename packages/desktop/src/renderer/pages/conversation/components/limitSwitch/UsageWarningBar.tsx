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
import { useMessageList } from '@/renderer/pages/conversation/Messages/hooks';
import {
  dismissUsageWarning,
  failedMessageKey,
  formatResetTime,
  isUsageWarningDismissed,
  latestSwitchableError,
  pickUsageWarning,
  usageWarningKeys,
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

/** The bar's frame: a message, a dismiss button and the switch choices. */
const SwitchBar: React.FC<{
  conversationId: string;
  text: string;
  reason: 'limitHit' | 'nearLimit';
  onDismiss: () => void;
}> = ({ conversationId, text, reason, onDismiss }) => {
  const { t } = useTranslation();
  return (
    // Unfolds when it appears (motion-reveal-rows), so the send box and the messages above it ease up instead of
    // jumping.
    <div className='motion-reveal-rows' role='status'>
      <div className='mb-6px flex flex-col gap-6px rounded-8px px-10px py-8px text-12px bg-warning-light-1 text-t-primary'>
        <div className='flex items-start justify-between gap-8px'>
          <span>{text}</span>
          <Button
            size='mini'
            type='text'
            aria-label={t(`${PREFIX}.dismiss`)}
            icon={<Close theme='outline' size='12' />}
            onClick={onDismiss}
          />
        </div>
        <LimitSwitchActions conversationId={conversationId} reason={reason} />
      </div>
    </div>
  );
};

/**
 * Above the send box, the "switch and continue" choices: when the chat's latest message is an error a switch fixes
 * (a limit hit or a model error; it pops up again for each new one, whatever was dismissed at 90%), else when the
 * agent reports its plan usage is near a limit. Dismissing the near-limit warning hides it until the window resets or
 * the usage crosses the next bucket.
 */
const UsageWarningBar: React.FC<{ conversationId: string }> = ({ conversationId }) => {
  const { t, i18n } = useTranslation();
  const info = useRateLimitInfo(conversationId);
  const [, setDismissals] = useState(0);
  const failedId = latestSwitchableError(useMessageList());
  if (failedId) {
    const key = failedMessageKey(conversationId, failedId);
    if (!isUsageWarningDismissed([key])) {
      return (
        <SwitchBar
          conversationId={conversationId}
          text={t(`${PREFIX}.limitHit`)}
          reason='limitHit'
          onDismiss={() => {
            dismissUsageWarning([key]);
            setDismissals((n) => n + 1);
          }}
        />
      );
    }
  }
  const warning = info ? pickUsageWarning(info) : null;
  if (!warning) return null;
  const keys = usageWarningKeys(conversationId, warning);
  if (isUsageWarningDismissed(keys)) return null;

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
    <SwitchBar
      conversationId={conversationId}
      text={resets ? `${usage} · ${resets}` : usage}
      reason='nearLimit'
      onDismiss={() => {
        dismissUsageWarning(keys);
        setDismissals((n) => n + 1);
      }}
    />
  );
};

export default UsageWarningBar;
