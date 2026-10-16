/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  closeTab: vi.fn(),
  viewerProps: [] as Array<{ tabId: string; active?: boolean; onRequestClose?: (id: string) => void }>,
}));

vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => ({ closeTab: mocks.closeTab }),
}));
vi.mock('@/renderer/pages/conversation/Preview/browser/BrowserViewer', () => ({
  default: (props: { tabId: string; active?: boolean; onRequestClose?: (id: string) => void }) => {
    mocks.viewerProps.push(props);
    return null;
  },
}));
vi.mock('@/renderer/pages/conversation/Preview/browser/BrowserChrome/PermissionPrompt', () => ({
  default: () => null,
}));

import BrowserTabLayer from '@/renderer/pages/conversation/Preview/browser/BrowserTabLayer';
import type { PreviewTab } from '@/renderer/pages/conversation/Preview/context/PreviewContext';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.viewerProps.length = 0;
});

describe('BrowserTabLayer', () => {
  it('passes the preview context closeTab to each viewer as onRequestClose', () => {
    const tabs = [{ id: 'tab-1', content: 'https://a.test' }] as PreviewTab[];
    render(<BrowserTabLayer browserTabs={tabs} activeTabId='tab-1' updateTab={vi.fn()} />);

    mocks.viewerProps[0].onRequestClose?.('tab-1');

    expect(mocks.closeTab).toHaveBeenCalledWith('tab-1');
  });

  it('tells only the active tab that it is active', () => {
    const tabs = [
      { id: 'tab-1', content: 'https://a.test' },
      { id: 'tab-2', content: 'https://b.test' },
    ] as PreviewTab[];
    render(<BrowserTabLayer browserTabs={tabs} activeTabId='tab-2' updateTab={vi.fn()} />);

    expect(mocks.viewerProps.map(({ tabId, active }) => [tabId, active])).toEqual([
      ['tab-1', false],
      ['tab-2', true],
    ]);
  });
});
