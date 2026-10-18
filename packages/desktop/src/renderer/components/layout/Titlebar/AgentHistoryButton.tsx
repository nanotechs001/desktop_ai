/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useState } from 'react';
import { Button, Tooltip } from '@arco-design/web-react';
import { History } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { TChatConversation } from '@/common/config/storage';
import HistoryPanel from './HistoryPanel';

type AgentHistoryButtonProps = {
  agentId: string;
  agentName: string;
  className?: string;
};

/** Opens the history panel listing only one VA Bot's chats (VA Bots keep theirs out of the main chat history). */
const AgentHistoryButton: React.FC<AgentHistoryButtonProps> = ({ agentId, agentName, className }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const thisAgentOnly = useCallback(
    (conversation: TChatConversation) => conversation.assistant?.id === agentId,
    [agentId]
  );
  const label = t('conversation.history.botChatHistory', { name: agentName });

  return (
    <>
      <Tooltip content={label}>
        <Button
          size='mini'
          className={className}
          aria-label={label}
          icon={<History theme='outline' size='14' />}
          onClick={() => setOpen(true)}
        />
      </Tooltip>
      <HistoryPanel open={open} onClose={() => setOpen(false)} placement='right' title={label} filter={thisAgentOnly} />
    </>
  );
};

export default AgentHistoryButton;
