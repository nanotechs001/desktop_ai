import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import type { TChatConversation } from '@/common/config/storage';
import { addEventListener } from '@/renderer/utils/emitter';

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

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const arco = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...arco, Message: { ...arco.Message, success: vi.fn(), error: vi.fn() } };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
const ipc = vi.hoisted(() => ({
  update: vi.fn().mockResolvedValue(true),
  archive: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('@/common', () => ({
  ipcBridge: { conversation: { update: { invoke: ipc.update } }, sidebar: { archive: { invoke: ipc.archive } } },
}));
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
      getJobStatus: () => 'none',
      markAsRead: vi.fn(),
    }),
  };
});
vi.mock('@/renderer/pages/cron', () => ({ CronJobIndicator: () => null }));
vi.mock('@/renderer/hooks/agent/usePresetAssistantInfo', () => ({
  usePresetAssistantInfo: () => ({ info: null }),
}));

import HistoryPanel from '@/renderer/components/layout/Titlebar/HistoryPanel';

const LocationProbe: React.FC = () => <div data-testid='path'>{useLocation().pathname}</div>;

const renderPanel = (
  onClose = vi.fn(),
  { initialPath = '/guid', onSearchMessages = undefined as (() => void) | undefined } = {}
) => {
  chats.value = [
    makeConversation('p1', 'Pinned plan', NOW - 40 * DAY, true),
    makeConversation('t1', 'Budget review', NOW),
    makeConversation('t2', 'Trip budget', NOW - 1000),
    makeConversation('y1', 'Yesterday notes', NOW - DAY),
    makeConversation('e1', 'Old budget memo', NOW - 30 * DAY),
  ];
  render(
    <MemoryRouter initialEntries={[initialPath]}>
      <HistoryPanel open onClose={onClose} onSearchMessages={onSearchMessages} />
      <LocationProbe />
    </MemoryRouter>
  );
  return onClose;
};

const rows = () => Array.from(document.querySelectorAll<HTMLElement>('.chat-history__item'));
const optionNames = () => rows().map((row) => row.textContent);
const activeRowName = () => document.querySelector('[data-active=true] .chat-history__item')?.textContent;

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

    expect(activeRowName()).toBe('Trip budget');
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/conversation/t2'));
  });

  it('opens a clicked chat and closes the panel', async () => {
    const onClose = renderPanel();

    fireEvent.click(screen.getByText('Yesterday notes'));

    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/conversation/y1'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('marks the open chat as selected, separately from the keyboard highlight', () => {
    renderPanel(vi.fn(), { initialPath: '/conversation/y1' });

    expect(document.getElementById('c-y1')).toHaveClass('!bg-fill-3');
    expect(document.getElementById('c-p1')).not.toHaveClass('!bg-fill-3');
    expect(activeRowName()).toBe('Pinned plan');
  });

  it('wires the row menu to pin and archive', async () => {
    ipc.update.mockClear();
    ipc.archive.mockClear();
    renderPanel();

    fireEvent.click(screen.getByTestId('conversation-row-menu-t1'));
    fireEvent.click(await screen.findByText('conversation.history.pin'));
    await waitFor(() =>
      expect(ipc.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 't1',
          merge_extra: true,
          updates: { extra: expect.objectContaining({ pinned: true }) },
        })
      )
    );

    // Back/Forward listen for this to forget the archived chat.
    const archived = vi.fn();
    const stopListening = addEventListener('conversation.archived', archived);
    fireEvent.click(screen.getByTestId('conversation-row-menu-t2'));
    fireEvent.click((await screen.findAllByText('conversation.history.archive')).at(-1) as HTMLElement);
    await waitFor(() => expect(ipc.archive).toHaveBeenCalledWith({ item_type: 'conversation', item_id: 't2' }));
    await waitFor(() => expect(archived).toHaveBeenCalledWith('t2'));
    stopListening();
  });

  it('opens message search from the header entry only when one is provided', () => {
    const onSearchMessages = vi.fn();
    renderPanel(vi.fn(), { onSearchMessages });

    fireEvent.click(screen.getByRole('button', { name: 'conversation.historySearch.tooltip' }));

    expect(onSearchMessages).toHaveBeenCalledTimes(1);
  });

  it('has no message-search entry without a handler', () => {
    renderPanel();

    expect(screen.queryByRole('button', { name: 'conversation.historySearch.tooltip' })).not.toBeInTheDocument();
  });
});
