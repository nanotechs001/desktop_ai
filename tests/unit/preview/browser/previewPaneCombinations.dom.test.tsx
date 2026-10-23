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
  /** The VA Bot each chat runs as. */
  bots: {} as Record<string, string>,
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
  getConversationOrNull: async (id: string) =>
    h.scopes[id] || h.bots[id]
      ? {
          id,
          project_id: h.scopes[id] ?? `/s/${id}`,
          extra: {},
          ...(h.bots[id] ? { assistant: { id: h.bots[id], source: 'user' } } : {}),
        }
      : null,
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
import { configService } from '@/common/config/configService';
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
/** A chat of bot B: all of the bot's chats share its one browser scope. */
const botChat = (conversationId: string) => ({ ...OPEN, conversationId }) as const;
const BOT_SCOPE = 'bot:bot-b';
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

let testClock = 0;

beforeEach(() => {
  localStorage.clear();
  resetCurrentConversationForTest();
  h.scopes = {};
  h.bots = {};
  configService.setLocal('agent.builtinDefaultId', 'aion-default-agent');
  vi.useFakeTimers();
  // Past any pane input an earlier test noted: each test starts later than every earlier one, on a clock of its own.
  testClock = Math.max(testClock, Date.now()) + 10 * USER_INPUT_GRACE_MS;
  vi.setSystemTime(testClock);
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

describe('the chat under an agent that opens the pane', () => {
  it("stays visible when an agent's tab opens the pane", async () => {
    h.scopes.c1 = '/s/c1';
    h.bots.c1 = 'bot-b';
    mount();
    act(() => ctx.setVaBotMode(true));
    enter(BOT_SCOPE, { conversationId: 'c2' }); // no tab yet, so no pane
    expect(ctx.isOpen).toBe(false);

    await requestTab({ url: 'https://agent.test/', background: false, conversationId: 'c1', profile: BOT });

    expect(ctx.isOpen).toBe(true);
    expect(ctx.isVaChatCollapsed).toBe(false);
  });

  // A chatbot (a VA bot with its floating robot) is talked to on the desktop: its chat starts closed in the main window.
  it('starts a chatbot chat closed under its browser', () => {
    mount();
    act(() => ctx.setVaBotMode(true, false));
    enter(BOT_SCOPE, botChat('c1'));
    expect(ctx.isOpen).toBe(true);
    expect(ctx.isVaChatCollapsed).toBe(true);
  });

  // Clicking a bot opened its browser but folded its chat away; the chat now stays open and folds only on request.
  it('keeps the chat open when the user enters a bot chat with its browser', () => {
    mount();
    act(() => ctx.setVaBotMode(true));
    enter(BOT_SCOPE, botChat('c1'));
    expect(ctx.isOpen).toBe(true);
    expect(ctx.isVaChatCollapsed).toBe(false);
  });
});

// The tab bar's + opens a tab for the browser on screen: a bot's view gets that bot's profile, any other view the
// default Agent's (no Personal tabs, no profile menu). The titlebar names the bot whose browser is on screen.
describe('the browser on screen belongs to a bot or the Agent', () => {
  it('names the bot whose view is on screen, and none outside bot views', () => {
    mount();
    enter(BOT_SCOPE, botChat('c1'));
    expect(ctx.activeBotId).toBe('bot-b');
    enter('/s/other', { conversationId: 'c9' });
    expect(ctx.activeBotId).toBeNull();
  });

  it("opens + tabs in the viewed bot's profile, else in the default Agent's", () => {
    mount();
    enter(BOT_SCOPE, botChat('c1'));
    act(() => ctx.openNewBrowserTab());
    expect(ctx.activeTab?.metadata?.profile).toEqual(BOT);
    enter('/s/other', { conversationId: 'c9' });
    act(() => ctx.openNewBrowserTab());
    expect(ctx.activeTab?.metadata?.profile).toEqual({ kind: 'agent', agentId: 'aion-default-agent' });
  });
});

// Personal is gone: a tab opened without a profile (a link from chat, a reveal) takes the view's, and Personal tabs
// saved before are dropped when their view loads.
describe('no Personal tabs', () => {
  it("opens a tab given no profile in the view's bot profile, else the default Agent's", () => {
    mount();
    enter(BOT_SCOPE, botChat('c1'));
    act(() => ctx.openBrowserTab('https://link.test/'));
    expect(ctx.activeTab?.metadata?.profile).toEqual(BOT);
    enter('/s/other', { conversationId: 'c9' });
    act(() => ctx.openBrowserTab('https://link.test/'));
    expect(ctx.activeTab?.metadata?.profile).toEqual({ kind: 'agent', agentId: 'aion-default-agent' });
  });

  it('drops a saved Personal tab when its view loads, and keeps the others', () => {
    const saved = (id: string, profile?: object) => ({
      id,
      title: id,
      content: `https://${id}.test/`,
      content_type: 'browser',
      ...(profile ? { metadata: { profile } } : {}),
    });
    localStorage.setItem(
      previewScopeStorageKey('/s/saved'),
      JSON.stringify({
        isOpen: true,
        activeTabId: 'browser-1-personal',
        tabs: [saved('browser-1-personal'), saved('browser-2-bot', BOT)],
      })
    );
    mount();
    enter('/s/saved', { ...OPEN, conversationId: 'c7' });
    expect(ctx.tabs.map((tab) => tab.id)).toEqual(['browser-2-bot']);
    expect(ctx.activeTabId).toBe('browser-2-bot');
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

describe('the bot scope takes over a live tab of the scope on screen', () => {
  it("when an agent's tab first opens in the bot scope: the live tab leaves the screen and its old scope's storage", async () => {
    h.bots.c1 = 'bot-b';
    localStorage.setItem(
      previewScopeStorageKey('/s/p'),
      JSON.stringify({
        isOpen: true,
        activeTabId: 'browser-1-live',
        tabs: [
          {
            id: 'browser-1-live',
            title: 'x',
            content: 'https://live.test/',
            content_type: 'browser',
            metadata: { profile: BOT },
          },
        ],
      })
    );
    mount();
    enter('/s/p', { ...OPEN, conversationId: 'r' });
    const live = ctx.liveBrowserTabs.find((tab) => tab.id === 'browser-1-live');

    await requestTab({ url: 'https://agent.test/', background: false, conversationId: 'c1', profile: BOT });
    flushPersist();

    expect(browserTabs().map((tab) => tab.id)).not.toContain('browser-1-live');
    expect(storedIds('/s/p')).not.toContain('browser-1-live');
    expect(ctx.liveBrowserTabs.filter((tab) => tab.id === 'browser-1-live')).toEqual([live]);
    enter(BOT_SCOPE, botChat('c1'));
    expect(browserTabs().map((tab) => tab.content)).toEqual(['https://live.test/', 'https://agent.test/']);
  });
});

describe("an agent's tab waits for the settings before it picks a scope", () => {
  it('opens in the chat of an adopted default Agent, not in a bot scope, once the default id loads', async () => {
    let loaded: () => void = () => {};
    configService.reset(); // the settings (and so the default id) have not loaded yet
    const settings = vi.spyOn(configService, 'whenReady').mockReturnValue(
      new Promise<void>((resolve) => {
        loaded = resolve;
      })
    );
    h.scopes.c1 = '/s/c1';
    h.bots.c1 = 'adopted';
    mount();
    enter('/s/c1', { ...OPEN, conversationId: 'c1' });

    await act(async () => {
      for (const handler of h.openTab) handler({ url: 'https://agent.test/', background: false, conversationId: 'c1' });
      // The chat lookup answers while the settings still load; they bring the default id only after.
      for (let i = 0; i < 5; i++) await Promise.resolve();
      configService.setLocal('agent.builtinDefaultId', 'adopted');
      loaded();
    });

    expect(browserTabs().map((tab) => tab.content)).toContain('https://agent.test/');
    settings.mockRestore();
    configService.reset();
  });
});

describe("a Watch on a bot chat shows the bot's browser", () => {
  it("opens a tab in the bot's profile, not a Personal one, for the chat on screen with no tab", () => {
    mount();
    enter(BOT_SCOPE, { conversationId: 'c1' });
    expect(browserTabs()).toEqual([]);

    act(() => ctx.revealBrowserFor('c1'));

    expect(browserTabs().map((tab) => tab.metadata?.profile)).toEqual([BOT]);
    expect(ctx.isOpen).toBe(true);
  });
});

/**
 * Whichever chat of the bot the user continues, its agent works in the bot's one browser: a tab it opens joins the
 * shared set, on screen when any chat of the bot is, and the pane follows it.
 */
describe("an agent of any chat of the bot opens its tab in the bot's shared browser", () => {
  it('on screen while another chat of the bot is on screen, and the pane follows it', async () => {
    h.bots.c1 = 'bot-b';
    mount();
    enter(BOT_SCOPE, botChat('c2'));
    const shared = browserTabs().map((tab) => tab.id);

    await requestTab({ url: 'https://agent.test/', background: false, conversationId: 'c1', profile: BOT });

    expect(browserTabs().map((tab) => tab.id)).toEqual([...shared, expect.any(String)]);
    expect(ctx.activeTab?.content).toBe('https://agent.test/');
    expect(ctx.isOpen).toBe(true);
  });

  it("in the bot's browser while a regular chat is on screen, shown with the bot's other tabs next time", async () => {
    h.bots.c1 = 'bot-b';
    h.scopes.r1 = '/s/r1';
    mount();
    enter(BOT_SCOPE, botChat('c2'));
    const shared = browserTabs().map((tab) => tab.id);
    enter('/s/r1', { ...OPEN, conversationId: 'r1' });
    const regular = browserTabs().map((tab) => tab.id);

    await requestTab({ url: 'https://agent.test/', background: false, conversationId: 'c1', profile: BOT });
    expect(browserTabs().map((tab) => tab.id)).toEqual(regular);

    enter(BOT_SCOPE, botChat('c1'));
    expect(browserTabs().map((tab) => tab.content)).toEqual([
      ...shared.map(() => BROWSER_BLANK_URL),
      'https://agent.test/',
    ]);
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

  // The bot icon is per tab now (BrowserViewer reports the tab the bot acts in): a browser tool call in the chat's
  // stream lit all of that chat's tabs, and only for engines that report tool groups.
  it("no longer lights a chat's tabs from its browser tool calls", () => {
    mount();
    enter(BOT_SCOPE, botChat('c1'));
    openBotTab('https://example.com/own', 'c1');

    emit(browserCall('c1', 'Executing'));
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
