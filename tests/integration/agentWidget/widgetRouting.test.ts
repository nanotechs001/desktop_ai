/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => false }));

import { getWidgetConversationId } from '@renderer/pages/agentWidget/chatLocation';
import { takeSendBoxDraftText } from '@renderer/hooks/chat/useSendBoxDraft';
import { isVaBotAgent } from '@/common/types/agent/defaultAgent';
import { clampBottomPaneHeight, MIN_SPLIT_PANE_PX } from '@renderer/pages/conversation/hooks/useVerticalSplit';

describe('widget window routing', () => {
  it('a widget window is bound to exactly the conversation in its hash', () => {
    expect(getWidgetConversationId('#/widget/abc-123')).toBe('abc-123');
    expect(getWidgetConversationId('#/widget/a%20b?x=1')).toBe('a b');
    expect(getWidgetConversationId('#/widget/')).toBeNull();
    expect(getWidgetConversationId('#/conversation/abc-123')).toBeNull();
    expect(getWidgetConversationId('')).toBeNull();
  });

  it('taking a draft that does not exist hands over nothing', () => {
    expect(takeSendBoxDraftText('no-such-conversation')).toBe('');
  });
});

describe('VA Bot vs regular chat', () => {
  it('only user-created Agents are VA Bots', () => {
    expect(isVaBotAgent({ id: 'bare:sales', source: 'user' }, undefined)).toBe(true);
    expect(isVaBotAgent({ id: 'aion-default-agent', source: 'user' }, undefined)).toBe(false);
    expect(isVaBotAgent({ id: 'bare:adopted', source: 'user' }, 'bare:adopted')).toBe(false);
    expect(isVaBotAgent({ id: 'preset-writer', source: 'builtin' }, undefined)).toBe(false);
    expect(isVaBotAgent(undefined, undefined)).toBe(false);
  });
});

describe('VA Bot chat divider', () => {
  it('limits the chat height only by the window, keeping both panes visible', () => {
    expect(clampBottomPaneHeight(5000, 1000)).toBe(1000 - MIN_SPLIT_PANE_PX);
    expect(clampBottomPaneHeight(10, 1000)).toBe(MIN_SPLIT_PANE_PX);
    expect(clampBottomPaneHeight(600, 1000)).toBe(600);
    expect(clampBottomPaneHeight(600, 100)).toBe(50);
  });
});
