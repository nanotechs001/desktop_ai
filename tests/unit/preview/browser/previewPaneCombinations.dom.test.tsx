/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The browser pane where its features meet: an agent's tabs while the user types, two bot chats in one scope, the tab
 * cap with agent tabs in it, closes nobody asked for, the activity dot of several chats, deleted chats, chat lookups
 * that fail, and previews a robot window cannot show.
 */

import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTabProfile } from '@/common/types/browser';

type OpenTabRequest = { url: string; background: boolean; conversationId?: string; profile?: BrowserTabProfile };
type StreamMessage = { type: string; data: unknown; msg_id: string; conversation_id: string };
type ListChanged = { conversation_id: string; action: 'created' | 'updated' | 'deleted' };

const h = vi.hoisted(() => ({
  openTab: [] as ((request: OpenTabRequest) => void)[],
  stream: [] as ((message: StreamMessage) => void)[],
  listChanged: [] as ((event: ListChanged) => void)[],
  refuseTab: vi.fn(async () => ({ success: true })),
  openFileInMain: vi.fn(async () => undefined),
  openPreviewInMain: vi.fn(async () => undefined),
  scopes: {} as Record<string, string>,
  subscribe:
    <T,>(list: ((event: T) => void)[]) =>
    (handler: (event: T) => void) => {
      list.push(handler);
      return () => {
        list.splice(list.indexOf(handler), 1);
      };
    },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    fileStream: { contentUpdate: { on: () => () => {} } },
    preview: { open: { on: () => () => {} } },
    browser: { openTabRequested: { on: h.subscribe(h.openTab) }, profileRemoved: { on: () => () => {} } },
    agentBrowser: { refuseTab: { invoke: h.refuseTab } },
    agentWidget: {
      openFileInMain: { invoke: h.openFileInMain },
      openPreviewInMain: { invoke: h.openPreviewInMain },
    },
    conversation: {
      responseStream: { on: h.subscribe(h.stream) },
      listChanged: { on: h.subscribe(h.listChanged) },
    },
  },
}));
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: async (id: string) => (h.scopes[id] ? { id, project_id: h.scopes[id], extra: {} } : null),
}));
vi.mock('@/renderer/pages/conversation/Preview/browser/firstUseNotice', () => ({
  maybeNotifyFirstAgentBrowserUse: vi.fn(),
}));

import { BUILTIN_BROWSER_MCP_NAME } from '@/common/config/constants';
import { BROWSER_BLANK_URL, MAX_BROWSER_TABS } from '@/renderer/pages/conversation/Preview/browser/constants';
import { USER_INPUT_GRACE_MS, notePaneInput } from '@/renderer/pages/conversation/Preview/browser/useFollowAgentTab';
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

const BOT = { kind: 'agent', agentId: 'bot-b' } as const;
const OPEN = { openBrowserIfEmpty: true } as const;

let ctx: PreviewContextValue;
const Probe: React.FC = () => {
  ctx = usePreviewContext();
  return null;
};
const mount = (readOnly = false): void => {
  render(
    <PreviewProvider readOnly={readOnly}>
      <Probe />
    </PreviewProvider>
  );
};

type EnterOptions = Parameters<PreviewContextValue['closePreviewIfScopeChanged']>[1];
const enter = (scope: string | null, options?: EnterOptions) => {
  if (options?.conversationId) setCurrentConversation(options.conversationId);
  act(() => ctx.closePreviewIfScopeChanged(scope, options));
};
const botChat = (conversationId: string, newestOfBot: boolean) =>
  ({ ...OPEN, conversationId, agentId: 'bot-b', newestOfBot }) as const;
/** A tab an agent of bot B opened on screen; the relay reports `ownerChat` as its owner. */
const openBotTab = (url: string, ownerChat: string): string => {
  act(() => ctx.openBrowserTab(url, BOT));
  const id = String(ctx.activeTabId);
  act(() => ctx.updateTab(id, { metadata: { agentOwned: true, agentConversationId: ownerChat } }));
  return id;
};
const requestTab = async (request: OpenTabRequest | OpenTabRequest[]) => {
  await act(async () => {
    for (const one of Array.isArray(request) ? request : [request]) for (const handler of h.openTab) handler(one);
  });
};
const browserTabs = () => ctx.tabs.filter((tab) => tab.content_type === 'browser');
const storedIds = (scope: string): string[] =>
  (
    (JSON.parse(localStorage.getItem(previewScopeStorageKey(scope)) ?? 'null') as { tabs: { id: string }[] } | null)
      ?.tabs ?? []
  ).map((tab) => tab.id);
const flushPersist = () =>
  act(() => {
    vi.advanceTimersByTime(200);
  });

beforeEach(() => {
  localStorage.clear();
  resetCurrentConversationForTest();
  h.scopes = {};
  vi.useFakeTimers();
  // Past any pane input an earlier test noted.
  vi.setSystemTime(Date.now() + 10 * USER_INPUT_GRACE_MS);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  h.refuseTab.mockClear();
  h.openFileInMain.mockClear();
  h.openPreviewInMain.mockClear();
  window.location.hash = '';
});

describe('an agent never switches the tab under the user', () => {
  it('a handed-over tab comes into the pane, but the tab the user works in stays on screen', () => {
    mount();
    enter('/s/c1', botChat('c1', true));
    const botTab = openBotTab('https://example.com/cart', 'c1');
    enter('/s/c2', botChat('c2', true));
    act(() => ctx.updateTab(botTab, { metadata: { agentOwned: true, agentConversationId: 'c2' } }));
    enter('/s/c1', botChat('c1', false));
    act(() => ctx.openBrowserTab('https://mine.test/'));
    const mine = String(ctx.activeTabId);

    notePaneInput();
    act(() => ctx.updateTab(botTab, { metadata: { agentOwned: true, agentConversationId: 'c1' } }));

    expect(ctx.tabs.map((tab) => tab.id)).toContain(botTab);
    expect(ctx.activeTabId).toBe(mine);
  });

  it("an agent's new tab for the chat on screen opens behind the tab the user works in, and in front after", async () => {
    h.scopes.c1 = '/s/c1';
    mount();
    enter('/s/c1', { ...OPEN, conversationId: 'c1' });
    const mine = String(ctx.activeTabId);

    notePaneInput();
    await requestTab({ url: 'https://agent.test/1', background: false, conversationId: 'c1' });
    expect(browserTabs().map((tab) => tab.content)).toContain('https://agent.test/1');
    expect(ctx.activeTabId).toBe(mine);

    vi.advanceTimersByTime(USER_INPUT_GRACE_MS);
    await requestTab({ url: 'https://agent.test/2', background: false, conversationId: 'c1' });
    expect(ctx.activeTab?.content).toBe('https://agent.test/2');
  });

  it('a page the user opens with a link still comes to the front while they click', async () => {
    mount();
    enter('/s/c1', { ...OPEN, conversationId: 'c1' });

    notePaneInput();
    await requestTab({ url: 'https://popup.test/', background: false });

    expect(ctx.activeTab?.content).toBe('https://popup.test/');
  });
});

describe('two chats of one bot in the same scope', () => {
  it("an older chat entered after the newest one parks the newest chat's browser tabs, and they come back", () => {
    mount();
    enter('/s/shared', botChat('c2', true));
    const botTab = openBotTab('https://example.com/cart', 'c2');

    enter('/s/shared', botChat('c1', false));

    expect(browserTabs()).toEqual([]);
    expect(ctx.liveBrowserTabs.map((tab) => tab.id)).toContain(botTab);
    flushPersist();
    expect(storedIds('/s/shared')).toContain(botTab);

    enter('/s/shared', botChat('c2', true));

    expect(ctx.tabs.map((tab) => tab.id)).toContain(botTab);
    expect(ctx.isOpen).toBe(true);
  });

  it('a regular chat entered in the scope gets back the browser tabs an older bot chat held there', () => {
    mount();
    enter('/s/shared', { ...OPEN, conversationId: 'r1' });
    const userTab = String(ctx.activeTabId);
    enter('/s/other', { ...OPEN, conversationId: 'x' });
    enter('/s/shared', botChat('c1', false));
    expect(browserTabs()).toEqual([]);

    enter('/s/shared', { ...OPEN, conversationId: 'r1' });

    expect(ctx.tabs.map((tab) => tab.id)).toEqual([userTab]);
    expect(ctx.isOpen).toBe(true);
  });

  it('the same older chat re-entered keeps the tab its agent took', () => {
    mount();
    enter('/s/c2', botChat('c2', true));
    const botTab = openBotTab('https://example.com/cart', 'c2');
    enter('/s/c1', botChat('c1', false));
    act(() => ctx.updateTab(botTab, { metadata: { agentOwned: true, agentConversationId: 'c1' } }));
    expect(ctx.tabs.map((tab) => tab.id)).toEqual([botTab]);

    enter('/s/c1', botChat('c1', false));

    expect(ctx.tabs.map((tab) => tab.id)).toEqual([botTab]);
  });
});

describe('the chat under an agent that opens the pane', () => {
  it('stays visible when the relay hands a tab to an older chat with no pane', () => {
    mount();
    act(() => ctx.setVaBotMode(true));
    enter('/s/c1', botChat('c1', true));
    const botTab = openBotTab('https://example.com/cart', 'c1');
    enter('/s/c2', botChat('c2', true));
    act(() => ctx.updateTab(botTab, { metadata: { agentOwned: true, agentConversationId: 'c2' } }));
    enter('/s/c1', botChat('c1', false));
    expect(ctx.isOpen).toBe(false);

    act(() => ctx.updateTab(botTab, { metadata: { agentOwned: true, agentConversationId: 'c1' } }));

    expect(ctx.isOpen).toBe(true);
    expect(ctx.isVaChatCollapsed).toBe(false);
  });

  it('starts collapsed when the user enters a bot chat with its browser', () => {
    mount();
    act(() => ctx.setVaBotMode(true));
    enter('/s/c1', botChat('c1', true));
    expect(ctx.isOpen).toBe(true);
    expect(ctx.isVaChatCollapsed).toBe(true);
  });
});

describe('the browser tab cap never takes an agent tab', () => {
  /** Fills the pane to the cap: `agentTabs` agent tabs first (the oldest), then Personal user tabs. */
  const fillToCap = (agentTabs: number, profile?: BrowserTabProfile): string[] =>
    Array.from({ length: MAX_BROWSER_TABS }, (_, i) => {
      if (i < agentTabs) return openBotTab(`https://agent.test/${i}`, 'c1');
      act(() => ctx.openBrowserTab(`https://user.test/${i}`, profile));
      return String(ctx.activeTabId);
    });

  it('reuses the oldest user tab of the same profile, not the older agent tab', () => {
    mount();
    enter('/s/c1', { conversationId: 'c1' });
    const ids = fillToCap(1);

    act(() => ctx.openBrowserTab('https://eleventh.test/'));

    expect(ctx.tabs.find((tab) => tab.id === ids[0])?.content).toBe('https://agent.test/0');
    expect(ctx.tabs.find((tab) => tab.id === ids[1])?.content).toBe('https://eleventh.test/');
    expect(ctx.browserTabLimitHitAt).not.toBeNull();
  });

  it('refuses when no user tab of that profile is left, and says so', () => {
    mount();
    enter('/s/c1', { conversationId: 'c1' });
    fillToCap(MAX_BROWSER_TABS - 1);
    const before = ctx.tabs.map((tab) => [tab.id, tab.content, tab.metadata?.profile?.kind]);

    act(() => ctx.openBrowserTab('https://eleventh.test/', BOT)); // the one user tab left is Personal

    expect(ctx.tabs.map((tab) => [tab.id, tab.content, tab.metadata?.profile?.kind])).toEqual(before);
    expect(ctx.browserTabLimitHitAt).not.toBeNull();
  });

  it('two requests one tab below the cap open one tab and refuse the other', async () => {
    mount();
    enter('/s/c1', { conversationId: 'c1' });
    for (let i = 0; i < MAX_BROWSER_TABS - 1; i++) act(() => ctx.openBrowserTab(`https://user.test/${i}`));

    await requestTab([
      { url: 'https://one.test/', background: false },
      { url: 'https://two.test/', background: false },
    ]);

    expect(browserTabs()).toHaveLength(MAX_BROWSER_TABS);
    expect(browserTabs().map((tab) => tab.content)).toContain('https://one.test/');
    expect(h.refuseTab).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://two.test/' }));
  });
});

describe('only the user closes the pane for good', () => {
  it("an agent closing the chat's last tab leaves the pane to reopen on the next entry", () => {
    mount();
    enter('/s/c1', { ...OPEN, conversationId: 'c1' });
    act(() => ctx.closeTab(String(ctx.activeTabId), { byUser: false }));
    expect(ctx.isOpen).toBe(false);
    enter('/s/other', { ...OPEN, conversationId: 'x' });

    enter('/s/c1', { ...OPEN, conversationId: 'c1' });

    expect(ctx.isOpen).toBe(true);
  });

  it("the user closing the chat's last tab keeps the pane closed", () => {
    mount();
    enter('/s/c1', { ...OPEN, conversationId: 'c1' });
    act(() => ctx.closeTab(String(ctx.activeTabId)));
    enter('/s/other', { ...OPEN, conversationId: 'x' });

    enter('/s/c1', { ...OPEN, conversationId: 'c1' });

    expect(ctx.isOpen).toBe(false);
  });
});

describe("a Watch on an older bot chat shows the bot's browser", () => {
  it("opens a tab in the bot's profile, not a Personal one, when the bot has no live tab", () => {
    mount();
    act(() => ctx.revealBrowserFor('c1'));
    enter('/s/c1', botChat('c1', false));

    expect(browserTabs()).toHaveLength(1);
    expect(browserTabs()[0].metadata?.profile).toEqual(BOT);
    expect(ctx.isOpen).toBe(true);
  });

  it('does the same for the older chat already on screen', () => {
    mount();
    enter('/s/c1', botChat('c1', false));
    expect(browserTabs()).toEqual([]);

    act(() => ctx.revealBrowserFor('c1'));

    expect(browserTabs().map((tab) => tab.metadata?.profile)).toEqual([BOT]);
  });
});

describe('the agent activity dot', () => {
  const browserCall = (conversationId: string, status: string): StreamMessage => ({
    type: 'tool_group',
    msg_id: `m-${status}`,
    conversation_id: conversationId,
    data: [{ name: `${BUILTIN_BROWSER_MCP_NAME}__click`, status }],
  });
  const emit = (message: StreamMessage) => act(() => h.stream.forEach((handler) => handler(message)));
  const dotted = () =>
    browserTabs()
      .filter((tab) => tab.metadata?.agentActive)
      .map((tab) => tab.id);

  it("marks only the on-screen chat's own agent tabs, and never for another chat", () => {
    mount();
    enter('/s/c1', botChat('c1', true));
    const blank = String(ctx.activeTabId);
    const own = openBotTab('https://example.com/own', 'c1');

    emit(browserCall('c9', 'Executing'));
    expect(dotted()).toEqual([]);

    emit(browserCall('c1', 'Executing'));
    expect(dotted()).toEqual([own]);
    expect(dotted()).not.toContain(blank);

    emit(browserCall('c1', 'Success'));
    expect(dotted()).toEqual([]);
  });
});

describe('deleting a chat', () => {
  it("closes its temporary-profile tabs on screen, in the background and in storage, and nobody else's", () => {
    const temp = (conversationId: string): BrowserTabProfile => ({ kind: 'temporary', conversationId });
    mount();
    enter('/s/t1', { conversationId: 't1' });
    act(() => ctx.openBrowserTab('https://t1.test/', temp('t1')));
    const parked = String(ctx.activeTabId);
    enter('/s/t2', { conversationId: 't2' });
    act(() => ctx.openBrowserTab('https://t1-here.test/', temp('t1')));
    act(() => ctx.openBrowserTab('https://t2.test/', temp('t2')));
    const kept = String(ctx.activeTabId);
    flushPersist();

    act(() => h.listChanged.forEach((handler) => handler({ conversation_id: 't1', action: 'deleted' })));

    expect(ctx.tabs.map((tab) => tab.id)).toEqual([kept]);
    expect(ctx.liveBrowserTabs.map((tab) => tab.id)).toEqual([kept]);
    expect(storedIds('/s/t1')).not.toContain(parked);
  });
});

describe("an agent tab whose chat can't be looked up", () => {
  it('is refused instead of opening in the chat on screen', async () => {
    mount();
    enter('/s/c1', { ...OPEN, conversationId: 'c1' });
    const before = ctx.tabs.map((tab) => tab.id);

    await requestTab({ url: 'https://lost.test/', background: false, conversationId: 'gone' });

    expect(ctx.tabs.map((tab) => tab.id)).toEqual(before);
    expect(h.refuseTab).toHaveBeenCalledWith(expect.objectContaining({ conversationId: 'gone' }));
  });

  it('still opens on screen when that chat is the one on screen (a chat with no scope)', async () => {
    mount();
    enter(null, { conversationId: 'loose' });

    await requestTab({ url: 'https://loose.test/', background: false, conversationId: 'loose' });

    expect(browserTabs().map((tab) => tab.content)).toEqual(['https://loose.test/']);
  });
});

describe('scope changes read the tabs as they are, not as last rendered', () => {
  it('a tab opened just before leaving the scope is kept in that scope', () => {
    mount();
    enter('/s/a', { conversationId: 'a' });
    act(() => {
      ctx.openBrowserTab('https://just-now.test/');
      ctx.closePreviewIfScopeChanged('/s/b', { conversationId: 'b' });
    });
    expect(ctx.liveBrowserTabs.map((tab) => tab.content)).toContain('https://just-now.test/');

    enter('/s/a', { conversationId: 'a' });

    expect(browserTabs().map((tab) => tab.content)).toEqual(['https://just-now.test/']);
  });

  it('tabs an older bot chat holds back in its workspace scope move with it to its project scope', () => {
    mount();
    enter('/ws/c1', botChat('c1', true));
    act(() => ctx.openBrowserTab('https://mine.test/', BOT));
    const userTab = String(ctx.activeTabId);
    enter('/s/x', { conversationId: 'x' });
    enter('/ws/c1', botChat('c1', false));
    expect(browserTabs()).toEqual([]);

    enter('/p/c1', { ...botChat('c1', false), carryFromScope: '/ws/c1' });
    flushPersist();
    expect(storedIds('/p/c1')).toContain(userTab);
    enter('/s/x', { conversationId: 'x' });

    enter('/p/c1', botChat('c1', true));

    expect(ctx.tabs.map((tab) => tab.id)).toContain(userTab);
    expect(ctx.liveBrowserTabs.filter((tab) => tab.id === userTab)).toHaveLength(1);
  });
});

describe('previews a robot window opens go to the main window', () => {
  it('sends a Mermaid preview and a diff, which have no file, to the main window', () => {
    window.location.hash = '#/widget/chat-a';
    mount(true);

    act(() => void ctx.openPreview('```mermaid\ngraph TD\n```', 'markdown', { title: 'Diagram', editable: false }));
    act(() => void ctx.openPreview('--- a\n+++ b\n', 'diff', { title: 'a.ts', file_name: 'a.ts', language: 'diff' }));

    expect(h.openPreviewInMain).toHaveBeenNthCalledWith(1, {
      conversation_id: 'chat-a',
      content: '```mermaid\ngraph TD\n```',
      content_type: 'markdown',
      title: 'Diagram',
    });
    expect(h.openPreviewInMain).toHaveBeenNthCalledWith(2, {
      conversation_id: 'chat-a',
      content: '--- a\n+++ b\n',
      content_type: 'diff',
      title: 'a.ts',
      file_name: 'a.ts',
      language: 'diff',
    });
    expect(h.openFileInMain).not.toHaveBeenCalled();
    expect(ctx.tabs).toEqual([]);
  });

  it('a diff of a known file is still sent as the diff, not as the file', () => {
    window.location.hash = '#/widget/chat-a';
    mount(true);

    act(() => void ctx.openPreview('@@ -1 +1 @@', 'diff', { title: 'a.ts', file_path: '/ws/a.ts' }));

    expect(h.openPreviewInMain).toHaveBeenCalledWith(expect.objectContaining({ content_type: 'diff' }));
    expect(h.openFileInMain).not.toHaveBeenCalled();
  });

  it('the main window shows that preview once the chat is on screen, instead of a blank browser tab', () => {
    mount();
    enter('/s/other', { conversationId: 'other' });
    act(() => ctx.revealPreviewFor('chat-a', { content: '# d', content_type: 'markdown', title: 'Diagram' }));

    enter('/s/a', { ...OPEN, conversationId: 'chat-a' });

    expect(ctx.tabs.map((tab) => [tab.content_type, tab.content, tab.title])).toEqual([['markdown', '# d', 'Diagram']]);
    expect(ctx.tabs.some((tab) => tab.content === BROWSER_BLANK_URL)).toBe(false);
    expect(ctx.isOpen).toBe(true);
  });
});
