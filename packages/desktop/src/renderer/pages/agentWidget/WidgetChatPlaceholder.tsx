/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Button, Tooltip } from '@arco-design/web-react';
import { Robot } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import { useAgentWidgetSettings } from './useAgentWidgetSync';

/** Header action: show (or re-show a hidden) floating widget for an existing conversation. */
export const ShowAgentWidgetButton: React.FC<{ conversationId: string; agentId?: string }> = ({
  conversationId,
  agentId,
}) => {
  const { t } = useTranslation();
  const settings = useAgentWidgetSettings();
  if (!settings?.enabled) return null;
  return (
    <Tooltip content={t('pet.widget.showWidget')}>
      <Button
        size='mini'
        aria-label={t('pet.widget.showWidget')}
        icon={<Robot theme='outline' size='14' />}
        onClick={() =>
          void ipcBridge.agentWidget.ensure
            .invoke({ conversation_id: conversationId, force: true, agent_id: agentId })
            .catch(() => {})
        }
      />
    </Tooltip>
  );
};

/**
 * Stands in for the chat pane in the main window while the conversation's chat
 * lives in its floating widget. The browser/preview pane is untouched, so the
 * agent keeps working in the main window while you talk to it on the desktop.
 */
const WidgetChatPlaceholder: React.FC<{ conversationId: string }> = ({ conversationId }) => {
  const { t } = useTranslation();
  return (
    <div className='flex-1 flex flex-col items-center justify-center gap-12px p-24px text-center' role='status'>
      <Robot theme='outline' size='32' className='text-t-tertiary' />
      <div className='text-14px text-t-secondary'>{t('pet.widget.chatInWidget')}</div>
      <Button
        type='primary'
        onClick={() =>
          void ipcBridge.agentWidget.setChatLocation
            .invoke({ conversation_id: conversationId, location: 'main' })
            .catch(() => {})
        }
      >
        {t('pet.widget.returnChatHere')}
      </Button>
    </div>
  );
};

export default WidgetChatPlaceholder;
