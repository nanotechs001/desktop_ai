import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { TChatConversation } from '@/common/config/storage';
import { buildGroupedHistory } from '@/renderer/pages/conversation/GroupedHistory/utils/groupingHelpers';

const chats = vi.hoisted(() => ({ value: [] as TChatConversation[] }));

vi.mock('@/renderer/hooks/context/ConversationHistoryContext', () => ({
  useConversationHistoryContext: () => ({ groupedHistory: buildGroupedHistoryFor(chats.value) }),
}));

const buildGroupedHistoryFor = (conversations: TChatConversation[]) =>
  buildGroupedHistory(conversations, (key: string) => key);

import { useVisibleConversationIds } from '@/renderer/pages/conversation/GroupedHistory/hooks/useVisibleConversationIds';

const chat = (id: string, modified_at: number, extra: Record<string, unknown> = {}): TChatConversation =>
  ({ id, name: id, modified_at, created_at: modified_at, type: 'acp', extra }) as TChatConversation;

describe('Ctrl+Tab chat order', () => {
  it('cycles every chat in history-panel order: pinned first, then newest first across workspaces', () => {
    chats.value = [
      chat('a-old', 100, { workspace: '/ws/a', custom_workspace: true }),
      chat('free', 500),
      chat('b-new', 400, { workspace: '/ws/b', custom_workspace: true }),
      chat('pin', 50, { pinned: true }),
      chat('a-new', 300, { workspace: '/ws/a', custom_workspace: true }),
      chat('b-old', 200, { workspace: '/ws/b', custom_workspace: true }),
    ];

    const { result } = renderHook(() => useVisibleConversationIds());

    expect(result.current).toEqual(['pin', 'free', 'b-new', 'a-new', 'b-old', 'a-old']);
  });
});
