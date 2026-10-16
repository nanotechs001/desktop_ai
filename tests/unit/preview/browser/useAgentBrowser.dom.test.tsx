/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentActionEvent, TabOwnership } from '@/common/types/browser';

const mocks = vi.hoisted(() => ({
  offOwnership: vi.fn(),
  offAction: vi.fn(),
  onOwnership: vi.fn(),
  onAction: vi.fn(),
  getOwnership: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    agentBrowser: {
      ownershipChanged: { on: mocks.onOwnership },
      agentAction: { on: mocks.onAction },
      getOwnership: { invoke: mocks.getOwnership },
    },
  },
}));

import { useAgentBrowser } from '@/renderer/pages/conversation/Preview/browser/useAgentBrowser';

const ownership = (webContentsId: number): TabOwnership => ({
  webContentsId,
  owner: 'user',
  sharedWith: null,
  paused: false,
});

beforeEach(() => {
  mocks.onOwnership.mockReturnValue(mocks.offOwnership);
  mocks.onAction.mockReturnValue(mocks.offAction);
  mocks.getOwnership.mockResolvedValue({ success: true, data: [] });
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('useAgentBrowser subscriptions', () => {
  it('unsubscribes from both emitters on unmount', () => {
    const { unmount } = renderHook(() => useAgentBrowser(7));
    expect(mocks.offOwnership).not.toHaveBeenCalled();

    unmount();

    expect(mocks.offOwnership).toHaveBeenCalledTimes(1);
    expect(mocks.offAction).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes and resubscribes when the webContentsId changes', () => {
    const { rerender } = renderHook(({ id }) => useAgentBrowser(id), { initialProps: { id: 7 } });
    expect(mocks.onOwnership).toHaveBeenCalledTimes(1);

    rerender({ id: 8 });

    expect(mocks.offOwnership).toHaveBeenCalledTimes(1);
    expect(mocks.offAction).toHaveBeenCalledTimes(1);
    expect(mocks.onOwnership).toHaveBeenCalledTimes(2);
    expect(mocks.onAction).toHaveBeenCalledTimes(2);
  });

  it('does not subscribe before the webContentsId is known', () => {
    renderHook(() => useAgentBrowser(null));

    expect(mocks.onOwnership).not.toHaveBeenCalled();
    expect(mocks.onAction).not.toHaveBeenCalled();
  });

  it("drops the previous tab's feed and ownership when the id changes", async () => {
    let emitAction: ((event: AgentActionEvent) => void) | null = null;
    mocks.onAction.mockImplementation((handler: (event: AgentActionEvent) => void) => {
      emitAction = handler;
      return mocks.offAction;
    });
    mocks.getOwnership.mockResolvedValue({ success: true, data: [ownership(7)] });
    const { result, rerender } = renderHook(({ id }) => useAgentBrowser(id), { initialProps: { id: 7 } });
    await act(async () => {});
    act(() => emitAction?.({ webContentsId: 7, clientLabel: 'c', op: 'click', label: 'a', rect: null, at: 1 }));
    expect(result.current.actions).toHaveLength(1);
    expect(result.current.ownership?.webContentsId).toBe(7);

    rerender({ id: 8 });

    expect(result.current.actions).toHaveLength(0);
    expect(result.current.ownership).toBeNull();
  });
});
