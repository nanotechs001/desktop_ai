/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The pure half of the near-limit warning: when it shows, what it says, and how a dismissal is keyed.
 */

import { describe, expect, it } from 'vitest';
import type { IConversationRateLimitUpdatedEvent } from '@/common/adapter/ipcBridge';
import { pickUsageWarning, usageWarningKey } from '@/renderer/pages/conversation/components/limitSwitch/usageWarning';

const reading = (over: Partial<IConversationRateLimitUpdatedEvent> = {}): IConversationRateLimitUpdatedEvent => ({
  user_id: 'u',
  conversation_id: 'c1',
  status: 'allowed',
  rate_limit_type: 'five_hour',
  resets_at: 1_785_754_200,
  utilization: null,
  windows: [],
  surpassed_threshold: null,
  ...over,
});

describe('pickUsageWarning', () => {
  it('shows at 90% and above, treating utilization as a fraction', () => {
    expect(pickUsageWarning(reading({ utilization: 0.9 }))).toEqual({
      window: 'five_hour',
      pct: 90,
      resetsAt: 1_785_754_200,
      bucket: 90,
    });
    expect(pickUsageWarning(reading({ utilization: 0.957 }))?.pct).toBe(95);
    expect(pickUsageWarning(reading({ utilization: 1.2 }))?.pct).toBe(120);
  });

  it('stays hidden below 90% with an allowed status and no threshold', () => {
    expect(pickUsageWarning(reading({ utilization: 0.89 }))).toBeNull();
    expect(pickUsageWarning(reading())).toBeNull();
  });

  it('shows on allowed_warning or a surpassed threshold even without utilization', () => {
    expect(pickUsageWarning(reading({ status: 'allowed_warning' }))).toEqual({
      window: 'five_hour',
      pct: null,
      resetsAt: 1_785_754_200,
      bucket: 0,
    });
    expect(pickUsageWarning(reading({ surpassed_threshold: 0.75 }))?.pct).toBeNull();
  });

  it('stays hidden when the limit is already hit, so the limit-error card takes over', () => {
    expect(pickUsageWarning(reading({ status: 'rejected', utilization: 1 }))).toBeNull();
  });

  it('reports the most-used window', () => {
    const warning = pickUsageWarning(
      reading({
        rate_limit_type: 'five_hour',
        utilization: 0.4,
        windows: [
          { kind: 'five_hour', utilization: 0.4, resets_at: 100 },
          { kind: 'seven_day', utilization: 0.93, resets_at: 200 },
        ],
      })
    );
    expect(warning).toEqual({ window: 'seven_day', pct: 93, resetsAt: 200, bucket: 90 });
  });
});

describe('usageWarningKey', () => {
  const at = (utilization: number, resets_at = 100) =>
    usageWarningKey('c1', pickUsageWarning(reading({ utilization, resets_at }))!);

  it('is the same within a bucket and changes on the next bucket or a new reset', () => {
    expect(at(0.91)).toBe(at(0.94));
    expect(at(0.95)).not.toBe(at(0.94));
    expect(at(1)).not.toBe(at(0.99));
    expect(at(0.91, 200)).not.toBe(at(0.91, 100));
  });

  it('is scoped to the conversation', () => {
    const warning = pickUsageWarning(reading({ utilization: 0.91 }))!;
    expect(usageWarningKey('c1', warning)).not.toBe(usageWarningKey('c2', warning));
  });
});
