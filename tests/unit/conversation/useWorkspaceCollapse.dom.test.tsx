/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { useWorkspaceCollapse } from '@/renderer/pages/conversation/hooks/useWorkspaceCollapse';
import {
  dispatchWorkspaceHasFilesEvent,
  dispatchWorkspaceToggleEvent,
} from '@/renderer/utils/workspace/workspaceEvents';

const PREFERENCE_KEY = 'workspace-preference-chat-1';

const renderCollapse = () =>
  renderHook(() =>
    useWorkspaceCollapse({
      workspaceEnabled: true,
      isMobile: false,
      conversation_id: 'chat-1',
      preferenceKey: 'chat-1',
    })
  );

beforeEach(() => localStorage.clear());

describe('useWorkspaceCollapse', () => {
  it('stays collapsed when files appear and no preference is stored', () => {
    const { result } = renderCollapse();

    act(() => dispatchWorkspaceHasFilesEvent(true, 'chat-1', false));
    act(() => dispatchWorkspaceHasFilesEvent(true, 'chat-1', true));

    expect(result.current.rightSiderCollapsed).toBe(true);
  });

  it('can still be toggled open and the choice persists', () => {
    const { result } = renderCollapse();

    act(() => {
      dispatchWorkspaceToggleEvent();
    });

    expect(result.current.rightSiderCollapsed).toBe(false);
    expect(localStorage.getItem(PREFERENCE_KEY)).toBe('expanded');
  });

  it('a stored expanded preference still wins when files appear', () => {
    localStorage.setItem(PREFERENCE_KEY, 'expanded');
    const { result } = renderCollapse();

    act(() => dispatchWorkspaceHasFilesEvent(true, 'chat-1', false));

    expect(result.current.rightSiderCollapsed).toBe(false);
  });
});
