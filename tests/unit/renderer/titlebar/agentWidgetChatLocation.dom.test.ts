/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * A robot that moved to another conversation of its VA Bot (#/widget/<old> → #/widget/<new>) must still
 * learn when that conversation's chat moves into it; otherwise the popup spins forever.
 */

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

type LocationEvent = { conversation_id: string; location: 'main' | 'widget' };

const h = vi.hoisted(() => ({ emit: null as null | ((event: LocationEvent) => void) }));

vi.mock('@/common', () => ({
  ipcBridge: {
    agentWidget: {
      chatLocationChanged: {
        on: (fn: (event: LocationEvent) => void) => {
          h.emit = fn;
          return () => {};
        },
      },
      draftReady: { on: () => () => {} },
      getChatLocations: { invoke: () => Promise.resolve({}) },
      handoffDraft: { invoke: () => Promise.resolve() },
      takeDraft: { invoke: () => Promise.resolve('') },
    },
  },
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true }));
vi.mock('@/renderer/hooks/chat/useSendBoxDraft', () => ({
  requestConversationSendBoxPrefill: vi.fn(),
  takeSendBoxDraftText: () => '',
}));

describe('useChatLocation in a widget window', () => {
  it('follows the conversation the robot moved to', async () => {
    window.location.hash = '#/widget/first';
    const { useChatLocation } = await import('@/renderer/pages/agentWidget/chatLocation');
    renderHook(() => useChatLocation('first'));

    window.location.hash = '#/widget/second';
    const { result } = renderHook(() => useChatLocation('second'));
    act(() => h.emit?.({ conversation_id: 'second', location: 'widget' }));

    expect(result.current).toBe('widget');
  });
});
