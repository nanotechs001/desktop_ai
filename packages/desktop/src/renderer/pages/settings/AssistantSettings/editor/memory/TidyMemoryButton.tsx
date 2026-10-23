/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { configService } from '@/common/config/configService';
import { DEFAULT_AGENT_ID, DEFAULT_AGENT_SETTING_KEY } from '@/common/types/agent/defaultAgent';
import type { MemoryVaultRef } from '@/common/types/agent/memory';
import { getWidgetConversationId } from '@/renderer/pages/agentWidget/chatLocation';
import { Button } from '@arco-design/web-react';
import { MagicWand } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

type TidyMemoryButtonProps = {
  vault: MemoryVaultRef;
};

/**
 * Opens a normal new chat with the agent (the main agent for the shared memory) and a tidy-up prompt in the input.
 * Nothing runs until the user sends it.
 */
const TidyMemoryButton: React.FC<TidyMemoryButtonProps> = ({ vault }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  // A robot window has no new-chat page of its own.
  if (getWidgetConversationId() !== null) return null;

  const handleTidy = () => {
    const shared = vault.kind === 'shared';
    const agentId = shared ? (configService.get(DEFAULT_AGENT_SETTING_KEY) ?? DEFAULT_AGENT_ID) : vault.agentId;
    void navigate('/guid', {
      state: {
        selectedAssistantId: agentId,
        prefillPrompt: t(shared ? 'agent.memory.tidy.promptShared' : 'agent.memory.tidy.prompt'),
        focusPrefill: true,
      },
    });
  };

  return (
    <div className='flex flex-wrap items-center gap-8px'>
      <Button
        type='outline'
        size='small'
        className='!rounded-full !inline-flex items-center gap-4px'
        icon={<MagicWand theme='outline' size='14' />}
        onClick={handleTidy}
      >
        {t('agent.memory.tidy.button')}
      </Button>
      <span className='min-w-0 flex-1 text-12px leading-18px text-t-tertiary'>{t('agent.memory.tidy.hint')}</span>
    </div>
  );
};

export default TidyMemoryButton;
