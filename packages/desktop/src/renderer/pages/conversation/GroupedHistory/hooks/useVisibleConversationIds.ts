import { useMemo } from 'react';
import { useConversationHistoryContext } from '@/renderer/hooks/context/ConversationHistoryContext';
import { buildVisibleConversationIds } from '../utils/visibleConversationOrder';

export const useVisibleConversationIds = (): string[] => {
  const { groupedHistory } = useConversationHistoryContext();

  return useMemo(() => buildVisibleConversationIds(groupedHistory), [groupedHistory]);
};
