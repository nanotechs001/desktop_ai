/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useOrphanChats } from '@/renderer/hooks/assistant/useOrphanChats';
import { Message, Modal } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';

const MAX_LISTED_NAMES = 5;

/** Offers to delete the chats of deleted VA Bots. Renders nothing unless some were found. */
const OrphanChatsPrompt: React.FC = () => {
  const { t } = useTranslation();
  const { orphans, deleting, progress, keep, remove } = useOrphanChats();

  const onDelete = async () => {
    try {
      const { failed, total } = await remove();
      if (failed > 0) Message.error(t('agent.orphanChats.deleteFailed', { failed, count: total }));
    } catch (error) {
      console.warn('[orphanChats] could not delete the leftover chats:', error);
      Message.error(t('agent.orphanChats.deleteFailed', { failed: orphans.length, count: orphans.length }));
    }
  };

  const listed = orphans.slice(0, MAX_LISTED_NAMES);
  const hidden = orphans.length - listed.length;

  return (
    <Modal
      title={t('agent.orphanChats.title', { count: orphans.length })}
      visible={orphans.length > 0}
      onOk={onDelete}
      onCancel={keep}
      okText={t('common.delete')}
      cancelText={t('agent.orphanChats.keep')}
      okButtonProps={{ status: 'danger', loading: deleting }}
      cancelButtonProps={{ disabled: deleting }}
      closable={false}
      maskClosable={false}
      escToExit={false}
      className='w-[90vw] md:w-[420px]'
      wrapStyle={{ zIndex: 10000 }}
      maskStyle={{ zIndex: 9999 }}
    >
      <p className='m-0 mb-8px'>{t('agent.orphanChats.intro')}</p>
      <ul className='list-disc ps-16px m-0'>
        {listed.map((conversation) => (
          <li key={conversation.id} className='truncate'>
            {conversation.name}
          </li>
        ))}
      </ul>
      {hidden > 0 && <p className='m-0 mt-4px text-t-secondary'>{t('agent.orphanChats.more', { count: hidden })}</p>}
      {progress && (
        <p className='m-0 mt-8px text-t-secondary'>
          {t('agent.deleteBot.progress', { done: progress.done, total: progress.total })}
        </p>
      )}
    </Modal>
  );
};

export default OrphanChatsPrompt;
