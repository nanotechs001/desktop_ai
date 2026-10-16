/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { getAgentPresentation } from '@/renderer/utils/ui/agentPresentation';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

export type AgentBadgeProps = {
  /** Display name of the user-made Agent */
  agent_name?: string;
  /** Custom agent logo (SVG path or emoji string) */
  agentLogo?: string;
  /** Whether the explicit assistant logo is intentionally empty. */
  agentLogoIsFallback?: boolean;
  /** Assistant ID — when provided, clicking the badge navigates to AssistantSettings */
  assistantId?: string;
};

/** Render the Agent's avatar, or the robot icon when it has none. Never a vendor logo. */
export const AgentLogoIcon: React.FC<Pick<AgentBadgeProps, 'agentLogo' | 'agentLogoIsFallback' | 'agent_name'>> = ({
  agentLogo,
  agentLogoIsFallback,
  agent_name,
}) => {
  const { t } = useTranslation();
  const { avatar } = getAgentPresentation({ name: agent_name, avatar: agentLogoIsFallback ? undefined : agentLogo }, t);

  return <span className='inline-flex w-16px h-16px items-center justify-center shrink-0 leading-none'>{avatar}</span>;
};

/**
 * AgentBadge - Agent identity badge (logo + name)
 *
 * When `assistantId` is provided, clicking navigates to AssistantSettings editor.
 * Otherwise renders as a static display badge.
 */
const AgentBadge: React.FC<AgentBadgeProps> = ({ agent_name, agentLogo, agentLogoIsFallback, assistantId }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const handleClick = useCallback(() => {
    if (!assistantId) return;
    navigate(`/settings/assistants?highlight=${encodeURIComponent(assistantId)}`);
  }, [assistantId, navigate]);

  return (
    <div
      className={`flex items-center gap-2 bg-2 w-fit rounded-full px-[8px] py-[2px] ${assistantId ? 'cursor-pointer hover:bg-3' : ''}`}
      data-testid='agent-badge'
      onClick={handleClick}
    >
      <AgentLogoIcon agent_name={agent_name} agentLogo={agentLogo} agentLogoIsFallback={agentLogoIsFallback} />
      <span className='text-sm text-t-primary'>{getAgentPresentation({ name: agent_name }, t).name}</span>
    </div>
  );
};

export default AgentBadge;
