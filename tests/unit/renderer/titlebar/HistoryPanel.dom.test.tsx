import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { TChatConversation } from '@/common/config/storage';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();

const makeConversation = (id: string, name: string, modified_at: number, pinned = false): TChatConversation =>
  ({
    id,
    name,
    modified_at,
    created_at: modified_at,
    type: 'acp',
    extra: pinned ? { pinned: true } : {},
  }) as TChatConversation;

const chats = vi.hoisted(() => ({ value: [] as TChatConversation[] }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/common', () => ({ ipcBridge: {} }));
vi.mock('@/renderer/hooks/context/ConversationHistoryContext', async () => {
  const { buildGroupedHistory } = await import('@/renderer/pages/conversation/GroupedHistory/utils/groupingHelpers');
  return {
    useConversationHistoryContext: () => ({
      conversations: chats.value,
      groupedHistory: buildGroupedHistory(chats.value, (key: string) => key),
      isConversationGenerating: () => false,
      isConversationWaitingConfirmation: () => false,
      hasCompletionUnread: () => false,
      isManualUnread: () => false,
      markManualUnread: vi.fn(),
      clearManualUnread: vi.fn(),
    }),
  };
});
vi.mock('@/renderer/pages/cron', () => ({
  useCronJobsMap: () => ({ getJobStatus: () => 'none', markAsRead: vi.fn() }),
}));
vi.mock('@/renderer/pages/conversation/GroupedHistory/ConversationRow', () => ({
  default: ({
    conversation,
    selected,
    onConversationClick,
  }: {
    conversation: TChatConversation;
    selected: boolean;
    onConversationClick: (conversation: TChatConversation) => void;
  }) => (
    <div role='option' aria-selected={selected} onClick={() => onConversationClick(conversation)}>
      {conversation.name}
    </div>
  ),
}));

import HistoryPanel from '@/renderer/components/layout/Titlebar/HistoryPanel';

const LocationProbe: React.FC = () => <div data-testid='path'>{useLocation().pathname}</div>;

const renderPanel = (onClose = vi.fn()) => {
  chats.value = [
    makeConversation('p1', 'Pinned plan', NOW - 40 * DAY, true),
    makeConversation('t1', 'Budget review', NOW),
    makeConversation('t2', 'Trip budget', NOW - 1000),
    makeConversation('y1', 'Yesterday notes', NOW - DAY),
    makeConversation('e1', 'Old budget memo', NOW - 30 * DAY),
  ];
  render(
    <MemoryRouter initialEntries={['/guid']}>
      <HistoryPanel open onClose={onClose} />
      <LocationProbe />
    </MemoryRouter>
  );
  return onClose;
};

const optionNames = () => screen.getAllByRole('option').map((option) => option.textContent);

describe('HistoryPanel', () => {
  it('groups chats under pinned and date headings', () => {
    renderPanel();

    expect(screen.getByText('conversation.history.pinned')).toBeInTheDocument();
    expect(screen.getByText('conversation.history.today')).toBeInTheDocument();
    expect(screen.getByText('conversation.history.yesterday')).toBeInTheDocument();
    expect(screen.getByText('conversation.history.earlier')).toBeInTheDocument();
    expect(optionNames()).toEqual([
      'Pinned plan',
      'Budget review',
      'Trip budget',
      'Yesterday notes',
      'Old budget memo',
    ]);
  });

  it('filters chats by title as you type and shows an empty state', () => {
    renderPanel();
    const input = screen.getByPlaceholderText('conversation.history.searchChats');

    fireEvent.change(input, { target: { value: 'BUDGET' } });
    expect(optionNames()).toEqual(['Budget review', 'Trip budget', 'Old budget memo']);

    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.getByText('conversation.history.noMatches')).toBeInTheDocument();
  });

  it('opens the first match with Enter and closes the panel', async () => {
    const onClose = renderPanel();
    const input = screen.getByPlaceholderText('conversation.history.searchChats');

    fireEvent.change(input, { target: { value: 'budget' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/conversation/t1'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('moves the highlight with ArrowDown and ArrowUp before Enter', async () => {
    renderPanel();
    const input = screen.getByPlaceholderText('conversation.history.searchChats');

    fireEvent.change(input, { target: { value: 'budget' } });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowUp' });

    expect(screen.getByRole('option', { name: 'Trip budget' })).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/conversation/t2'));
  });

  it('opens a clicked chat and closes the panel', async () => {
    const onClose = renderPanel();

    fireEvent.click(screen.getByText('Yesterday notes'));

    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/conversation/y1'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
