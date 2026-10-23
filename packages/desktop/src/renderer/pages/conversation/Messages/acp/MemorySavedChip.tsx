/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Tag } from '@arco-design/web-react';
import { Brain } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { MemoryChipData } from '@/common/chat/artifactToolCall';
import { useChatNavigation } from '@/renderer/pages/agentWidget/chatLocation';
import { useChatAgent } from './useChatAgent';

export type MemorySavedChipProps = MemoryChipData & { conversationId?: string };

/**
 * Chat chip for something an agent remembered (memory_save): what it did (remembered, updated, or replaced an
 * outdated fact), the note's title (plain text), whether it is about the user (the memory every agent reads), and a
 * link to the chat's Agent settings, where its Memory is. The link is hidden when the chat is gone.
 */
const MemorySavedChip: React.FC<MemorySavedChipProps> = ({ action, scope, title, conversationId }) => {
  const { t } = useTranslation();
  const { openBotSettings } = useChatNavigation();
  const { agentId, unresolved, loading } = useChatAgent(conversationId);

  return (
    <div className='flex flex-col gap-4px rounded-8px border bg-1 p-12px max-w-420px' data-testid='memory-saved-chip'>
      <div className='flex items-center gap-8px min-w-0'>
        <Brain theme='outline' size='14' className='flex-shrink-0 text-t-secondary' />
        <span className='font-medium text-13px text-t-primary flex-shrink-0'>{t(`messages.memoryChip.${action}`)}</span>
        <span className='text-13px text-t-primary truncate'>{title}</span>
        {scope === 'shared' ? (
          <Tag size='small' color='arcoblue' className='flex-shrink-0'>
            {t('messages.memoryChip.aboutYou')}
          </Tag>
        ) : null}
      </div>
      {unresolved ? null : (
        <div>
          <Button size='mini' type='text' className='!px-0' disabled={loading} onClick={() => openBotSettings(agentId)}>
            {t('messages.memoryChip.open')}
          </Button>
        </div>
      )}
    </div>
  );
};

export default MemorySavedChip;
