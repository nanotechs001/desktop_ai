/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '@arco-design/web-react';
import { BookOne } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { NotebookChipData } from '@/common/chat/artifactToolCall';
import { useChatNavigation } from '@/renderer/pages/agentWidget/chatLocation';
import { useChatAgent } from './useChatAgent';

export type NoteSavedChipProps = NotebookChipData & { conversationId?: string };

/**
 * Chat chip for a note an agent saved to its notebook: the note (plain text), where it came from, and a link to the
 * notebook of the chat's Agent (the default Agent's for a chat without one) in the Agent editor. The link is hidden
 * when the chat is gone, because its Agent can't be resolved then.
 */
const NoteSavedChip: React.FC<NoteSavedChipProps> = ({ text, source, conversationId }) => {
  const { t } = useTranslation();
  const { openBotSettings } = useChatNavigation();
  const { agentId, unresolved: agentUnresolved, loading } = useChatAgent(conversationId);

  return (
    <div className='flex flex-col gap-4px rounded-8px border bg-1 p-12px max-w-420px' data-testid='note-saved-chip'>
      <div className='flex items-center gap-8px min-w-0'>
        <BookOne theme='outline' size='14' className='flex-shrink-0 text-t-secondary' />
        <span className='font-medium text-13px text-t-primary'>{t('messages.noteChip.title')}</span>
        <span className='text-12px text-t-secondary truncate'>
          {source === 'page' ? t('messages.noteChip.fromPage') : t('messages.noteChip.fromChat')}
        </span>
      </div>
      <div className='text-13px text-t-primary break-words'>{text}</div>
      {agentUnresolved ? null : (
        <div>
          <Button size='mini' type='text' className='!px-0' disabled={loading} onClick={() => openBotSettings(agentId)}>
            {t('messages.noteChip.open')}
          </Button>
        </div>
      )}
    </div>
  );
};

export default NoteSavedChip;
