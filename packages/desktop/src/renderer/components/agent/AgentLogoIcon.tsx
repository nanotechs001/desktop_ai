/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { getAgentPresentation } from '@/renderer/utils/ui/agentPresentation';
import React from 'react';
import { useTranslation } from 'react-i18next';

export type AgentLogoIconProps = {
  /** Display name of the user-made Agent; used for the image alt text. */
  agent_name?: string;
  /** The Agent's avatar (image URL or emoji). */
  agentLogo?: string;
};

/** Render the Agent's avatar, or the robot icon when it has none. Never a vendor logo. */
export const AgentLogoIcon: React.FC<AgentLogoIconProps> = ({ agent_name, agentLogo }) => {
  const { t } = useTranslation();
  const { avatar } = getAgentPresentation({ name: agent_name, avatar: agentLogo }, t);

  return <span className='inline-flex w-16px h-16px items-center justify-center shrink-0 leading-none'>{avatar}</span>;
};
