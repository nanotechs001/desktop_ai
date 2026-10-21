/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * A robot window starts its own conversation-list store for Recent and History. It shares the manual-unread set with
 * the main window through storage, so it must never write back a stale copy, and it stops listening (and refetching
 * the whole list) once its last list closes.
 */

import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => {
  const subscriptions = new Set<string>();
  const subscribe = (name: string) =>
    vi.fn(() => {
      subscriptions.add(name);
      return () => subscriptions.delete(name);
    });
  return { subscriptions, subscribe, fetch: vi.fn().mockResolvedValue({ items: [] }) };
});

vi.mock('@/renderer/utils/emitter', () => ({ addEventListener: h.subscribe('chat.history.refresh') }));
vi.mock('@/common', () => ({
  ipcBridge: {
    database: { getUserConversations: { invoke: h.fetch } },
    application: { writeRendererLog: { invoke: vi.fn().mockResolvedValue(undefined) } },
    conversation: {
      listChanged: { on: h.subscribe('listChanged') },
      responseStream: { on: h.subscribe('responseStream') },
      turnCompleted: { on: h.subscribe('turnCompleted') },
      confirmation: { remove: { on: h.subscribe('confirmation.remove') } },
    },
  },
}));

import {
  reconcileGeneratingFromRuntime,
  useConversationListSync,
} from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';

const KEY = 'conversation-manual-unread-ids';
const stored = () => JSON.parse(localStorage.getItem(KEY) ?? '[]') as string[];

beforeEach(() => {
  localStorage.clear();
  window.location.hash = '#/widget/c1';
});

afterEach(() => {
  window.location.hash = '';
});

describe('the conversation list in a robot window', () => {
  it('adds its mark to what the other windows stored, never over it', () => {
    const { result, unmount } = renderHook(() => useConversationListSync());
    localStorage.setItem(KEY, JSON.stringify(['marked-in-main'])); // after this window read the set

    act(() => result.current.markManualUnread('marked-in-robot'));
    expect(stored()).toEqual(['marked-in-main', 'marked-in-robot']);

    act(() => result.current.clearManualUnread('marked-in-robot'));
    expect(stored()).toEqual(['marked-in-main']);
    unmount();
  });

  it('follows the marks another window stores', () => {
    const { result, unmount } = renderHook(() => useConversationListSync());
    const value = JSON.stringify(['marked-elsewhere']);
    localStorage.setItem(KEY, value);
    act(() => {
      window.dispatchEvent(new StorageEvent('storage', { key: KEY, newValue: value }));
    });
    expect(result.current.isManualUnread('marked-elsewhere')).toBe(true);
    unmount();
  });

  it('stops listening once its last list closes, and starts again with the next one', () => {
    const first = renderHook(() => useConversationListSync());
    const second = renderHook(() => useConversationListSync());
    expect(h.subscriptions.size).toBe(5);

    first.unmount();
    expect(h.subscriptions.size).toBe(5); // another list is still open
    second.unmount();
    expect(h.subscriptions.size).toBe(0);

    h.fetch.mockClear();
    const third = renderHook(() => useConversationListSync());
    expect(h.subscriptions.size).toBe(5);
    expect(h.fetch).toHaveBeenCalledTimes(1);
    third.unmount();
  });

  it('never shows a finished chat as generating after its list was closed', () => {
    const first = renderHook(() => useConversationListSync());
    act(() => reconcileGeneratingFromRuntime('c-busy', true));
    expect(first.result.current.isConversationGenerating('c-busy')).toBe(true);
    first.unmount(); // History closed: its turn ends while nothing listens

    act(() => reconcileGeneratingFromRuntime('c-popup', true)); // the popup's chat hydrates meanwhile
    const again = renderHook(() => useConversationListSync());
    expect(again.result.current.isConversationGenerating('c-busy')).toBe(false);
    expect(again.result.current.isConversationGenerating('c-popup')).toBe(false);
    again.unmount();
  });
});
