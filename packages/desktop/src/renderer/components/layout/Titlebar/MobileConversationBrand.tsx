/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { AgentLogoIcon } from '@/renderer/components/agent/AgentBadge';
import { usePresetAssistantInfo } from '@/renderer/hooks/agent/usePresetAssistantInfo';
import { agentFromPresetInfo } from '@/renderer/utils/ui/agentPresentation';
import React from 'react';
import useSWR from 'swr';

type MobileConversationBrandProps = {
  conversation_id: string;
  fallbackTitle: string;
};

const MobileConversationBrand: React.FC<MobileConversationBrandProps> = ({ conversation_id, fallbackTitle }) => {
  const { data: conversation } = useSWR(
    conversation_id ? `mobile-titlebar.conversation.${conversation_id}` : null,
    () => ipcBridge.conversation.get.invoke({ id: conversation_id })
  );
  const { info: presetAssistant } = usePresetAssistantInfo(conversation || undefined);
  const agent = agentFromPresetInfo(presetAssistant);
  const title = conversation?.name || fallbackTitle;

  return (
    <span className='app-titlebar__brand-mobile'>
      <AgentLogoIcon agent_name={agent?.name} agentLogo={agent?.avatar} />
      <span className='app-titlebar__brand-text'>{title}</span>
    </span>
  );
};

export default MobileConversationBrand;
