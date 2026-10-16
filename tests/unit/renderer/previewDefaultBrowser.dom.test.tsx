/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => ({
  ipcBridge: {
    fileStream: { contentUpdate: { on: () => () => {} } },
    preview: { open: { on: () => () => {} } },
    browser: { openTabRequested: { on: () => () => {} } },
    fs: {
      writeFile: { invoke: async () => true },
      getFileMetadata: { invoke: async () => null },
      readFile: { invoke: async () => null },
      getImageBase64: { invoke: async () => null },
    },
  },
}));

import { BROWSER_BLANK_URL } from '@/renderer/pages/conversation/Preview/browser/constants';
import {
  PreviewProvider,
  usePreviewContext,
  type PreviewContextValue,
} from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { previewScopeStorageKey } from '@/renderer/pages/conversation/Preview/context/previewScope';

let ctx: PreviewContextValue;
const Probe: React.FC = () => {
  ctx = usePreviewContext();
  return null;
};

const OPEN_BROWSER = { openBrowserIfEmpty: true } as const;

const mount = (): void => {
  render(
    <PreviewProvider>
      <Probe />
    </PreviewProvider>
  );
};

const enterScope = (scope: string, options?: { openBrowserIfEmpty?: boolean; carryFromScope?: string }) =>
  act(() => ctx.closePreviewIfScopeChanged(scope, options));

const storedScope = (scope: string) => JSON.parse(localStorage.getItem(previewScopeStorageKey(scope)) ?? 'null');

beforeEach(() => {
  localStorage.clear();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  cleanup();
});

describe('conversation scopes open the browser pane by default', () => {
  it('opens one blank browser tab for a scope with nothing saved', () => {
    mount();
    enterScope('/ws/new', OPEN_BROWSER);

    expect(ctx.isOpen).toBe(true);
    expect(ctx.tabs).toHaveLength(1);
    expect(ctx.tabs[0]).toMatchObject({ content_type: 'browser', content: BROWSER_BLANK_URL });
    expect(ctx.activeTabId).toBe(ctx.tabs[0].id);
  });

  it('restores saved tabs exactly as saved instead of adding a browser tab', () => {
    localStorage.setItem(
      previewScopeStorageKey('/ws/saved'),
      JSON.stringify({
        isOpen: true,
        activeTabId: 'doc',
        tabs: [{ id: 'doc', title: 'a.md', content: '# a', content_type: 'markdown', metadata: { title: 'a.md' } }],
      })
    );
    mount();
    enterScope('/ws/saved', OPEN_BROWSER);

    expect(ctx.tabs.map((tab) => tab.id)).toEqual(['doc']);
    expect(ctx.isOpen).toBe(true);
  });

  it('keeps a scope closed after the user closed the panel', () => {
    mount();
    enterScope('/ws/a', OPEN_BROWSER);
    act(() => ctx.collapsePreview());
    enterScope('/ws/b', OPEN_BROWSER);
    enterScope('/ws/a', OPEN_BROWSER);

    expect(ctx.isOpen).toBe(false);
  });

  it('keeps a scope closed on re-entry of the same scope after the user closed the panel', () => {
    mount();
    enterScope('/ws/a', OPEN_BROWSER);
    act(() => ctx.collapsePreview());
    enterScope('/ws/a', OPEN_BROWSER);

    expect(ctx.isOpen).toBe(false);
  });

  it('keeps a scope closed after the user closed its last tab', () => {
    mount();
    enterScope('/ws/a', OPEN_BROWSER);
    act(() => ctx.closeTab(ctx.tabs[0].id));
    expect(ctx.tabs).toHaveLength(0);
    enterScope('/ws/b', OPEN_BROWSER);
    enterScope('/ws/a', OPEN_BROWSER);

    expect(ctx.isOpen).toBe(false);
    expect(ctx.tabs).toHaveLength(0);
  });

  it('reopens the same scope after a route-change close (closePreview) on re-entry', () => {
    mount();
    enterScope('/ws/a', OPEN_BROWSER);
    const tabId = ctx.tabs[0].id;
    act(() => ctx.closePreview());
    expect(ctx.isOpen).toBe(false);

    enterScope('/ws/a', OPEN_BROWSER);

    expect(ctx.isOpen).toBe(true);
    expect(ctx.tabs.map((tab) => tab.id)).toEqual([tabId]);
  });

  it('reopens a scope that was system-closed, after switching away and back', () => {
    mount();
    enterScope('/ws/a', OPEN_BROWSER);
    act(() => ctx.closePreview());
    enterScope('/ws/b', OPEN_BROWSER);
    enterScope('/ws/a', OPEN_BROWSER);

    expect(ctx.isOpen).toBe(true);
    expect(ctx.tabs).toHaveLength(1);
  });

  it('shows the browser for a new chat in a project the user left via new chat', () => {
    mount();
    enterScope('proj-1', OPEN_BROWSER);
    act(() => ctx.closePreview()); // Sider "new chat"
    enterScope('proj-1', OPEN_BROWSER); // the new conversation of the same project

    expect(ctx.isOpen).toBe(true);
    expect(ctx.tabs[0]).toMatchObject({ content_type: 'browser' });
  });

  it('opening a tab after a user close clears the closed flag', () => {
    mount();
    enterScope('/ws/a', OPEN_BROWSER);
    act(() => ctx.collapsePreview());
    act(() => ctx.openBrowserTab());
    act(() => ctx.closePreview());
    enterScope('/ws/a', OPEN_BROWSER);

    expect(ctx.isOpen).toBe(true);
  });

  it('keeps a scope closed when its stored state says the user closed it', () => {
    localStorage.setItem(
      previewScopeStorageKey('/ws/done'),
      JSON.stringify({ isOpen: false, tabs: [], activeTabId: null, userClosed: true })
    );
    mount();
    enterScope('/ws/done', OPEN_BROWSER);

    expect(ctx.isOpen).toBe(false);
    expect(ctx.tabs).toHaveLength(0);
  });

  it('persists the user-closed flag only for a user close', () => {
    mount();
    enterScope('/ws/a', OPEN_BROWSER);
    act(() => ctx.closePreview());
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(storedScope('/ws/a').userClosed).toBeUndefined();

    enterScope('/ws/c', OPEN_BROWSER);
    act(() => ctx.collapsePreview());
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(storedScope('/ws/c')).toMatchObject({ isOpen: false, userClosed: true });
  });

  it('carries live tabs, visibility and the closed flag when the scope goes from workspace to project', () => {
    mount();
    enterScope('/ws/a', OPEN_BROWSER);
    act(() => ctx.openPreview('# doc', 'markdown', { title: 'Doc' }));
    const tabIds = ctx.tabs.map((tab) => tab.id);
    expect(tabIds).toHaveLength(2);

    act(() => ctx.closePreviewIfScopeChanged('proj-1', { ...OPEN_BROWSER, carryFromScope: '/ws/a' }));

    expect(ctx.isOpen).toBe(true);
    expect(ctx.tabs.map((tab) => tab.id)).toEqual(tabIds);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(storedScope('proj-1').tabs).toHaveLength(2);
  });

  it("keeps the project's saved tabs when the workspace scope carried only the auto-opened blank tab", () => {
    localStorage.setItem(
      previewScopeStorageKey('proj-1'),
      JSON.stringify({
        isOpen: true,
        activeTabId: 'b',
        tabs: [
          { id: 'a', title: 'a.md', content: '# a', content_type: 'markdown', metadata: { title: 'a.md' } },
          { id: 'b', title: 'b.md', content: '# b', content_type: 'markdown', metadata: { title: 'b.md' } },
        ],
      })
    );
    mount();
    enterScope('/ws/a', OPEN_BROWSER);
    expect(ctx.tabs).toHaveLength(1); // the blank browser tab

    act(() => ctx.closePreviewIfScopeChanged('proj-1', { ...OPEN_BROWSER, carryFromScope: '/ws/a' }));

    expect(ctx.tabs.map((tab) => tab.id)).toEqual(['a', 'b']);
    expect(ctx.activeTabId).toBe('b');
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(storedScope('proj-1').tabs.map((tab: { id: string }) => tab.id)).toEqual(['a', 'b']);
  });

  it("adds live tabs after the project's saved tabs on the carry, keeping the live active tab", () => {
    localStorage.setItem(
      previewScopeStorageKey('proj-1'),
      JSON.stringify({
        isOpen: true,
        activeTabId: 'a',
        userClosed: false,
        tabs: [{ id: 'a', title: 'a.md', content: '# a', content_type: 'markdown', metadata: { title: 'a.md' } }],
      })
    );
    mount();
    enterScope('/ws/a', OPEN_BROWSER);
    act(() => ctx.openPreview('# doc', 'markdown', { title: 'Doc' }));
    const docId = ctx.activeTabId;

    act(() => ctx.closePreviewIfScopeChanged('proj-1', { ...OPEN_BROWSER, carryFromScope: '/ws/a' }));

    expect(ctx.tabs.map((tab) => tab.id)).toEqual(['a', docId]);
    expect(ctx.activeTabId).toBe(docId);
  });

  it('carries a user close across the workspace to project switch', () => {
    mount();
    enterScope('/ws/a', OPEN_BROWSER);
    act(() => ctx.collapsePreview());

    act(() => ctx.closePreviewIfScopeChanged('proj-1', { ...OPEN_BROWSER, carryFromScope: '/ws/a' }));

    expect(ctx.isOpen).toBe(false);
    expect(ctx.tabs).toHaveLength(1);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(storedScope('proj-1')).toMatchObject({ isOpen: false, userClosed: true });
  });

  it('does not open a browser tab when the caller does not ask for it (team and other routes)', () => {
    mount();
    enterScope('/ws/team');

    expect(ctx.isOpen).toBe(false);
    expect(ctx.tabs).toHaveLength(0);
  });

  it('does not open a browser tab when there is no scope', () => {
    mount();
    enterScope('/ws/a', OPEN_BROWSER);
    act(() => ctx.closePreviewIfScopeChanged(null, OPEN_BROWSER));

    expect(ctx.isOpen).toBe(false);
    expect(ctx.tabs).toHaveLength(0);
  });
});
