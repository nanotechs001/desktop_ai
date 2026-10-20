/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AGENT_TAB_IDLE_MS,
  MAX_AGENT_TABS_PER_CHAT,
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
const closeTab = vi.fn();

/** A tab an agent of `chat` opened at the current (fake) time. */
const agentTab = (id: number, chat = 'conv-1'): FakeContents => {
  const contents = new FakeContents(id);
  registry.track(contents);
  registry.claim(id, { clientId: `client-${chat}`, label: 'claude', conversationId: chat });
  hygiene.adopt(id);
  return contents;
};

beforeEach(() => {
  vi.useFakeTimers();
  registry = createTargetRegistry();
  shown = null;
  streamed = new Set();
  confirming = new Set();
  hygiene = startTabHygiene({
    registry,
    closeTab,
    shownTab: () => shown,
    isStreamed: (id) => streamed.has(id),
    isConfirming: (id) => confirming.has(id),
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
  it('closes an agent tab after 15 minutes without use, not before', () => {
    agentTab(1);
    vi.advanceTimersByTime(AGENT_TAB_IDLE_MS - MINUTE);
    expect(closeTab).not.toHaveBeenCalled();

    vi.advanceTimersByTime(MINUTE);

    expect(closeTab.mock.calls).toEqual([[1]]);
  });

  it('keeps a tab the agent used at 14 minutes, and one the user clicked in', () => {
    agentTab(1);
    agentTab(2);
    vi.advanceTimersByTime(14 * MINUTE);
    registry.touch(1, 'conv-1'); // an agent command
    registry.touch(2); // user input

    vi.advanceTimersByTime(2 * MINUTE);
    expect(closeTab).not.toHaveBeenCalled();

    vi.advanceTimersByTime(13 * MINUTE);
    expect(closeTab.mock.calls).toEqual([[1], [2]]);
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
    expect(closeTab).not.toHaveBeenCalled();
    vi.advanceTimersByTime(AGENT_TAB_IDLE_MS);

    expect(closeTab.mock.calls).toEqual([[4]]);
  });

  it('asks again after 10 s when the pane never closed the tab', () => {
    agentTab(1);
    vi.advanceTimersByTime(AGENT_TAB_IDLE_MS);
    expect(closeTab.mock.calls).toEqual([[1]]);

    vi.advanceTimersByTime(MINUTE);

    expect(closeTab.mock.calls).toEqual([[1], [1]]);
  });
});
