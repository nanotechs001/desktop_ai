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
    agentId?: string;
    newestOfBot?: boolean;
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
 * A VA Bot's agent tabs belong to the bot: a new chat of that bot shows the live tabs its earlier chat's agent
 * opened, on the same webviews (the same tab ids), instead of a fresh blank browser.
 */
describe("a VA Bot's new chat shows the bot's browser tabs", () => {
  const BOT = { kind: 'agent', agentId: 'bot-b' } as const;
  /** A tab an agent of bot B opened in the scope on screen; main's ownership report names the chat that owns it. */
  const openBotTab = (url: string, ownerChat = 'c1'): string => {
    act(() => ctx.openBrowserTab(url, BOT));
    const id = String(ctx.activeTabId);
    act(() => ctx.updateTab(id, { metadata: { agentOwned: true, agentConversationId: ownerChat } }));
    return id;
  };
  /** The relay hands the tab to another chat of the bot (its agent connected). */
  const handOver = (id: string, chat: string) =>
    act(() => ctx.updateTab(id, { metadata: { agentOwned: true, agentConversationId: chat } }));

  it("moves the bot's live agent tabs into the chat that owns them, with no blank tab and no duplicate", () => {
    mount();
    enterScope('/ws/c1', { ...OPEN_BROWSER, conversationId: 'c1', agentId: 'bot-b' });
    const blank = ctx.tabs[0].id;
    const botTab = openBotTab('https://example.com/cart', 'c2');
    act(() => ctx.openBrowserTab('https://example.com/mine', BOT)); // the user's own tab in the bot's profile
    const userTab = String(ctx.activeTabId);

    enterScope('/ws/c2', { ...OPEN_BROWSER, conversationId: 'c2', agentId: 'bot-b' });

    expect(ctx.tabs.map((tab) => tab.id)).toEqual([botTab]);
    expect(ctx.tabs[0]).toMatchObject({ content: 'https://example.com/cart', metadata: { agentOwned: true } });
    expect(ctx.activeTabId).toBe(botTab);
    expect(ctx.isOpen).toBe(true);
    // The same tab (its webview) is mounted once; the old chat's other tabs stay mounted in the background.
    expect(ctx.liveBrowserTabs.map((tab) => tab.id).toSorted()).toEqual([blank, botTab, userTab].toSorted());
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(storedScope('/ws/c1').tabs.map((tab: { id: string }) => tab.id)).toEqual([blank, userTab]);
  });

  it("a bot's newest chat shows the live tabs its older chat still owns, with no blank tab", () => {
    mount();
    enterScope('/ws/c1', { ...OPEN_BROWSER, conversationId: 'c1', agentId: 'bot-b' });
    const blank = ctx.tabs[0].id;
    const botTab = openBotTab('https://example.com/cart', 'c1'); // the relay hands it over on c2's first command

    enterScope('/ws/c2', { ...OPEN_BROWSER, conversationId: 'c2', agentId: 'bot-b', newestOfBot: true });

    expect(ctx.tabs.map((tab) => tab.id)).toEqual([botTab]);
    expect(ctx.tabs.some((tab) => tab.content === BROWSER_BLANK_URL)).toBe(false);
    expect(ctx.activeTabId).toBe(botTab);
    expect(ctx.liveBrowserTabs.map((tab) => tab.id).toSorted()).toEqual([blank, botTab].toSorted());
  });

  it("an older chat does not show the tabs the bot's newer chat owns", () => {
    mount();
    enterScope('/ws/c1', { ...OPEN_BROWSER, conversationId: 'c1', agentId: 'bot-b' });
    const blank = ctx.tabs[0].id;
    const botTab = openBotTab('https://example.com/cart', 'c1');
    enterScope('/ws/c2', { ...OPEN_BROWSER, conversationId: 'c2', agentId: 'bot-b', newestOfBot: true });
    handOver(botTab, 'c2');

    enterScope('/ws/c1', { ...OPEN_BROWSER, conversationId: 'c1', agentId: 'bot-b', newestOfBot: false });
    expect(ctx.tabs).toEqual([]); // an older chat starts with no browser at all
    expect(ctx.liveBrowserTabs.map((tab) => tab.id).toSorted()).toEqual([blank, botTab].toSorted());
  });

  it("returning to an old chat does not pull the tabs the bot's new chat owns (R18)", () => {
    mount();
    enterScope('/ws/c1', { ...OPEN_BROWSER, conversationId: 'c1', agentId: 'bot-b' });
    const blank = ctx.tabs[0].id;
    const botTab = openBotTab('https://example.com/cart', 'c2');
    enterScope('/ws/c2', { ...OPEN_BROWSER, conversationId: 'c2', agentId: 'bot-b' });
    expect(ctx.tabs.map((tab) => tab.id)).toEqual([botTab]);

    enterScope('/ws/c1', { ...OPEN_BROWSER, conversationId: 'c1', agentId: 'bot-b' });
    expect(ctx.tabs.map((tab) => tab.id)).toEqual([blank]);
    expect(ctx.liveBrowserTabs.filter((tab) => tab.id === botTab)).toHaveLength(1); // still live, in the background
  });

  it('keeps the tabs in the old chat until the relay hands them to the new one, then brings them on screen', () => {
    mount();
    enterScope('/ws/c1', { ...OPEN_BROWSER, conversationId: 'c1', agentId: 'bot-b' });
    const botTab = openBotTab('https://example.com/cart', 'c1');

    enterScope('/ws/c2', { ...OPEN_BROWSER, conversationId: 'c2', agentId: 'bot-b' });
    expect(ctx.tabs.map((tab) => tab.content)).toEqual([BROWSER_BLANK_URL]); // c1's agent still drives it

    handOver(botTab, 'c2');
    expect(ctx.tabs.map((tab) => tab.id)).toContain(botTab);
    expect(ctx.liveBrowserTabs.filter((tab) => tab.id === botTab)).toHaveLength(1);
  });

  it('takes the bot tabs into a chat of the same scope that is already on screen', () => {
    mount();
    enterScope('/ws/c1', { ...OPEN_BROWSER, conversationId: 'c1', agentId: 'bot-b' });
    const botTab = openBotTab('https://example.com/cart', 'c2');
    act(() => ctx.closeTab(ctx.tabs[0].id)); // the blank tab
    enterScope('/ws/shared', { conversationId: 'x' });

    enterScope('/ws/shared', { ...OPEN_BROWSER, conversationId: 'c2', agentId: 'bot-b' });

    expect(ctx.tabs.map((tab) => tab.id)).toEqual([botTab]);
    expect(ctx.isOpen).toBe(true);
  });

  it('still opens a blank tab for a bot with no live tabs, and for a chat of no bot', () => {
    mount();
    enterScope('/ws/c1', { ...OPEN_BROWSER, conversationId: 'c1', agentId: 'bot-b' });
    const botTab = openBotTab('https://example.com/cart');

    enterScope('/ws/z', { ...OPEN_BROWSER, conversationId: 'z1', agentId: 'bot-z' });
    expect(ctx.tabs).toHaveLength(1);
    expect(ctx.tabs[0]).toMatchObject({ content: BROWSER_BLANK_URL });

    enterScope('/ws/r', { ...OPEN_BROWSER, conversationId: 'r1' });
    expect(ctx.tabs).toHaveLength(1);
    expect(ctx.tabs[0]).toMatchObject({ content: BROWSER_BLANK_URL });
    expect(ctx.liveBrowserTabs.map((tab) => tab.id)).toContain(botTab);
  });
});

/**
 * An older chat of a VA Bot is like a past chat in a desktop browser pane: it opens with no browser. The bot's browser
 * (its one profile) comes back into it only once the user continues there and its agent uses the browser again.
 */
describe("an older chat of a VA Bot gets the bot's browser back only when it continues", () => {
  const BOT = { kind: 'agent', agentId: 'bot-b' } as const;
  const BOT_CHAT = { ...OPEN_BROWSER, agentId: 'bot-b' } as const;
  const openBotTab = (url: string, ownerChat: string): string => {
    act(() => ctx.openBrowserTab(url, BOT));
    const id = String(ctx.activeTabId);
    act(() => ctx.updateTab(id, { metadata: { agentOwned: true, agentConversationId: ownerChat } }));
    return id;
  };
  const handOver = (id: string, chat: string) =>
    act(() => ctx.updateTab(id, { metadata: { agentOwned: true, agentConversationId: chat } }));
  /** c1 opened a bot tab; the newer chat c2 took it and the relay handed it to c2. */
  const botTabInNewerChat = (): { botTab: string; blank: string } => {
    enterScope('/ws/c1', { ...BOT_CHAT, conversationId: 'c1', newestOfBot: true });
    const blank = ctx.tabs[0].id;
    const botTab = openBotTab('https://example.com/cart', 'c1');
    enterScope('/ws/c2', { ...BOT_CHAT, conversationId: 'c2', newestOfBot: true });
    handOver(botTab, 'c2');
    return { botTab, blank };
  };

  it('opens with no browser tab, restores none and moves none of the bot tabs', () => {
    mount();
    const { botTab, blank } = botTabInNewerChat();

    enterScope('/ws/c1', { ...BOT_CHAT, conversationId: 'c1', newestOfBot: false });

    expect(ctx.tabs).toEqual([]);
    expect(ctx.isOpen).toBe(false);
    // Nothing closed or remounted: both webviews stay live, the bot's tab still in c2's scope.
    expect(ctx.liveBrowserTabs.map((tab) => tab.id).toSorted()).toEqual([blank, botTab].toSorted());
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(storedScope('/ws/c2').tabs.map((tab: { id: string }) => tab.id)).toEqual([botTab]);
  });

  it("restores the chat's other preview tabs as today", () => {
    mount();
    enterScope('/ws/c1', { ...BOT_CHAT, conversationId: 'c1', newestOfBot: true });
    act(() => ctx.openPreview('# doc', 'markdown', { title: 'Doc' }));
    enterScope('/ws/c2', { ...BOT_CHAT, conversationId: 'c2', newestOfBot: true });

    enterScope('/ws/c1', { ...BOT_CHAT, conversationId: 'c1', newestOfBot: false });

    expect(ctx.tabs.map((tab) => tab.content_type)).toEqual(['markdown']);
    expect(ctx.activeTabId).toBe(ctx.tabs[0].id);
    expect(ctx.isOpen).toBe(true);
  });

  it("brings the bot's tabs in, opens the pane and shows the agent's tab once the relay hands them over", () => {
    mount();
    const { botTab } = botTabInNewerChat();
    enterScope('/ws/c1', { ...BOT_CHAT, conversationId: 'c1', newestOfBot: false });
    expect(ctx.isOpen).toBe(false);

    handOver(botTab, 'c1');

    expect(ctx.tabs.map((tab) => tab.id)).toEqual([botTab]);
    expect(ctx.activeTabId).toBe(botTab);
    expect(ctx.isOpen).toBe(true);
    expect(ctx.liveBrowserTabs.filter((tab) => tab.id === botTab)).toHaveLength(1);
  });

  it("makes the agent's tab active over the chat's other tabs, even after the user closed the pane", () => {
    mount();
    enterScope('/ws/c1', { ...BOT_CHAT, conversationId: 'c1', newestOfBot: true });
    const botTab = openBotTab('https://example.com/cart', 'c1');
    act(() => ctx.openPreview('# doc', 'markdown', { title: 'Doc' }));
    enterScope('/ws/c2', { ...BOT_CHAT, conversationId: 'c2', newestOfBot: true });
    handOver(botTab, 'c2');
    enterScope('/ws/c1', { ...BOT_CHAT, conversationId: 'c1', newestOfBot: false });
    act(() => ctx.collapsePreview());

    handOver(botTab, 'c1');

    expect(ctx.activeTabId).toBe(botTab);
    expect(ctx.isOpen).toBe(true);
  });

  it('brings a tab this chat still owns once its agent acts on it', () => {
    mount();
    enterScope('/ws/c1', { ...BOT_CHAT, conversationId: 'c1', newestOfBot: true });
    const botTab = openBotTab('https://example.com/cart', 'c1');
    enterScope('/ws/c2', { ...BOT_CHAT, conversationId: 'c2', newestOfBot: true }); // c2's agent never used it
    enterScope('/ws/c1', { ...BOT_CHAT, conversationId: 'c1', newestOfBot: false });
    expect(ctx.tabs).toEqual([]);

    act(() => ctx.takeAgentTab(botTab));

    expect(ctx.tabs.map((tab) => tab.id)).toEqual([botTab]);
    expect(ctx.activeTabId).toBe(botTab);
    expect(ctx.isOpen).toBe(true);
  });

  it("does not take a tab another chat's agent acts on", () => {
    mount();
    const { botTab } = botTabInNewerChat();
    enterScope('/ws/c1', { ...BOT_CHAT, conversationId: 'c1', newestOfBot: false });

    act(() => ctx.takeAgentTab(botTab));

    expect(ctx.tabs).toEqual([]);
    expect(ctx.isOpen).toBe(false);
  });

  it("does not take this chat's tabs when another chat's agent acts on its own tab", () => {
    mount();
    enterScope('/ws/c1', { ...BOT_CHAT, conversationId: 'c1', newestOfBot: true });
    const mine = openBotTab('https://example.com/mine', 'c1');
    enterScope('/ws/c2', { ...BOT_CHAT, conversationId: 'c2', newestOfBot: true }); // c2's agent never used it
    const theirs = openBotTab('https://example.com/theirs', 'c2');
    enterScope('/ws/c1', { ...BOT_CHAT, conversationId: 'c1', newestOfBot: false });

    act(() => ctx.takeAgentTab(theirs));

    expect(ctx.tabs).toEqual([]);
    expect(ctx.isOpen).toBe(false);
    act(() => ctx.takeAgentTab(mine));
    expect(ctx.tabs.map((tab) => tab.id)).toEqual([mine]);
  });

  it('keeps the browser tabs it holds back in its stored state, live or not', () => {
    const storedIds = (scope: string) => storedScope(scope).tabs.map((tab: { id: string }) => tab.id);
    mount();
    enterScope('/ws/c1', { ...BOT_CHAT, conversationId: 'c1', newestOfBot: true });
    const blank = ctx.tabs[0].id;
    act(() => ctx.openBrowserTab('https://example.com/mine', BOT)); // the user's own tab in the bot's profile
    const userTab = String(ctx.activeTabId);
    enterScope('/ws/c2', { ...BOT_CHAT, conversationId: 'c2', newestOfBot: true });

    // Live, parked: the stored copies stay.
    enterScope('/ws/c1', { ...BOT_CHAT, conversationId: 'c1', newestOfBot: false });
    act(() => ctx.openPreview('# doc', 'markdown', { title: 'Doc' }));
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(storedIds('/ws/c1')).toEqual(expect.arrayContaining([blank, userTab]));
    expect(storedIds('/ws/c1')).toHaveLength(3);
    enterScope('/ws/c2', { ...BOT_CHAT, conversationId: 'c2', newestOfBot: true });
    expect(storedIds('/ws/c1')).toEqual(expect.arrayContaining([blank, userTab]));

    // Not live (after a restart): still stored, and restored once the chat is the bot's newest again.
    cleanup();
    mount();
    enterScope('/ws/c1', { ...BOT_CHAT, conversationId: 'c1', newestOfBot: false });
    expect(ctx.tabs.map((tab) => tab.content_type)).toEqual(['markdown']);
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(storedIds('/ws/c1')).toHaveLength(3);
    enterScope('/ws/x', { conversationId: 'x' });
    enterScope('/ws/c1', { ...BOT_CHAT, conversationId: 'c1', newestOfBot: true });
    expect(ctx.tabs.map((tab) => tab.id)).toEqual(expect.arrayContaining([blank, userTab]));
  });

  it("the bot's newest chat still takes all of the bot's tabs at once", () => {
    mount();
    enterScope('/ws/c1', { ...BOT_CHAT, conversationId: 'c1', newestOfBot: true });
    const first = openBotTab('https://example.com/a', 'c1');
    enterScope('/ws/c0', { ...BOT_CHAT, conversationId: 'c0', newestOfBot: false });
    const second = openBotTab('https://example.com/b', 'c0');

    enterScope('/ws/c3', { ...BOT_CHAT, conversationId: 'c3', newestOfBot: true });

    expect(ctx.tabs.map((tab) => tab.id).toSorted()).toEqual([first, second].toSorted());
    expect(ctx.isOpen).toBe(true);
  });

  it('leaves a regular chat as today: its browser tabs come back, and a new one opens blank', () => {
    mount();
    enterScope('/ws/r1', { ...OPEN_BROWSER, conversationId: 'r1' });
    const blank = ctx.tabs[0].id;
    enterScope('/ws/r2', { ...OPEN_BROWSER, conversationId: 'r2' });
    expect(ctx.tabs.map((tab) => tab.content)).toEqual([BROWSER_BLANK_URL]);

    enterScope('/ws/r1', { ...OPEN_BROWSER, conversationId: 'r1' });

    expect(ctx.tabs.map((tab) => tab.id)).toEqual([blank]);
    expect(ctx.isOpen).toBe(true);
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

  it('never holds back the default Agent while its id loads: no chat is a bot before the id is known', async () => {
    configService.reset();
    getConversationOrNull.mockResolvedValue({
      ...conv('p1'),
      assistant: { id: 'adopted-agent', source: 'user', name: 'Agent', avatar: '', backend: 'claude' },
    } as TChatConversation);
    renderRoute();

    await waitFor(() => expect(scopeEntered).toHaveBeenCalledTimes(1));
    expect(scopeEntered).toHaveBeenLastCalledWith('p1', {
      openBrowserIfEmpty: true,
      carryFromScope: undefined,
      conversationId: 'c1',
    });
    act(() => configService.setLocal('agent.builtinDefaultId', 'adopted-agent'));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(scopeEntered).toHaveBeenCalledTimes(1);
  });

  it('counts a chat as older until the conversation list loads, then lets the newest one take its tabs', async () => {
    const bot = { id: 'bot-b', source: 'user', name: 'B', avatar: '', backend: 'claude' };
    setConversationListForTest([], false);
    getConversationOrNull.mockResolvedValue({ ...conv('p1'), assistant: bot, created_at: 100 } as TChatConversation);
    renderRoute();

    await waitFor(() => expect(scopeEntered).toHaveBeenCalledTimes(1));
    expect(scopeEntered).toHaveBeenLastCalledWith('p1', expect.objectContaining({ newestOfBot: false }));

    act(() =>
      setConversationListForTest([{ id: 'c0', assistant: bot, created_at: 50 }] as unknown as TChatConversation[])
    );

    await waitFor(() => expect(scopeEntered).toHaveBeenCalledTimes(2));
    expect(scopeEntered).toHaveBeenLastCalledWith('p1', expect.objectContaining({ newestOfBot: true }));
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

  it("names the chat's bot so the pane can show the bot's tabs", async () => {
    getConversationOrNull.mockResolvedValue({
      ...conv('p1'),
      assistant: { id: 'bot-b', source: 'user', name: 'B', avatar: '', backend: 'claude' },
    } as TChatConversation);
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ChatConversationIndex />
      </SWRConfig>
    );

    await waitFor(() => expect(scopeEntered).toHaveBeenCalledTimes(1));
    expect(scopeEntered).toHaveBeenLastCalledWith('p1', {
      openBrowserIfEmpty: true,
      carryFromScope: undefined,
      conversationId: 'c1',
      agentId: 'bot-b',
      newestOfBot: true,
    });
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

  it('tells the pane when a newer chat of the same bot exists, so this one shows only the tabs it owns', async () => {
    const bot = { id: 'bot-b', source: 'user', name: 'B', avatar: '', backend: 'claude' };
    setConversationListForTest([
      { id: 'c0', assistant: bot, created_at: 50 },
      { id: 'c9', assistant: bot, created_at: 900 },
      { id: 'x', assistant: { ...bot, id: 'bot-x' }, created_at: 999 },
    ] as unknown as TChatConversation[]);
    getConversationOrNull.mockResolvedValue({ ...conv('p1'), assistant: bot, created_at: 100 } as TChatConversation);
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ChatConversationIndex />
      </SWRConfig>
    );

    await waitFor(() => expect(scopeEntered).toHaveBeenCalledTimes(1));
    expect(scopeEntered).toHaveBeenLastCalledWith('p1', expect.objectContaining({ newestOfBot: false }));
    setConversationListForTest([]);
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
