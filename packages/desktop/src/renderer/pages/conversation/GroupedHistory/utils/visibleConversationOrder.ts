import type { TChatConversation } from '@/common/config/storage';
import { getActivityTime } from '@/renderer/utils/chat/timeline';

import type { GroupedHistoryResult } from '../types';

/**
 * Every chat in the order the history panel lists them: pinned chats first, then all
 * others newest first (workspace groups are flattened). A non-empty `keyword` keeps
 * only chats whose title contains it, case-insensitively.
 */
export const orderHistoryConversations = (
  { pinnedConversations, timelineSections }: GroupedHistoryResult,
  keyword = ''
): { pinned: TChatConversation[]; others: TChatConversation[] } => {
  const needle = keyword.trim().toLowerCase();
  const matches = (conversation: TChatConversation) =>
    !needle || (conversation.name ?? '').toLowerCase().includes(needle);

  return {
    pinned: pinnedConversations.filter(matches),
    others: timelineSections
      .flatMap((section) => section.items)
      .flatMap((item) => item.workspaceGroup?.conversations ?? (item.conversation ? [item.conversation] : []))
      .filter(matches)
      .toSorted((a, b) => getActivityTime(b) - getActivityTime(a)),
  };
};

/** Ids of every chat in history-panel order; the Ctrl+Tab cycle order. */
export const buildVisibleConversationIds = (grouped: GroupedHistoryResult): string[] => {
  const { pinned, others } = orderHistoryConversations(grouped);
  return [...pinned, ...others].map((conversation) => conversation.id);
};
