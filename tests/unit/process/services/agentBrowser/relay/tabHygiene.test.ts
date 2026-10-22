/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_TAB_IDLE_MS,
  MAX_AGENT_TABS_PER_CHAT,
  MAX_BOT_TABS,
  startTabHygiene,
  type TabHygiene,
} from '@process/services/agentBrowser/relay/tabHygiene';
import { createTargetRegistry, type TargetRegistry } from '@process/services/agentBrowser/relay/targetRegistry';
import { FakeContents } from './fakes';

const MINUTE = 60_000;

let registry: TargetRegistry;
let hygiene: TabHygiene;
let shown: number | null;
let streamed: Set<number>;
let confirming: Set<number>;
let leaving: Set<number>;
let popups: Set<number>;
let runningChats: Set<string>;
const closeTab = vi.fn();

/** A tab an agent of `chat` opened at the current (fake) time. */
const agentTab = (id: number, chat = 'conv-1'): FakeContents => {
  const contents = new FakeContents(id);
  registry.track(contents);
  registry.claim(id, { clientId: `client-${chat}`, label: 'claude', conversationId: chat });
  hygiene.adopt(id);
  return contents;
};

/** The pane closes what it is asked to, as the real one does. */
const paneCloses = (tabs: FakeContents[]) =>
  closeTab.mockImplementation((id: number) => tabs.find((tab) => tab.id === id)?.destroy());

beforeEach(() => {
  vi.useFakeTimers();
  registry = createTargetRegistry();
  shown = null;
  streamed = new Set();
  confirming = new Set();
  leaving = new Set();
  popups = new Set();
  runningChats = new Set();
  hygiene = startTabHygiene({
    registry,
    closeTab,
    shownTab: () => shown,
    isStreamed: (id) => streamed.has(id),
    isConfirming: (id) => confirming.has(id),
    isLeaving: (id) => leaving.has(id),
    isPaneTab: (id) => !popups.has(id),
    isTurnRunning: async (chat) => runningChats.has(chat),
  });
});

afterEach(() => {
  hygiene.close();
  closeTab.mockReset();
  vi.useRealTimers();
});

describe('per-chat agent tab cap', () => {
  it(`keeps ${MAX_AGENT_TABS_PER_CHAT}: a 4th tab closes the least recently used one, never the new tab`, () => {
    agentTab(1);
    vi.advanceTimersByTime(1000);
    agentTab(2);
    vi.advanceTimersByTime(1000);
    agentTab(3);
    vi.advanceTimersByTime(1000);
    registry.touch(1, 'conv-1'); // the agent used tab 1 again: tab 2 is now the oldest
    expect(closeTab).not.toHaveBeenCalled();

    agentTab(4);

    expect(closeTab.mock.calls).toEqual([[2]]);
  });

  it(`a takeover of 4 tabs, adopted newest first, leaves ${MAX_AGENT_TABS_PER_CHAT}`, () => {
    // Four tabs of the bot's two older chats, oldest first.
    [1, 2, 3, 4].forEach((id) => {
      agentTab(id, id <= 2 ? 'conv-a' : 'conv-b');
      vi.advanceTimersByTime(1000);
    });
    expect(closeTab).not.toHaveBeenCalled();
    // The bot's newer chat takes them all, then the relay adopts each one, newest first.
    [4, 3, 2, 1].forEach((id) =>
      registry.claim(id, { clientId: 'client-new', label: 'claude', conversationId: 'conv-new' })
    );
    [4, 3, 2, 1].forEach((id) => hygiene.adopt(id));

    expect(closeTab.mock.calls).toEqual([[1]]);
  });

  it("never caps a bot's shared tabs per chat: a takeover of 4 closes none at once, the bot cap decides later", () => {
    [1, 2, 3, 4].forEach((id) => {
      registry.track(new FakeContents(id), { kind: 'agent', agentId: 'bot-b' });
      registry.claim(id, { clientId: 'client-new', label: 'claude', conversationId: 'conv-new' });
      hygiene.adopt(id);
    });

    expect(closeTab).not.toHaveBeenCalled();
  });

  it('counts each chat on its own', () => {
    agentTab(1, 'conv-a');
    agentTab(2, 'conv-a');
    agentTab(3, 'conv-a');
    agentTab(4, 'conv-b');
    expect(closeTab).not.toHaveBeenCalled();
  });

  it('never closes a shared, user or on-screen tab, and asks to close a tab only once', () => {
    agentTab(1);
    agentTab(2);
    agentTab(3);
    agentTab(4);
    registry.share(2, true);
    shown = 3;
    const user = new FakeContents(9);
    registry.track(user);
    hygiene.adopt(9);
    closeTab.mockClear(); // tab 1 went at the 4th; it has not closed yet

    agentTab(5);
    agentTab(6);
    expect(closeTab).not.toHaveBeenCalled(); // only 4 and 5 count when 6 comes

    agentTab(7);

    // 4, 5 and 6 are closable when 7 comes; 4 is the oldest. Tab 1's close is not asked again.
    expect(closeTab.mock.calls).toEqual([[4]]);
  });
});

describe('idle sweep', () => {
  it("closes an agent tab after 15 minutes without use, not before, but keeps its chat's last-used tab", () => {
    paneCloses([agentTab(1), agentTab(2)]); // tab 2, opened last, is the chat's last-used tab
    vi.advanceTimersByTime(AGENT_TAB_IDLE_MS - MINUTE);
    expect(closeTab).not.toHaveBeenCalled();

    vi.advanceTimersByTime(2 * MINUTE);

    expect(closeTab.mock.calls).toEqual([[1]]);
  });

  it('keeps a tab the agent used at 14 minutes, and one the user clicked in', () => {
    paneCloses([agentTab(1), agentTab(2), agentTab(3)]);
    vi.advanceTimersByTime(14 * MINUTE);
    registry.touch(1, 'conv-1'); // an agent command
    registry.touch(2); // user input: now the chat's last-used tab

    vi.advanceTimersByTime(2 * MINUTE);
    expect(closeTab.mock.calls).toEqual([[3]]);

    vi.advanceTimersByTime(13 * MINUTE);
    expect(closeTab.mock.calls).toEqual([[3], [1]]);
  });

  it("a chat's last-used tab survives 16 minutes idle while its other idle tab closes", () => {
    paneCloses([agentTab(1), agentTab(2)]);
    registry.touch(1, 'conv-1');

    vi.advanceTimersByTime(16 * MINUTE);

    expect(closeTab.mock.calls).toEqual([[2]]);
  });

  it('two chats each keep their own last-used tab', () => {
    paneCloses([agentTab(1, 'conv-1'), agentTab(2, 'conv-1'), agentTab(3, 'conv-2'), agentTab(4, 'conv-2')]);
    registry.touch(1, 'conv-1');
    registry.touch(3, 'conv-2');

    vi.advanceTimersByTime(16 * MINUTE);

    expect(closeTab.mock.calls.toSorted()).toEqual([[2], [4]]);
  });

  it('using another tab moves the protection to it', () => {
    paneCloses([agentTab(1), agentTab(2)]);
    vi.advanceTimersByTime(MINUTE);
    registry.touch(1, 'conv-1');

    vi.advanceTimersByTime(16 * MINUTE);

    expect(closeTab.mock.calls).toEqual([[2]]);
  });

  it('an explicit close of the last-used tab does not move the protection to another tab', () => {
    const tabs = [agentTab(1), agentTab(2)];
    paneCloses(tabs);
    tabs[1].destroy(); // the user or the agent closed the last-used tab

    vi.advanceTimersByTime(16 * MINUTE);

    expect(closeTab.mock.calls).toEqual([[1]]);
  });

  it('never sweeps a shared or on-screen tab, nor a user tab', () => {
    agentTab(1);
    agentTab(3);
    registry.share(1, true);
    shown = 3;
    registry.track(new FakeContents(9));
    hygiene.adopt(9);

    vi.advanceTimersByTime(AGENT_TAB_IDLE_MS + MINUTE);

    expect(closeTab).not.toHaveBeenCalled();
  });

  it('forgets a closed tab and stops on close', () => {
    const tab = agentTab(1);
    tab.destroy();
    agentTab(2);
    hygiene.close();

    vi.advanceTimersByTime(AGENT_TAB_IDLE_MS + MINUTE);

    expect(closeTab).not.toHaveBeenCalled();
  });
});

describe('tabs the user may still need', () => {
  it('never closes a tab the user typed in, one a phone watches, or one with an open risky ask', () => {
    agentTab(1);
    agentTab(2);
    agentTab(3);
    registry.noteUserKey(1);
    streamed.add(2);
    confirming.add(3);

    agentTab(4); // the cap spares 1, 2 and 3
    registry.touch(1, 'conv-1'); // so 4 is not the chat's last-used tab
    expect(closeTab).not.toHaveBeenCalled();
    vi.advanceTimersByTime(AGENT_TAB_IDLE_MS);

    expect(closeTab.mock.calls).toEqual([[4]]);
  });

  it('asks again after 10 s when the pane never closed the tab', () => {
    agentTab(1);
    agentTab(2); // the chat's last-used tab
    vi.advanceTimersByTime(AGENT_TAB_IDLE_MS);
    expect(closeTab.mock.calls).toEqual([[1]]);

    vi.advanceTimersByTime(MINUTE);

    expect(closeTab.mock.calls).toEqual([[1], [1]]);
  });
});

/**
 * A VA Bot's one browser (its profile) keeps at most 5 open tabs, user and agent tabs together: the sweep closes the
 * least recently used ones that nobody used or looked at for 15 minutes, oldest first.
 */
describe(`a bot's shared browser keeps ${MAX_BOT_TABS} tabs`, () => {
  const BOT = { kind: 'agent', agentId: 'bot-b' } as const;
  /** A tab of the bot's profile the user opened (agent tabs have their own idle rule), one second after the last. */
  const botTabs = (ids: number[], profile: Parameters<TargetRegistry['track']>[1] = BOT): FakeContents[] =>
    ids.map((id) => {
      const contents = new FakeContents(id);
      registry.track(contents, profile);
      vi.advanceTimersByTime(1000);
      return contents;
    });

  it('closes the oldest of 6 tabs idle for 16 minutes, and 5 remain', async () => {
    const tabs = botTabs([1, 2, 3, 4, 5, 6]);
    paneCloses(tabs);

    await vi.advanceTimersByTimeAsync(16 * MINUTE);

    expect(closeTab.mock.calls).toEqual([[1]]);
    expect(registry.all()).toHaveLength(5);
  });

  it("keeps a chat's last-used tab among 6 idle ones, counted, and closes the oldest other one", async () => {
    const tabs = botTabs([1, 2, 3, 4, 5, 6]);
    paneCloses(tabs);
    registry.touch(1, 'conv-a'); // the agent's last action: tab 1, used longest ago of all
    vi.advanceTimersByTime(1000);
    [2, 3, 4, 5, 6].forEach((id) => registry.touch(id));

    await vi.advanceTimersByTimeAsync(16 * MINUTE);

    expect(closeTab.mock.calls).toEqual([[2]]);
    expect(registry.all().map((t) => t.webContentsId)).toContain(1);
  });

  it('closes nothing when only protected tabs could go', async () => {
    const tabs = botTabs([1, 2, 3, 4, 5, 6, 7]);
    paneCloses(tabs);
    registry.setPinned(1, true);
    // Tabs 2 to 7 are each the last-used tab of a chat: 6 counted, over the cap, but none may go.
    [2, 3, 4, 5, 6, 7].forEach((id) => registry.touch(id, `conv-${id}`));

    await vi.advanceTimersByTimeAsync(16 * MINUTE);

    expect(closeTab).not.toHaveBeenCalled();
  });

  it('closes the oldest idle tab when only 4 of 6 are idle', async () => {
    const tabs = botTabs([1, 2, 3, 4, 5, 6]);
    paneCloses(tabs);
    vi.advanceTimersByTime(10 * MINUTE);
    registry.touch(1); // the user clicked in tabs 1 and 2: the oldest two are not idle
    registry.touch(2);

    await vi.advanceTimersByTimeAsync(6 * MINUTE);

    expect(closeTab.mock.calls).toEqual([[3]]);
  });

  it(`closes nothing at ${MAX_BOT_TABS} tabs, all idle`, async () => {
    botTabs([1, 2, 3, 4, 5]);

    await vi.advanceTimersByTimeAsync(30 * MINUTE);

    expect(closeTab).not.toHaveBeenCalled();
  });

  it('never closes the tab on screen or a tab with a pending ask', async () => {
    const tabs = botTabs([1, 2, 3, 4, 5, 6, 7]);
    paneCloses(tabs);
    shown = 1;
    confirming.add(2);

    await vi.advanceTimersByTimeAsync(16 * MINUTE);

    expect(closeTab.mock.calls).toEqual([[3], [4]]);
  });

  it('never closes a tab waiting on "Leave site?", nor one whose agent turn is running', async () => {
    const tabs = botTabs([1, 2, 3, 4, 5, 6]);
    paneCloses(tabs);
    leaving.add(1);
    registry.claim(2, { clientId: 'client-a', label: 'claude', conversationId: 'conv-a' });
    runningChats.add('conv-a');
    registry.share(2, true); // spared by the agent idle rule, so only the bot cap decides

    await vi.advanceTimersByTimeAsync(16 * MINUTE);

    expect(closeTab.mock.calls).toEqual([[3]]);
  });

  it('counts time on screen as use', async () => {
    const tabs = botTabs([1, 2, 3, 4, 5, 6]);
    paneCloses(tabs);
    shown = 1;
    vi.advanceTimersByTime(15 * MINUTE);
    shown = 2; // tab 1 was on screen until the sweep before this

    await vi.advanceTimersByTimeAsync(MINUTE);

    expect(closeTab.mock.calls).toEqual([[3]]);
  });

  it('leaves regular chats, the default Agent and popups alone', async () => {
    botTabs([1, 2, 3, 4, 5, 6], { kind: 'temporary', conversationId: 'conv-r' });
    botTabs([11, 12, 13, 14, 15, 16], { kind: 'agent', agentId: 'aion-default-agent' });
    botTabs([21, 22, 23, 24, 25, 26]);
    [21, 22].forEach((id) => popups.add(id));

    await vi.advanceTimersByTimeAsync(30 * MINUTE);

    expect(closeTab).not.toHaveBeenCalled();
  });
});

/** A tab the user pinned in the pane is never closed by any rule here, and is left out of every count. */
describe('pinned tabs', () => {
  const BOT = { kind: 'agent', agentId: 'bot-b' } as const;

  it('the idle sweep never closes a pinned agent tab', () => {
    agentTab(1);
    agentTab(2);
    agentTab(3); // the chat's last-used tab
    registry.setPinned(1, true);

    vi.advanceTimersByTime(AGENT_TAB_IDLE_MS);

    expect(closeTab.mock.calls).toEqual([[2]]);
  });

  it('the per-chat cap neither closes nor counts a pinned tab', () => {
    agentTab(1);
    registry.setPinned(1, true);
    vi.advanceTimersByTime(1000);
    agentTab(2);
    vi.advanceTimersByTime(1000);
    agentTab(3);
    vi.advanceTimersByTime(1000);
    agentTab(4); // 3 unpinned tabs and a pinned one: within the cap

    expect(closeTab).not.toHaveBeenCalled();

    agentTab(5);
    expect(closeTab.mock.calls).toEqual([[2]]);
  });

  it(`the bot cap keeps ${MAX_BOT_TABS} unpinned tabs plus any pinned ones, and never closes a pinned tab`, async () => {
    const tabs = [1, 2, 3, 4, 5, 6, 7, 8].map((id) => {
      const contents = new FakeContents(id);
      registry.track(contents, BOT);
      vi.advanceTimersByTime(1000);
      return contents;
    });
    closeTab.mockImplementation((id: number) => tabs.find((tab) => tab.id === id)?.destroy());
    [1, 2, 3].forEach((id) => registry.setPinned(id, true)); // the three oldest

    await vi.advanceTimersByTimeAsync(16 * MINUTE);

    expect(closeTab).not.toHaveBeenCalled();

    registry.setPinned(1, false);
    await vi.advanceTimersByTimeAsync(MINUTE);

    expect(closeTab.mock.calls).toEqual([[1]]);
  });
});
