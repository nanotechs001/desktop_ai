/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  dropOpenBurstDuplicates,
  OPEN_BURST_MS,
} from '@/renderer/pages/conversation/Preview/context/openBurstDuplicates';
import type { PreviewTab } from '@/renderer/pages/conversation/Preview/context/PreviewContext';

const T0 = 1_760_000_000_000;
const browserTab = (at: number, url: string, extra: Partial<PreviewTab> = {}): PreviewTab => ({
  id: `browser-${at}-${Math.random().toString(36).slice(2, 9)}`,
  content: url,
  originalContent: url,
  content_type: 'browser',
  title: 'Tab',
  isDirty: false,
  ...extra,
});
const ids = (tabs: PreviewTab[]) => tabs.map((tab) => tab.id);

describe('dropOpenBurstDuplicates', () => {
  it('keeps one tab of copies of the same open written within the burst', () => {
    const tabs = [
      browserTab(T0, 'https://a.test/'),
      browserTab(T0 + 3, 'https://a.test/'),
      browserTab(T0 + 9, 'https://a.test/'),
    ];
    expect(ids(dropOpenBurstDuplicates(tabs, null))).toEqual([tabs[0].id]);
  });

  it('keeps the active copy when it is one of them, even after the page moved on', () => {
    const tabs = [
      browserTab(T0, 'https://a.test/'),
      browserTab(T0 + 5, 'https://a.test/', { content: 'https://a.test/next' }),
    ];
    expect(ids(dropOpenBurstDuplicates(tabs, tabs[1].id))).toEqual([tabs[1].id]);
  });

  it("keeps the user's own tabs: other pages, blank tabs, other profiles and the same page opened later", () => {
    const user = [
      browserTab(T0, 'https://a.test/'),
      browserTab(T0 + 1, 'https://b.test/'),
      browserTab(T0 + 2, 'about:blank', { content: 'https://c.test/' }),
      browserTab(T0 + 3, 'about:blank', { content: 'https://d.test/' }),
      browserTab(T0 + 4, 'https://a.test/', { metadata: { profile: { kind: 'agent', agentId: 'bot' } } }),
      browserTab(T0 + OPEN_BURST_MS + 1, 'https://a.test/'),
      { ...browserTab(T0, 'x'), id: 'markdown-1', content_type: 'markdown', content: '# hi' },
    ];
    expect(dropOpenBurstDuplicates(user, null)).toBe(user);
  });
});
