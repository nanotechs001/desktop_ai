/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * A robot whose popup is closed shows a browser ask for its chat: it takes the awaiting pose while main has a
 * risky-action or "Leave site?" ask open for that chat, and drops it once the ask is settled anywhere.
 */

import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfirmRequest } from '@/common/types/browser';

const mocks = vi.hoisted(() => ({
  getConfirmRequests: vi.fn(),
  confirmHandler: null as ((open: ConfirmRequest[]) => void) | null,
  off: () => () => undefined,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      responseStream: { on: mocks.off },
      turnCompleted: { on: mocks.off },
      confirmation: { remove: { on: mocks.off } },
    },
    agentBrowser: {
      getConfirmRequests: { invoke: mocks.getConfirmRequests },
      confirmRequested: {
        on: (handler: (open: ConfirmRequest[]) => void) => {
          mocks.confirmHandler = handler;
          return () => undefined;
        },
      },
    },
  },
}));
vi.mock('@/renderer/utils/emitter', () => ({ addEventListener: mocks.off }));

import { useAgentAnimationState } from '@renderer/pages/agentWidget/useAgentAnimationState';

const ask = (id: string, conversationId?: string, kind?: ConfirmRequest['kind']): ConfirmRequest => ({
  id,
  origin: 'https://shop.test',
  frameOrigin: 'https://shop.test',
  label: 'Place order',
  clientLabel: 'claude',
  ...(conversationId ? { conversationId } : {}),
  ...(kind ? { kind } : {}),
});

beforeEach(() => {
  mocks.confirmHandler = null;
  mocks.getConfirmRequests.mockResolvedValue({ success: true, data: [] });
});

afterEach(cleanup);

describe('robot awaiting pose on a browser ask', () => {
  it("awaits while its own chat has a browser ask open, not another chat's", async () => {
    const { result } = renderHook(() => useAgentAnimationState('conv-1', false));
    await act(async () => {});
    expect(result.current.awaitingUser).toBe(false);

    act(() => mocks.confirmHandler?.([ask('a', 'conv-2'), ask('b')]));
    expect(result.current.awaitingUser).toBe(false);

    act(() => mocks.confirmHandler?.([ask('c', 'conv-1', 'leave')]));
    expect(result.current.awaitingUser).toBe(true);

    act(() => mocks.confirmHandler?.([]));
    expect(result.current.awaitingUser).toBe(false);
  });

  it('picks up an ask raised before the robot mounted', async () => {
    mocks.getConfirmRequests.mockResolvedValue({ success: true, data: [ask('a', 'conv-1')] });
    const { result } = renderHook(() => useAgentAnimationState('conv-1', false));
    await act(async () => {});
    expect(result.current.awaitingUser).toBe(true);
  });
});
