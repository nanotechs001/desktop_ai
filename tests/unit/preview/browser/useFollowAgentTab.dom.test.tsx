/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The pane follows the agent: an agent action on one of this chat's tabs brings that tab to the front, unless the user
 * clicked or typed in the pane in the last 3 s.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  USER_INPUT_GRACE_MS,
  useFollowAgentTab,
} from '@/renderer/pages/conversation/Preview/browser/useFollowAgentTab';

const TABS = [{ id: 'a' }, { id: 'b' }];

const setUp = (activeTabId = 'a') => {
  const switchTab = vi.fn();
  const { result } = renderHook(() => useFollowAgentTab({ tabs: TABS, activeTabId, switchTab }));
  return { follow: result.current.onAgentAction, userInput: result.current.onUserInput, switchTab };
};

/** A click inside the preview panel, the way the user's input reaches the host page. */
const clickInPane = (): void => {
  const panel = document.createElement('div');
  panel.className = 'preview-panel';
  const button = document.createElement('span');
  panel.appendChild(button);
  document.body.appendChild(panel);
  button.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));
  panel.remove();
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('useFollowAgentTab', () => {
  it('switches to tab B when the agent acts on it while A is active', () => {
    const { follow, switchTab } = setUp('a');
    act(() => follow('b'));
    expect(switchTab).toHaveBeenCalledWith('b');
  });

  it('does nothing for the tab already on screen', () => {
    const { follow, switchTab } = setUp('b');
    act(() => follow('b'));
    expect(switchTab).not.toHaveBeenCalled();
  });

  it('does not switch within 3 s of the user clicking in the pane, and does after', () => {
    const { follow, switchTab } = setUp('a');
    clickInPane();

    vi.advanceTimersByTime(USER_INPUT_GRACE_MS - 1);
    act(() => follow('b'));
    expect(switchTab).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    act(() => follow('b'));
    expect(switchTab).toHaveBeenCalledWith('b');
  });

  it('does not count typing outside the pane (the chat)', () => {
    const { follow, switchTab } = setUp('a');
    document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true }));
    act(() => follow('b'));
    expect(switchTab).toHaveBeenCalledWith('b');
  });

  it('does not switch to tab B within 3 s of the user typing in the page of tab A', () => {
    const { follow, userInput, switchTab } = setUp('a');
    act(() => userInput('a'));

    vi.advanceTimersByTime(USER_INPUT_GRACE_MS - 1);
    act(() => follow('b'));
    expect(switchTab).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1);
    act(() => follow('b'));
    expect(switchTab).toHaveBeenCalledWith('b');
  });

  it("does not count input in another chat's tab", () => {
    const { follow, userInput, switchTab } = setUp('a');
    act(() => userInput('other-chat-tab'));
    act(() => follow('b'));
    expect(switchTab).toHaveBeenCalledWith('b');
  });

  it("leaves another chat's tab alone (not in this pane)", () => {
    const { follow, switchTab } = setUp('a');
    act(() => follow('other-chat-tab'));
    expect(switchTab).not.toHaveBeenCalled();
  });
});
