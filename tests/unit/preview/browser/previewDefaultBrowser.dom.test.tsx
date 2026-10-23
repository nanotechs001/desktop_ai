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
import { BROWSER_BLANK_URL, MAX_BROWSER_TABS } from '@/renderer/pages/conversation/Preview/browser/constants';
import {
  PreviewProvider,
  usePreviewContext,
  type PreviewContextValue,
} from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { previewScopeStorageKey } from '@/renderer/pages/conversation/Preview/context/previewScope';
import { setConversationListForTest } from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import { configService } from '@/common/config/configService';
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
  options?: {
    openBrowserIfEmpty?: boolean;
    carryFromScope?: string;
    conversationId?: string;
  }
) => act(() => ctx.closePreviewIfScopeChanged(scope, options));

const storedScope = (scope: string) => JSON.parse(localStorage.getItem(previewScopeStorageKey(scope)) ?? 'null');

beforeEach(() => {
  localStorage.clear();
  resetCurrentConversationForTest();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
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

  it('drops a link request that is consumed after its expiry', () => {
    mount();
    enterScope('/ws/a', { ...OPEN_BROWSER, conversationId: 'c1' });
    act(() => ctx.collapsePreview());
    enterScope('/ws/b', { ...OPEN_BROWSER, conversationId: 'c2' });

    act(() => ctx.revealBrowserFor('c1', 'https://example.com/late'));
    act(() => {
      vi.advanceTimersByTime(11_000);
    });
    enterScope('/ws/a', { ...OPEN_BROWSER, conversationId: 'c1' });

    expect(ctx.tabs.map((tab) => tab.content)).not.toContain('https://example.com/late');
    expect(ctx.isOpen).toBe(false);
  });

  it('still opens a link request consumed within its expiry', () => {
    mount();
    enterScope('/ws/a', { ...OPEN_BROWSER, conversationId: 'c1' });
    act(() => ctx.collapsePreview());
    enterScope('/ws/b', { ...OPEN_BROWSER, conversationId: 'c2' });

    act(() => ctx.revealBrowserFor('c1', 'https://example.com/soon'));
    act(() => {
      vi.advanceTimersByTime(5_000);
    });
    enterScope('/ws/a', { ...OPEN_BROWSER, conversationId: 'c1' });

    expect(ctx.tabs.map((tab) => tab.content)).toContain('https://example.com/soon');
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
 * One browser per VA Bot: every chat of the bot shows the same browser tabs (one `bot:<agentId>` scope), so moving
 * between its chats changes nothing in the pane and restores nothing of the chat being opened.
 */
describe('one browser per VA Bot', () => {
  const BOT_B = { kind: 'agent', agentId: 'bot-b' } as const;
  const botChat = (conversationId: string, agentId = 'bot-b') =>
    enterScope(`bot:${agentId}`, { ...OPEN_BROWSER, conversationId });
  const ids = (tabs: readonly { id: string }[]) => tabs.map((tab) => tab.id);

  it('switching between two chats of the bot keeps the same tabs and active tab, with no remount, both ways', () => {
    mount();
    botChat('c1');
    const blank = ctx.tabs[0].id;
    act(() => ctx.openBrowserTab('https://example.com/cart', BOT_B));
    act(() => ctx.switchTab(blank));
    const tabs = ctx.tabs;
    const live = ctx.liveBrowserTabs;

    for (const chat of ['c2', 'c1', 'c2']) {
      botChat(chat);
      // The very same tab objects in the same order: no webview leaves, moves in or re-enters the DOM.
      expect(ctx.tabs).toBe(tabs);
      expect(ctx.liveBrowserTabs).toEqual(live);
      expect(ctx.activeTabId).toBe(blank);
      expect(ctx.isOpen).toBe(true);
    }
  });

  it("opening an older chat restores nothing of its own, only the bot's tabs", () => {
    localStorage.setItem(
      previewScopeStorageKey('/ws/c0'),
      JSON.stringify({
        isOpen: true,
        activeTabId: 'browser-1-own',
        tabs: [{ id: 'browser-1-own', title: 'x', content: 'https://own.test/', content_type: 'browser' }],
      })
    );
    mount();
    botChat('c2');
    act(() => ctx.openBrowserTab('https://example.com/cart', BOT_B));
    const tabs = ids(ctx.tabs);

    botChat('c0');

    expect(ids(ctx.tabs)).toEqual(tabs);
    expect(ctx.tabs.some((tab) => tab.content === 'https://own.test/')).toBe(false);
    expect(storedScope('/ws/c0').tabs).toHaveLength(1); // left where it was, never erased
  });

  it("never mixes two bots' tabs", () => {
    mount();
    botChat('a1', 'bot-a');
    act(() => ctx.openBrowserTab('https://a.test/', { kind: 'agent', agentId: 'bot-a' }));
    const aTabs = ids(ctx.tabs);

    botChat('b1');
    expect(ctx.tabs.map((tab) => tab.content)).toEqual([BROWSER_BLANK_URL]);
    const bTabs = ids(ctx.tabs);
    expect(ids(ctx.liveBrowserTabs).toSorted()).toEqual([...aTabs, ...bTabs].toSorted()); // A's stay live, hidden

    botChat('a2', 'bot-a');
    expect(ids(ctx.tabs)).toEqual(aTabs);
    botChat('b2');
    expect(ids(ctx.tabs)).toEqual(bTabs);
  });

  it("a regular chat keeps its own browser between the bot's chats", () => {
    mount();
    botChat('c1');
    const botTabs = ids(ctx.tabs);
    enterScope('/ws/r1', { ...OPEN_BROWSER, conversationId: 'r1' });
    const regular = ids(ctx.tabs);
    expect(regular).not.toEqual(botTabs);

    botChat('c2');
    expect(ids(ctx.tabs)).toEqual(botTabs);
    enterScope('/ws/r1', { ...OPEN_BROWSER, conversationId: 'r1' });
    expect(ids(ctx.tabs)).toEqual(regular);
  });

  it("following a robot into another chat of the bot shows the bot's tabs as they were, even after a close", () => {
    mount();
    botChat('c1');
    act(() => ctx.openBrowserTab('https://example.com/cart', BOT_B));
    const tabs = ids(ctx.tabs);
    const active = ctx.activeTabId;
    act(() => ctx.collapsePreview());
    enterScope('/ws/r1', { ...OPEN_BROWSER, conversationId: 'r1' });

    act(() => ctx.revealBrowserFor('c3')); // the robot's popup moved to c3; the main window follows
    botChat('c3');

    expect(ids(ctx.tabs)).toEqual(tabs);
    expect(ctx.activeTabId).toBe(active);
    expect(ctx.isOpen).toBe(true);
  });

  it('a Watch on a bot chat with no tabs opens one in the bot profile, and changes nothing when it has tabs', () => {
    mount();
    act(() => ctx.revealBrowserFor('c1'));
    enterScope('bot:bot-b', { ...OPEN_BROWSER, conversationId: 'c1' });
    expect(ctx.tabs.map((tab) => tab.metadata?.profile)).toEqual([BOT_B]);
    setCurrentConversation('c2');
    enterScope('bot:bot-b', { conversationId: 'c2' });
    const tabs = ctx.tabs;

    act(() => ctx.revealBrowserFor('c2'));

    expect(ctx.tabs).toBe(tabs);
    expect(ctx.isOpen).toBe(true);
  });
});

/**
 * Before one browser per bot, each chat of a bot stored its own browser tabs. The bot's tabs in its own profile move
 * once into the bot scope, de-duplicated by address and capped; nothing else of those chats moves or is lost.
 */
describe("the bot scope takes over its chats' stored tabs once", () => {
  const botTab = (id: string, url: string, agentId = 'bot-b') => ({
    id,
    title: url,
    content: url,
    content_type: 'browser',
    metadata: { profile: { kind: 'agent', agentId } },
  });
  const store = (scope: string, tabs: object[], savedAt = 1) =>
    localStorage.setItem(
      previewScopeStorageKey(scope),
      JSON.stringify({ isOpen: true, tabs, activeTabId: (tabs[0] as { id: string }).id, savedAt })
    );
  const storedIdsOf = (scope: string) => storedScope(scope).tabs.map((tab: { id: string }) => tab.id);

  it('merges the bot-profile tabs of every stored scope, de-duplicated, and leaves the rest where they are (a Personal tab is dropped)', () => {
    store(
      '/ws/c1',
      [
        botTab('browser-1-a', 'https://a.test/'),
        { id: 'browser-2-p', title: 'p', content: 'https://personal.test/', content_type: 'browser' },
        { id: 'markdown-3', title: 'Doc', content: '# doc', content_type: 'markdown' },
      ],
      2
    );
    store(
      '/ws/c2',
      [
        botTab('browser-4-a', 'https://a.test/'),
        botTab('browser-5-b', 'https://b.test/'),
        botTab('browser-6-x', 'https://x.test/', 'bot-x'),
      ],
      1
    );
    mount();

    enterScope('bot:bot-b', { ...OPEN_BROWSER, conversationId: 'c1' });

    expect(ctx.tabs.map((tab) => tab.content)).toEqual(['https://a.test/', 'https://b.test/']);
    expect(ctx.isOpen).toBe(true);
    // The Personal tab is gone (there is no Personal profile any more); the document stays.
    expect(storedIdsOf('/ws/c1')).toEqual(['markdown-3']);
    // The older copy of the same address is not taken, so it stays where it was.
    expect(storedIdsOf('/ws/c2')).toEqual(['browser-4-a', 'browser-6-x']);
  });

  it('caps the merged tabs, most recently stored scope first, and leaves the tabs it does not take where they are', () => {
    store(
      '/ws/old',
      Array.from({ length: MAX_BROWSER_TABS }, (_, i) => botTab(`browser-old-${i}`, `https://old${i}.test/`)),
      100
    );
    store(
      '/ws/new',
      [botTab('browser-new-0', 'https://new0.test/'), botTab('browser-new-1', 'https://old0.test/')],
      200
    );
    mount();

    enterScope('bot:bot-b', { ...OPEN_BROWSER, conversationId: 'c1' });

    expect(ctx.tabs).toHaveLength(MAX_BROWSER_TABS);
    expect(ctx.tabs.slice(0, 2).map((tab) => tab.id)).toEqual(['browser-new-0', 'browser-new-1']);
    // Not taken (over the cap, or the same address as a newer one): still stored where they were, never lost.
    expect(storedIdsOf('/ws/new')).toEqual([]);
    expect(storedIdsOf('/ws/old')).toEqual(['browser-old-0', 'browser-old-9']);
  });

  it('moves a live tab it takes into the bot scope: shown once, the same webview, and no longer stored in its old scope', () => {
    store('/ws/p', [botTab('browser-1-live', 'https://live.test/')]);
    mount();
    enterScope('/ws/p', { ...OPEN_BROWSER, conversationId: 'r' });
    const live = ctx.liveBrowserTabs.find((tab) => tab.id === 'browser-1-live');
    expect(live).toBeDefined();

    enterScope('bot:bot-b', { ...OPEN_BROWSER, conversationId: 'c1' });

    expect(ctx.tabs.map((tab) => tab.id)).toEqual(['browser-1-live']);
    expect(ctx.liveBrowserTabs.filter((tab) => tab.id === 'browser-1-live')).toEqual([live]);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(storedIdsOf('/ws/p')).not.toContain('browser-1-live');
    enterScope('/ws/p', { ...OPEN_BROWSER, conversationId: 'r' });
    expect(ctx.tabs.map((tab) => tab.id)).not.toContain('browser-1-live');
    expect(ctx.liveBrowserTabs.filter((tab) => tab.id === 'browser-1-live')).toHaveLength(1);
  });

  it('runs once: a later stored bot tab elsewhere stays where it is', () => {
    mount();
    enterScope('bot:bot-b', { ...OPEN_BROWSER, conversationId: 'c1' });
    enterScope('/ws/r', { conversationId: 'r' });
    store('/ws/c3', [botTab('browser-9-late', 'https://late.test/')]);

    enterScope('bot:bot-b', { ...OPEN_BROWSER, conversationId: 'c3' });

    expect(ctx.tabs.some((tab) => tab.content === 'https://late.test/')).toBe(false);
    expect(storedIdsOf('/ws/c3')).toEqual(['browser-9-late']);
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
    configService.setLocal('agent.builtinDefaultId', 'aion-default-agent');
    setConversationListForTest([]);
  });
  const renderRoute = () =>
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ChatConversationIndex />
      </SWRConfig>
    );

  it("waits for the default Agent's id before entering a chat of an Agent, then enters as a regular chat", async () => {
    configService.reset();
    vi.spyOn(configService, 'whenReady').mockReturnValue(new Promise(() => {})); // still loading
    getConversationOrNull.mockResolvedValue({
      ...conv('p1'),
      assistant: { id: 'adopted-agent', source: 'user', name: 'Agent', avatar: '', backend: 'claude' },
    } as TChatConversation);
    renderRoute();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scopeEntered).not.toHaveBeenCalled(); // it may be the adopted default Agent, or a bot

    act(() => configService.setLocal('agent.builtinDefaultId', 'adopted-agent'));

    await waitFor(() => expect(scopeEntered).toHaveBeenCalledTimes(1));
    expect(scopeEntered).toHaveBeenLastCalledWith('p1', {
      openBrowserIfEmpty: true,
      carryFromScope: undefined,
      conversationId: 'c1',
    });
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

  it("enters the bot's one browser scope for any chat of the bot, older or newer, whatever its project", async () => {
    const bot = { id: 'bot-b', source: 'user', name: 'B', avatar: '', backend: 'claude' };
    setConversationListForTest([{ id: 'c9', assistant: bot, created_at: 900 }] as unknown as TChatConversation[]);
    getConversationOrNull.mockResolvedValue({ ...conv('p1'), assistant: bot, created_at: 100 } as TChatConversation);
    renderRoute();

    await waitFor(() => expect(scopeEntered).toHaveBeenCalledTimes(1));
    expect(scopeEntered).toHaveBeenLastCalledWith('bot:bot-b', {
      openBrowserIfEmpty: true,
      carryFromScope: undefined,
      conversationId: 'c1',
    });
    setConversationListForTest([]);
  });

  it('does not name the default Agent or a built-in preset as a bot: their chats keep a temporary browser each', async () => {
    for (const assistant of [
      { id: 'aion-default-agent', source: 'user' },
      { id: 'preset-x', source: 'builtin' },
    ]) {
      scopeEntered.mockReset();
      getConversationOrNull.mockResolvedValue({
        ...conv('p1'),
        assistant: { ...assistant, name: 'A', avatar: '', backend: 'claude' },
      } as TChatConversation);
      const { unmount } = render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <ChatConversationIndex />
        </SWRConfig>
      );

      // eslint-disable-next-line no-await-in-loop -- one render at a time
      await waitFor(() => expect(scopeEntered).toHaveBeenCalledTimes(1));
      expect(scopeEntered).toHaveBeenLastCalledWith('p1', {
        openBrowserIfEmpty: true,
        carryFromScope: undefined,
        conversationId: 'c1',
      });
      unmount();
    }
  });

  it('does not ask for the browser default outside Electron (the WebUI)', async () => {
    const w = window as Window & { electronAPI?: unknown };
    const electronApiStub = w.electronAPI;
    delete w.electronAPI;
    try {
      getConversationOrNull.mockResolvedValue(conv('p1'));
      render(
        <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
          <ChatConversationIndex />
        </SWRConfig>
      );

      await waitFor(() => expect(scopeEntered).toHaveBeenCalledTimes(1));
      expect(scopeEntered).toHaveBeenLastCalledWith('p1', {
        openBrowserIfEmpty: false,
        carryFromScope: undefined,
        conversationId: 'c1',
      });
    } finally {
      w.electronAPI = electronApiStub;
    }
  });
});
