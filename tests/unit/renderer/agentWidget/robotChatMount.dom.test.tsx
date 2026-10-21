/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The robot popup's chat mounts on the first open and again whenever the chat is back in the open popup: a switch to
 * another chat keeps the popup open, so the chat must not wait for the popup to close and reopen.
 */

import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentChatLocation } from '@/common/types/agent/agentWidget';

vi.mock('./RobotSprite', () => ({ default: () => null, preloadRobotStrips: () => {} }));

import { useChatMounted } from '@/renderer/pages/agentWidget';

describe('useChatMounted', () => {
  it('mounts the chat again after a switch that keeps the popup open', () => {
    const { result, rerender } = renderHook(
      ({ expanded, location }: { expanded: boolean; location: AgentChatLocation }) =>
        useChatMounted(expanded, location),
      { initialProps: { expanded: true, location: 'widget' as AgentChatLocation } }
    );
    expect(result.current).toBe(true);

    rerender({ expanded: true, location: 'main' }); // the old chat goes back to the main window
    expect(result.current).toBe(false);
    rerender({ expanded: true, location: 'widget' }); // the new chat arrives in the still-open popup
    expect(result.current).toBe(true);
  });

  it('waits for the first open, and unmounts when the chat goes to the main window', () => {
    const { result, rerender } = renderHook(
      ({ expanded, location }: { expanded: boolean; location: AgentChatLocation }) =>
        useChatMounted(expanded, location),
      { initialProps: { expanded: false, location: 'widget' as AgentChatLocation } }
    );
    expect(result.current).toBe(false);
    rerender({ expanded: true, location: 'widget' });
    expect(result.current).toBe(true);
    rerender({ expanded: false, location: 'widget' }); // collapsed: the chat stays mounted for a quick reopen
    expect(result.current).toBe(true);
    rerender({ expanded: false, location: 'main' });
    expect(result.current).toBe(false);
  });
});
