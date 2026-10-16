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
  viewerProps: [] as Array<{ tabId: string; onRequestClose?: (id: string) => void }>,
}));

vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => ({ closeTab: mocks.closeTab }),
}));
vi.mock('@/renderer/pages/conversation/Preview/browser/BrowserViewer', () => ({
  default: (props: { tabId: string; onRequestClose?: (id: string) => void }) => {
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
});
