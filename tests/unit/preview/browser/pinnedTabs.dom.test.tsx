/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A tab the user pinned is never closed or unloaded by the pane on its own: not by the background-tab unload limit,
 * not by the tab cap's reuse, not by a close main asks for (an agent, an extension, the idle sweep). It is left out
 * of those counts, and its pin is stored with the tab.
 */

import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTabProfile } from '@/common/types/browser';

type OpenTabRequest = { url: string; background: boolean; conversationId?: string; profile?: BrowserTabProfile };

const h = vi.hoisted(() => ({
  openTab: [] as ((request: OpenTabRequest) => void)[],
  refuseTab: vi.fn(async () => ({ success: true })),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    fileStream: { contentUpdate: { on: () => () => {} } },
    preview: { open: { on: () => () => {} } },
    browser: {
      openTabRequested: {
        on: (handler: (request: OpenTabRequest) => void) => {
          h.openTab.push(handler);
          return () => h.openTab.splice(h.openTab.indexOf(handler), 1);
        },
      },
      profileRemoved: { on: () => () => {} },
    },
    agentBrowser: { refuseTab: { invoke: h.refuseTab } },
    conversation: { responseStream: { on: () => () => {} }, listChanged: { on: () => () => {} } },
  },
}));
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: async () => null,
}));
vi.mock('@/renderer/pages/conversation/Preview/browser/firstUseNotice', () => ({
  maybeNotifyFirstAgentBrowserUse: vi.fn(),
}));

import { MAX_BROWSER_TABS } from '@/renderer/pages/conversation/Preview/browser/constants';
import { liveBrowserTabs } from '@/renderer/pages/conversation/Preview/context/backgroundTabs';
import {
  PreviewProvider,
  usePreviewContext,
  type PreviewContextValue,
  type PreviewTab,
} from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { previewScopeStorageKey } from '@/renderer/pages/conversation/Preview/context/previewScope';

let ctx: PreviewContextValue;
const Probe: React.FC = () => {
  ctx = usePreviewContext();
  return null;
};
const mount = (): void => {
  render(
    <PreviewProvider>
      <Probe />
    </PreviewProvider>
  );
};
const enter = (scope: string) => act(() => ctx.closePreviewIfScopeChanged(scope));
const open = (url: string): string => {
  act(() => ctx.openBrowserTab(url));
  return String(ctx.activeTabId);
};
const pin = (id: string, pinned = true) => act(() => ctx.updateTab(id, { metadata: { pinned } }));
const browserUrls = () => ctx.tabs.filter((tab) => tab.content_type === 'browser').map((tab) => tab.content);
const flushPersist = () =>
  act(() => {
    vi.advanceTimersByTime(200);
  });

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  h.refuseTab.mockClear();
});

const tab = (id: string, pinned = false): PreviewTab => ({
  id,
  content: `https://${id}.test/`,
  content_type: 'browser',
  title: id,
  ...(pinned ? { metadata: { pinned: true } } : {}),
});

describe('the background-tab unload limit', () => {
  it('never unloads a pinned tab, and does not count it', () => {
    const background = [
      { scope: 's1', tab: tab('a-pinned', true), since: 1 },
      { scope: 's1', tab: tab('b'), since: 2 },
      { scope: 's1', tab: tab('c'), since: 3 },
    ];

    expect(liveBrowserTabs([], background, 2).map(({ id }) => id)).toEqual(['a-pinned', 'b', 'c']);
    expect(liveBrowserTabs([], background, 1).map(({ id }) => id)).toEqual(['a-pinned', 'c']);
  });
});

describe('the tab cap', () => {
  it('leaves pinned tabs out of the count: an agent may still open a tab', async () => {
    mount();
    enter('/s/one');
    const ids = Array.from({ length: MAX_BROWSER_TABS }, (_, i) => open(`https://t${i}.test/`));
    pin(ids[0]);
    pin(ids[1]);

    await act(async () => {
      for (const handler of h.openTab) handler({ url: 'https://agent.test/', background: false });
    });

    expect(h.refuseTab).not.toHaveBeenCalled();
    expect(browserUrls()).toContain('https://agent.test/');
  });

  it('never reuses a pinned tab when the user opens one at the cap', () => {
    mount();
    enter('/s/one');
    pin(open('https://t0.test/')); // the oldest tab
    Array.from({ length: MAX_BROWSER_TABS }, (_, i) => open(`https://t${i + 1}.test/`)); // the cap, unpinned
    expect(browserUrls()).toHaveLength(MAX_BROWSER_TABS + 1);

    open('https://new.test/');

    expect(browserUrls()).toContain('https://t0.test/');
    expect(browserUrls()).not.toContain('https://t1.test/');
    expect(browserUrls()).toContain('https://new.test/');
  });
});

describe('closes nobody asked for', () => {
  it('a close main asks for leaves a pinned tab open; the user closing it closes it', () => {
    mount();
    enter('/s/one');
    const id = open('https://pinned.test/');
    open('https://other.test/');
    pin(id);

    act(() => ctx.closeTab(id, { byUser: false }));
    expect(browserUrls()).toContain('https://pinned.test/');

    act(() => ctx.closeTab(id));
    expect(browserUrls()).not.toContain('https://pinned.test/');
  });
});

describe('the pin is stored with the tab', () => {
  it('survives a chat switch and a restart, and an unpin is stored too', () => {
    mount();
    enter('/s/one');
    const id = open('https://pinned.test/');
    pin(id);
    flushPersist();
    const stored = () =>
      (JSON.parse(localStorage.getItem(previewScopeStorageKey('/s/one')) ?? '{"tabs":[]}') as { tabs: PreviewTab[] })
        .tabs;
    expect(stored().find((t) => t.id === id)?.metadata?.pinned).toBe(true);

    enter('/s/two');
    enter('/s/one');
    expect(ctx.tabs.find((t) => t.id === id)?.metadata?.pinned).toBe(true);

    cleanup();
    mount();
    enter('/s/one');
    expect(ctx.tabs.find((t) => t.id === id)?.metadata?.pinned).toBe(true);

    pin(id, false);
    flushPersist();
    expect(stored().find((t) => t.id === id)?.metadata?.pinned).toBe(false);
  });
});

describe('pinned tabs sit at the start of the strip, like Chrome', () => {
  it('pinning moves a tab to the end of the pinned group; unpinning moves it just after it', () => {
    mount();
    enter('/s/order');
    open('https://a.test/');
    const b = open('https://b.test/');
    const c = open('https://c.test/');

    pin(c);
    expect(browserUrls()).toEqual(['https://c.test/', 'https://a.test/', 'https://b.test/']);
    pin(b);
    expect(browserUrls()).toEqual(['https://c.test/', 'https://b.test/', 'https://a.test/']);
    pin(c, false);
    expect(browserUrls()).toEqual(['https://b.test/', 'https://c.test/', 'https://a.test/']);
  });
});
