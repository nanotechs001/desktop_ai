/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Message, Modal } from '@arco-design/web-react';
import { DeleteOne } from '@icon-park/react';
import React, { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';

import { removeChats } from '@/renderer/hooks/assistant/botChats';
import { useRegularChatsOnly } from '@/renderer/hooks/assistant/useRegularChatsOnly';
import { useConversationHistoryContext } from '@/renderer/hooks/context/ConversationHistoryContext';
import { emitter } from '@/renderer/utils/emitter';
import PreferenceRow from './PreferenceRow';

// One toast for the whole clear: progress updates it in place, then the result replaces it.
const CLEAR_TOAST_ID = 'chat-history-clear';

/** Deletes every chat with the main agent at once; Pixebots keep theirs (deleting a Pixebot deletes its chats). */
const ChatHistorySection: React.FC = () => {
  const { t } = useTranslation();
  const { conversations } = useConversationHistoryContext();
  const regularChatsOnly = useRegularChatsOnly();
  const mainChats = useMemo(() => conversations.filter(regularChatsOnly), [conversations, regularChatsOnly]);

  const handleClear = useCallback(() => {
    const targets = mainChats;
    Modal.confirm({
      title: t('conversation.history.clearHistory'),
      content: t('conversation.history.clearHistoryConfirm', { count: targets.length }),
      okText: t('conversation.history.confirmDelete'),
      cancelText: t('conversation.history.cancelDelete'),
      okButtonProps: { status: 'danger' },
      alignCenter: true,
      getPopupContainer: () => document.body,
      onOk: async () => {
        const { removed, failed } = await removeChats(targets, {
          onProgress: (done, total) =>
            Message.loading({
              id: CLEAR_TOAST_ID,
              duration: 0,
              content: t('conversation.history.clearHistoryProgress', { done, total }),
            }),
        });
        emitter.emit('chat.history.refresh');
        if (failed.length === 0) {
          Message.success({
            id: CLEAR_TOAST_ID,
            content: t('conversation.history.batchDeleteSuccess', { count: removed.length }),
          });
        } else {
          Message.warning({
            id: CLEAR_TOAST_ID,
            content: t('conversation.history.clearHistoryPartial', { removed: removed.length, failed: failed.length }),
          });
        }
      },
    });
  }, [mainChats, t]);

  return (
    <div className='px-[12px] md:px-[32px] py-16px bg-2 rd-16px'>
      <div className='text-14px font-medium text-t-primary mb-8px'>{t('settings.chatHistory.title')}</div>
      <PreferenceRow label={t('conversation.history.clearHistory')} description={t('settings.chatHistory.description')}>
        <Button
          status='danger'
          icon={<DeleteOne theme='outline' size='14' fill='currentColor' />}
          disabled={mainChats.length === 0}
          onClick={handleClear}
          className='!flex items-center gap-6px'
        >
          {t('conversation.history.clearHistory')}
        </Button>
      </PreferenceRow>
    </div>
  );
};

export default ChatHistorySection;
