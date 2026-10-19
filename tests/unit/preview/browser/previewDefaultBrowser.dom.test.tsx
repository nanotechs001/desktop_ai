/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IConversationListChangedEvent } from '@/common/adapter/ipcBridge';
import type { TChatConversation } from '@/common/config/storage';

const scopeEntered = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-router-dom', () => ({ useParams: () => ({ id: 'c1' }), useNavigate: () => vi.fn() }));
vi.mock('@/renderer/pages/conversation/components/ChatConversation', () => ({ default: () => null }));
// The route's view of the context; the provider tests import the real context module directly.
vi.mock('@/renderer/pages/conversation/Preview', () => ({
  // A fresh function per render, like the real context whose callback changes with its state.
  usePreviewContext: () => ({ closePreviewIfScopeChanged: (...args: unknown[]) => scopeEntered(...args) }),
}));
vi.mock('@/renderer/hooks/chat/useAutoTitle', () => ({ useAutoTitle: () => ({ syncTitleFromHistory: vi.fn() }) }));

const getConversationOrNull = vi.fn<(id: string) => Promise<TChatConversation | null>>();
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: (id: string) => getConversationOrNull(id),
}));

let listChangedCb: ((e: IConversationListChangedEvent) => void) | null = null;
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
    conversation: {
      listChanged: {
        on: (cb: (e: IConversationListChangedEvent) => void) => {
          listChangedCb = cb;
          return () => {
            listChangedCb = null;
          };
        },
      },
    },
  },
}));

import ChatConversationIndex from '@/renderer/pages/conversation/index';
import { BROWSER_BLANK_URL } from '@/renderer/pages/conversation/Preview/browser/constants';
import {
  PreviewProvider,
  usePreviewContext,
  type PreviewContextValue,
} from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { previewScopeStorageKey } from '@/renderer/pages/conversation/Preview/context/previewScope';
import {
  resetCurrentConversationForTest,
  setCurrentConversation,
} from '@/renderer/pages/conversation/explorer/currentConversationStore';

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

const enterScope = (
  scope: string,
  options?: { openBrowserIfEmpty?: boolean; carryFromScope?: string; conversationId?: string }
) => act(() => ctx.closePreviewIfScopeChanged(scope, options));

const storedScope = (scope: string) => JSON.parse(localStorage.getItem(previewScopeStorageKey(scope)) ?? 'null');

beforeEach(() => {
  localStorage.clear();
  resetCurrentConversationForTest();
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

  it('drops only the auto-opened blank tab on the carry, never an agent-owned or user-opened blank tab', () => {
    localStorage.setItem(
      previewScopeStorageKey('proj-1'),
      JSON.stringify({
        isOpen: true,
        activeTabId: 'a',
        tabs: [{ id: 'a', title: 'a.md', content: '# a', content_type: 'markdown', metadata: { title: 'a.md' } }],
      })
    );
    mount();
    enterScope('/ws/a', OPEN_BROWSER);
    const [autoOpened] = ctx.tabs.map((tab) => tab.id);
    act(() => ctx.openBrowserTab());
    const userBlank = ctx.activeTabId;
    act(() => ctx.openBrowserTab());
    const agentBlank = ctx.activeTabId as string;
    act(() => ctx.updateTab(agentBlank, { metadata: { agentOwned: true } }));

    act(() => ctx.closePreviewIfScopeChanged('proj-1', { ...OPEN_BROWSER, carryFromScope: '/ws/a' }));

    expect(ctx.tabs.map((tab) => tab.id)).toEqual(['a', userBlank, agentBlank]);
    expect(ctx.tabs.map((tab) => tab.id)).not.toContain(autoOpened);
  });

  it("keeps the workspace's user close on the carry when the project's saved state has none", () => {
    localStorage.setItem(
      previewScopeStorageKey('proj-1'),
      JSON.stringify({
        isOpen: true,
        activeTabId: 'a',
        tabs: [{ id: 'a', title: 'a.md', content: '# a', content_type: 'markdown', metadata: { title: 'a.md' } }],
      })
    );
    mount();
    enterScope('/ws/a', OPEN_BROWSER);
    act(() => ctx.collapsePreview());

    act(() => ctx.closePreviewIfScopeChanged('proj-1', { ...OPEN_BROWSER, carryFromScope: '/ws/a' }));

    expect(ctx.isOpen).toBe(false);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(storedScope('proj-1')).toMatchObject({ isOpen: false, userClosed: true });
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

describe('watching a robot opens its chat browser pane', () => {
  it('reopens the pane the user closed when that conversation is entered next, once', () => {
    mount();
    enterScope('/ws/a', { ...OPEN_BROWSER, conversationId: 'c1' });
    act(() => ctx.collapsePreview());
    enterScope('/ws/b', { ...OPEN_BROWSER, conversationId: 'c2' });

    act(() => ctx.revealBrowserFor('c1'));
    enterScope('/ws/a', { ...OPEN_BROWSER, conversationId: 'c1' });
    expect(ctx.isOpen).toBe(true);
    expect(ctx.tabs[0]).toMatchObject({ content_type: 'browser' });

    // One-shot: a later user close holds again.
    act(() => ctx.collapsePreview());
    enterScope('/ws/b', { ...OPEN_BROWSER, conversationId: 'c2' });
    enterScope('/ws/a', { ...OPEN_BROWSER, conversationId: 'c1' });
    expect(ctx.isOpen).toBe(false);
  });

  it('reopens a user-closed pane in the same scope', () => {
    mount();
    enterScope('/ws/a', { ...OPEN_BROWSER, conversationId: 'c1' });
    act(() => ctx.collapsePreview());
    act(() => ctx.revealBrowserFor('c2'));
    enterScope('/ws/a', { ...OPEN_BROWSER, conversationId: 'c2' });
    expect(ctx.isOpen).toBe(true);
  });

  it('opens the pane at once when the conversation is already on screen', () => {
    mount();
    enterScope('/ws/a', { ...OPEN_BROWSER, conversationId: 'c1' });
    setCurrentConversation('c1');
    act(() => ctx.collapsePreview());

    act(() => ctx.revealBrowserFor('c1'));
    expect(ctx.isOpen).toBe(true);
  });

  it('keeps a request while another conversation re-enters its scope first', () => {
    mount();
    enterScope('/ws/y', { ...OPEN_BROWSER, conversationId: 'cy' });
    act(() => ctx.collapsePreview());
    enterScope('/ws/x', { ...OPEN_BROWSER, conversationId: 'cx' });

    act(() => ctx.revealBrowserFor('cy'));
    enterScope('/ws/x', { ...OPEN_BROWSER, conversationId: 'cx' }); // e.g. its project_id arrived
    enterScope('/ws/y', { ...OPEN_BROWSER, conversationId: 'cy' });
    expect(ctx.isOpen).toBe(true);
  });

  it('opens the given address as a new tab in that conversation once it is entered', () => {
    mount();
    enterScope('/ws/a', { ...OPEN_BROWSER, conversationId: 'c1' });
    act(() => ctx.collapsePreview());
    enterScope('/ws/b', { ...OPEN_BROWSER, conversationId: 'c2' });

    act(() => ctx.revealBrowserFor('c1', 'https://example.com/x'));
    expect(ctx.tabs.map((tab) => tab.content)).not.toContain('https://example.com/x');
    enterScope('/ws/a', { ...OPEN_BROWSER, conversationId: 'c1' });

    expect(ctx.isOpen).toBe(true);
    expect(ctx.tabs.map((tab) => tab.content)).toEqual([BROWSER_BLANK_URL, 'https://example.com/x']);
    expect(ctx.activeTabId).toBe(ctx.tabs[1].id);

    // One-shot: entering again does not open it again.
    enterScope('/ws/b', { ...OPEN_BROWSER, conversationId: 'c2' });
    enterScope('/ws/a', { ...OPEN_BROWSER, conversationId: 'c1' });
    expect(ctx.tabs.filter((tab) => tab.content === 'https://example.com/x')).toHaveLength(1);
  });

  it('opens the given address in the first tab of a conversation that has none, with no blank tab', () => {
    mount();
    enterScope('/ws/b', { ...OPEN_BROWSER, conversationId: 'c2' });
    act(() => ctx.revealBrowserFor('c3', 'https://example.com/y'));
    enterScope('/ws/c', { ...OPEN_BROWSER, conversationId: 'c3' });

    expect(ctx.isOpen).toBe(true);
    expect(ctx.tabs.map((tab) => tab.content)).toEqual(['https://example.com/y']);
  });

  it('opens the given address at once when the conversation is already on screen', () => {
    mount();
    enterScope('/ws/a', { ...OPEN_BROWSER, conversationId: 'c1' });
    setCurrentConversation('c1');
    act(() => ctx.collapsePreview());

    act(() => ctx.revealBrowserFor('c1', 'https://example.com/z'));
    expect(ctx.isOpen).toBe(true);
    expect(ctx.tabs.map((tab) => tab.content)).toContain('https://example.com/z');
  });

  it('a request for a conversation that is never entered does not reopen another one', () => {
    mount();
    enterScope('/ws/a', { ...OPEN_BROWSER, conversationId: 'c1' });
    act(() => ctx.collapsePreview());
    act(() => ctx.revealBrowserFor('c9'));
    enterScope('/ws/b', { ...OPEN_BROWSER, conversationId: 'c2' });
    enterScope('/ws/a', { ...OPEN_BROWSER, conversationId: 'c1' });
    expect(ctx.isOpen).toBe(false);
  });
});

/**
 * The conversation route enters its preview scope once per conversation/scope, and tells the
 * context when the scope changed under the same conversation (project_id arrived), so the
 * live tabs follow it.
 */
describe('conversation route preview scope entry', () => {
  const conv = (project_id: string | null): TChatConversation =>
    ({ id: 'c1', name: 'x', type: 'acp', extra: { workspace: '/w' }, project_id }) as unknown as TChatConversation;

  beforeEach(() => {
    vi.useRealTimers(); // SWR and waitFor need real timers
    scopeEntered.mockReset();
    getConversationOrNull.mockReset();
  });

  it('enters the scope with the browser default and carries the live tabs once project_id arrives', async () => {
    getConversationOrNull.mockResolvedValueOnce(conv(null)).mockResolvedValue(conv('p1'));
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ChatConversationIndex />
      </SWRConfig>
    );

    await waitFor(() => expect(scopeEntered).toHaveBeenCalledTimes(1));
    expect(scopeEntered).toHaveBeenLastCalledWith('/w', {
      openBrowserIfEmpty: true,
      carryFromScope: undefined,
      conversationId: 'c1',
    });

    listChangedCb?.({ conversation_id: 'c1', action: 'updated' } as IConversationListChangedEvent);

    await waitFor(() => expect(scopeEntered).toHaveBeenCalledTimes(2));
    expect(scopeEntered).toHaveBeenLastCalledWith('p1', {
      openBrowserIfEmpty: true,
      carryFromScope: '/w',
      conversationId: 'c1',
    });
  });
});
