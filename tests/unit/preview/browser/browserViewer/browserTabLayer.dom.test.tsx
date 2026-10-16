/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  closeTab: vi.fn(),
  context: { liveBrowserTabs: [] as unknown[], activeTabId: null as string | null },
  viewerProps: [] as Array<{ tabId: string; active?: boolean; onRequestClose?: (id: string) => void }>,
}));

vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => ({ ...mocks.context, closeTab: mocks.closeTab, updateTab: vi.fn() }),
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
vi.mock('@/renderer/pages/conversation/Preview/browser/BrowserChrome/ConfirmPrompt', () => ({ default: () => null }));

import BrowserTabLayer, { BrowserSlot } from '@/renderer/pages/conversation/Preview/browser/BrowserTabLayer';
import type { PreviewTab } from '@/renderer/pages/conversation/Preview/context/PreviewContext';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.viewerProps.length = 0;
});

const renderLayer = (tabs: PreviewTab[], activeTabId: string) => {
  mocks.context = { liveBrowserTabs: tabs, activeTabId };
  // jsdom lays nothing out; give the panel's slot a box so the active tab can be shown.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    top: 0,
    width: 800,
    height: 600,
  } as DOMRect);
  render(
    <>
      <BrowserSlot />
      <BrowserTabLayer />
    </>
  );
};

describe('BrowserTabLayer', () => {
  it('passes the preview context closeTab to each viewer as onRequestClose', () => {
    renderLayer([{ id: 'tab-1', content: 'https://a.test' }] as PreviewTab[], 'tab-1');

    mocks.viewerProps[0].onRequestClose?.('tab-1');

    expect(mocks.closeTab).toHaveBeenCalledWith('tab-1');
  });

  it('tells only the active tab that it is active, once the panel slot is on screen', async () => {
    const tabs = [
      { id: 'tab-1', content: 'https://a.test' },
      { id: 'tab-2', content: 'https://b.test' },
    ] as PreviewTab[];
    renderLayer(tabs, 'tab-2');

    await waitFor(() =>
      expect(mocks.viewerProps.slice(-2).map(({ tabId, active }) => [tabId, active])).toEqual([
        ['tab-1', false],
        ['tab-2', true],
      ])
    );
  });
});
