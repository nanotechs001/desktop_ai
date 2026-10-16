/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const useSWRMock = vi.fn();
const usePresetAssistantInfoMock = vi.fn();
const getConversationOrNullMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (_key: string, options?: { defaultValue?: string }) => options?.defaultValue ?? _key,
  }),
}));

vi.mock('swr', () => ({
  __esModule: true,
  default: (...args: unknown[]) => useSWRMock(...args),
}));

vi.mock('@/renderer/hooks/agent/usePresetAssistantInfo', () => ({
  usePresetAssistantInfo: (...args: unknown[]) => usePresetAssistantInfoMock(...args),
}));

vi.mock('@renderer/hooks/agent/usePresetAssistantInfo', () => ({
  usePresetAssistantInfo: (...args: unknown[]) => usePresetAssistantInfoMock(...args),
}));

vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: (...args: unknown[]) => getConversationOrNullMock(...args),
}));

import SingleChatEmptyState from '@/renderer/pages/conversation/components/SingleChatEmptyState';

const mockEngineDerivedInfo = () =>
  usePresetAssistantInfoMock.mockReturnValue({
    info: { name: 'Claude Code', logo: '/api/assets/logos/claude.svg', isEmoji: false, backend: 'claude' },
  });

describe('SingleChatEmptyState', () => {
  beforeEach(() => {
    useSWRMock.mockReset();
    usePresetAssistantInfoMock.mockReset();
    getConversationOrNullMock.mockReset();
  });

  it('renders the greeting once the conversation record is available', () => {
    useSWRMock.mockReturnValue({
      data: { id: 'conv-1', type: 'acp', name: 'Some chat title', extra: { backend: 'claude' } },
    });
    usePresetAssistantInfoMock.mockReturnValue({ info: null });

    render(<SingleChatEmptyState conversation_id='conv-1' />);

    expect(screen.getByTestId('single-chat-empty-state-greeting')).toHaveTextContent(
      'conversation.emptyState.greeting'
    );
  });

  it("shows the chat's Agent name and avatar", () => {
    useSWRMock.mockReturnValue({
      data: { id: 'conv-1', type: 'acp', name: 'Some chat title', extra: { backend: 'claude' } },
    });
    usePresetAssistantInfoMock.mockReturnValue({
      info: { name: 'Research Agent', logo: '🔬', isEmoji: true, backend: 'claude', assistantId: 'research' },
    });

    render(<SingleChatEmptyState conversation_id='conv-1' />);

    expect(screen.getByText('Research Agent')).toBeInTheDocument();
    expect(screen.getByText('🔬')).toBeInTheDocument();
  });

  it('shows the neutral name, never the engine name from the conversation extras', () => {
    useSWRMock.mockReturnValue({
      data: {
        id: 'conv-1',
        type: 'acp',
        name: 'Some chat title',
        extra: { agent_name: 'Claude Code', backend: 'claude' },
      },
    });
    mockEngineDerivedInfo();

    const { container } = render(<SingleChatEmptyState conversation_id='conv-1' />);

    expect(screen.getByText('agent.displayName')).toBeInTheDocument();
    expect(container.innerHTML).not.toMatch(/Claude/i);
    // The chat title is a summary of the first message, never the assistant identity.
    expect(screen.queryByText('Some chat title')).not.toBeInTheDocument();
  });

  it('shows the neutral name and robot while the Agent is still loading', () => {
    useSWRMock.mockReturnValue({
      data: { id: 'conv-1', type: 'acp', name: 'Some chat title', extra: { backend: 'claude' } },
    });
    usePresetAssistantInfoMock.mockReturnValue({ info: null, isLoading: true });

    render(<SingleChatEmptyState conversation_id='conv-1' />);

    expect(screen.getByText('agent.displayName')).toBeInTheDocument();
    expect(screen.queryByText('AI Assistant')).not.toBeInTheDocument();
  });

  it('renders nothing until the conversation record loads', () => {
    useSWRMock.mockReturnValue({ data: undefined });
    usePresetAssistantInfoMock.mockReturnValue({ info: null });

    const { container } = render(<SingleChatEmptyState conversation_id='conv-1' />);

    expect(container).toBeEmptyDOMElement();
  });
});
