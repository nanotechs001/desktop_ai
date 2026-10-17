/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SWRConfig } from 'swr';
import NoteSavedChip from '@/renderer/pages/conversation/Messages/acp/NoteSavedChip';
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

const renderChip = (conversationId?: string) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <NoteSavedChip text='remember this' source='chat' conversationId={conversationId} />
    </SWRConfig>
  );

describe('NoteSavedChip', () => {
  beforeEach(() => {
    navigateMock.mockReset();
    getConversationOrNullMock.mockReset();
  });

  it("opens the chat's Agent notebook", async () => {
    getConversationOrNullMock.mockResolvedValue({ id: 'c1', assistant: { id: 'writer' } });
    renderChip('c1');

    const open = await screen.findByText('messages.noteChip.open');
    await vi.waitFor(() => expect(open.closest('button')).not.toBeDisabled());
    fireEvent.click(open);

    expect(navigateMock).toHaveBeenCalledWith('/assistants', {
      state: { openAssistantEditor: true, openAssistantId: 'writer' },
    });
  });

  it('opens the default Agent notebook for a chat without an Agent', async () => {
    getConversationOrNullMock.mockResolvedValue({ id: 'c1' });
    renderChip('c1');

    const open = await screen.findByText('messages.noteChip.open');
    await vi.waitFor(() => expect(open.closest('button')).not.toBeDisabled());
    fireEvent.click(open);

    expect(navigateMock).toHaveBeenCalledWith('/assistants', {
      state: { openAssistantEditor: true, openAssistantId: DEFAULT_AGENT_ID },
    });
  });

  it("hides 'Open notebook' when the chat is gone, so its Agent cannot be resolved", async () => {
    getConversationOrNullMock.mockResolvedValue(null);
    renderChip('gone');

    await vi.waitFor(() => expect(getConversationOrNullMock).toHaveBeenCalledWith('gone'));
    await screen.findByText('remember this');
    await vi.waitFor(() => expect(screen.queryByText('messages.noteChip.open')).not.toBeInTheDocument());
    expect(screen.getByText('messages.noteChip.title')).toBeInTheDocument();
  });
});
