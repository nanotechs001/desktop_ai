/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '@arco-design/web-react';
import { BookOne } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import type { NoteChipData } from '@/common/chat/artifactToolCall';
import { DEFAULT_AGENT_ID } from '@/common/types/agent/defaultAgent';
import { useChatNavigation } from '@/renderer/pages/agentWidget/chatLocation';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';

export type NoteSavedChipProps = NoteChipData & { conversationId?: string };

/**
 * Chat chip for a note an agent saved to its notebook: the note (plain text), where it came from, and a link to the
 * notebook of the chat's Agent (the default Agent's for a chat without one) in the Agent editor. The link is hidden
 * when the chat is gone, because its Agent can't be resolved then.
 */
const NoteSavedChip: React.FC<NoteSavedChipProps> = ({ text, source, conversationId }) => {
  const { t } = useTranslation();
  const { openBotSettings } = useChatNavigation();
  // Shares the chat page's cache entry, so this is no extra request.
  const { data: conversation } = useSWR(conversationId ? `conversation/${conversationId}` : null, () =>
    getConversationOrNull(conversationId!)
  );
  const agentId = conversation?.assistant?.id ?? DEFAULT_AGENT_ID;
  const agentUnresolved = conversationId !== undefined && conversation === null;

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
          <Button
            size='mini'
            type='text'
            className='!px-0'
            disabled={conversationId !== undefined && conversation === undefined}
            onClick={() => openBotSettings(agentId)}
          >
            {t('messages.noteChip.open')}
          </Button>
        </div>
      )}
    </div>
  );
};

export default NoteSavedChip;
