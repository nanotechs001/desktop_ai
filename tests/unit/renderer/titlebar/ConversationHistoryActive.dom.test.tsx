import { render } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const sync = vi.hoisted(() => ({
  conversations: [],
  setActiveConversation: vi.fn(),
  clearCompletionUnread: vi.fn(),
  clearManualUnread: vi.fn(),
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync', () => ({
  useConversationListSync: () => sync,
}));

import { ConversationHistoryProvider } from '@/renderer/hooks/context/ConversationHistoryContext';

const renderAt = (path: string) =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <ConversationHistoryProvider>
        <div />
      </ConversationHistoryProvider>
    </MemoryRouter>
  );

describe('ConversationHistoryProvider active conversation', () => {
  it('marks the open chat active and clears its unread marks', () => {
    renderAt('/conversation/abc');

    expect(sync.setActiveConversation).toHaveBeenLastCalledWith('abc');
    expect(sync.clearCompletionUnread).toHaveBeenCalledWith('abc');
    expect(sync.clearManualUnread).toHaveBeenCalledWith('abc');
  });

  it('clears the active chat on other routes', () => {
    renderAt('/settings/agent');

    expect(sync.setActiveConversation).toHaveBeenLastCalledWith(null);
  });
});
