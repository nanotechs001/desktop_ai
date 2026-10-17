/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Tooltip } from '@arco-design/web-react';
import { User } from '@icon-park/react';
import type { TFunction } from 'i18next';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { BrowserTabProfile } from '@/common/types/browser';
import { iconColors } from '@/renderer/styles/colors';
import { getAgentPresentation, isEngineEntry, type AgentPresentation } from '@/renderer/utils/ui/agentPresentation';
import { useProfileAgents } from './useBrowserProfiles';

const DEFAULT_SIZE_PX = 14;

/**
 * Name and icon of a browser profile: the Agent's name and avatar (falling back to "Agent" for one that is gone),
 * or "Personal" with the person icon.
 */
export function profilePresentation(
  profile: BrowserTabProfile | undefined,
  agents: readonly Assistant[],
  t: TFunction,
  size: number = DEFAULT_SIZE_PX
): AgentPresentation {
  if (profile?.kind !== 'agent') {
    return {
      name: t('preview.browserChrome.profile.personal'),
      avatar: <User theme='outline' size={size} fill={iconColors.secondary} />,
    };
  }
  const agent = agents.find((candidate) => candidate.id === profile.agentId);
  return getAgentPresentation(
    agent && !isEngineEntry(agent) ? { name: agent.name, avatar: agent.avatar } : null,
    t,
    size
  );
}

type ProfileBadgeProps = { profile?: BrowserTabProfile; size?: number };

/** The browser profile a tab lives in, as a small avatar with its name as tooltip and label. */
const ProfileBadge: React.FC<ProfileBadgeProps> = ({ profile, size = DEFAULT_SIZE_PX }) => {
  const { t } = useTranslation();
  const agents = useProfileAgents(profile?.kind === 'agent');
  const { name, avatar } = profilePresentation(profile, agents, t, size);

  return (
    <Tooltip content={name}>
      <span
        role='img'
        aria-label={name}
        data-testid='browser-profile-badge'
        className='flex items-center justify-center flex-shrink-0'
      >
        {avatar}
      </span>
    </Tooltip>
  );
};

export default ProfileBadge;
