/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { createContext, useContext, useEffect, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { useConversationListSync } from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import type { GroupedHistoryResult } from '@/renderer/pages/conversation/GroupedHistory/types';
import { useCronJobsMap } from '@/renderer/pages/cron';
import { buildGroupedHistory } from '@/renderer/pages/conversation/GroupedHistory/utils/groupingHelpers';

export type ConversationHistoryContextValue = ReturnType<typeof useConversationListSync> & {
  groupedHistory: GroupedHistoryResult;
  getJobStatus: ReturnType<typeof useCronJobsMap>['getJobStatus'];
  markAsRead: ReturnType<typeof useCronJobsMap>['markAsRead'];
};

const ConversationHistoryContext = createContext<ConversationHistoryContextValue | null>(null);

export const ConversationHistoryProvider: React.FC<React.PropsWithChildren> = ({ children }) => {
  const { t } = useTranslation();
  const conversationListSync = useConversationListSync();

  const { getJobStatus, markAsRead, setActiveConversation: setCronActiveConversation } = useCronJobsMap();
  const { pathname } = useLocation();
  const { setActiveConversation, clearCompletionUnread, clearManualUnread } = conversationListSync;

  // The sidebar no longer mounts the chat list, so this is what tells the store which chat is on
  // screen (finished turns there raise no unread dot) and clears its unread marks when it opens.
  useEffect(() => {
    const activeId = pathname.match(/^\/conversation\/([^/]+)/)?.[1] ?? null;
    setActiveConversation(activeId);
    if (activeId) {
      setCronActiveConversation(activeId);
      clearCompletionUnread(activeId);
      clearManualUnread(activeId);
    }
  }, [pathname, setActiveConversation, setCronActiveConversation, clearCompletionUnread, clearManualUnread]);

  const groupedHistory = useMemo(() => {
    return buildGroupedHistory(conversationListSync.conversations, t);
  }, [conversationListSync.conversations, t]);

  const value = useMemo<ConversationHistoryContextValue>(() => {
    return {
      ...conversationListSync,
      groupedHistory,
      getJobStatus,
      markAsRead,
    };
  }, [conversationListSync, groupedHistory, getJobStatus, markAsRead]);

  return <ConversationHistoryContext.Provider value={value}>{children}</ConversationHistoryContext.Provider>;
};

export const useConversationHistoryContext = (): ConversationHistoryContextValue => {
  const context = useContext(ConversationHistoryContext);

  if (!context) {
    throw new Error('useConversationHistoryContext must be used within ConversationHistoryProvider');
  }

  return context;
};
