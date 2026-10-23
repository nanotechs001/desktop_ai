/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SWRConfig } from 'swr';
import MemorySavedChip from '@/renderer/pages/conversation/Messages/acp/MemorySavedChip';
import type { MemoryChipData } from '@/common/chat/artifactToolCall';
import { DEFAULT_AGENT_ID } from '@/common/types/agent/defaultAgent';

const navigateMock = vi.fn();
const getConversationOrNullMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('react-router-dom', () => ({
  useNavigate: () => navigateMock,
}));

vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: (id: string) => getConversationOrNullMock(id),
}));

const renderChip = (data: Partial<MemoryChipData> = {}, conversationId: string | undefined = 'c1') =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <MemorySavedChip
        kind='memory'
        action='created'
        scope='own'
        title='Client launch date'
        {...data}
        conversationId={conversationId}
      />
    </SWRConfig>
  );

describe('MemorySavedChip', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    getConversationOrNullMock.mockReset();
    getConversationOrNullMock.mockResolvedValue({ id: 'c1', assistant: { id: 'writer' } });
  });

  it.each([
    ['created', 'messages.memoryChip.created'],
    ['updated', 'messages.memoryChip.updated'],
    ['superseded', 'messages.memoryChip.superseded'],
  ] as const)('says what a %s save did, with the title', async (action, label) => {
    renderChip({ action });
    expect(screen.getByText(label)).toBeInTheDocument();
    expect(screen.getByText('Client launch date')).toBeInTheDocument();
    expect(screen.queryByText('messages.memoryChip.aboutYou')).not.toBeInTheDocument();
  });

  it('marks a fact about the user', () => {
    renderChip({ scope: 'shared' });
    expect(screen.getByText('messages.memoryChip.aboutYou')).toBeInTheDocument();
  });

  it("opens the chat's Agent settings", async () => {
    renderChip();
    const open = await screen.findByText('messages.memoryChip.open');
    await vi.waitFor(() => expect(open.closest('button')).not.toBeDisabled());
    fireEvent.click(open);
    expect(navigateMock).toHaveBeenCalledWith('/assistants', {
      state: { openAssistantEditor: true, openAssistantId: 'writer' },
    });
  });

  it('opens the default Agent settings for a chat without an Agent', async () => {
    getConversationOrNullMock.mockResolvedValue({ id: 'c1' });
    renderChip();
    const open = await screen.findByText('messages.memoryChip.open');
    await vi.waitFor(() => expect(open.closest('button')).not.toBeDisabled());
    fireEvent.click(open);
    expect(navigateMock).toHaveBeenCalledWith('/assistants', {
      state: { openAssistantEditor: true, openAssistantId: DEFAULT_AGENT_ID },
    });
  });

  it('hides the link when the chat is gone', async () => {
    getConversationOrNullMock.mockResolvedValue(null);
    renderChip({}, 'gone');
    await vi.waitFor(() => expect(getConversationOrNullMock).toHaveBeenCalledWith('gone'));
    await vi.waitFor(() => expect(screen.queryByText('messages.memoryChip.open')).not.toBeInTheDocument());
  });
});
