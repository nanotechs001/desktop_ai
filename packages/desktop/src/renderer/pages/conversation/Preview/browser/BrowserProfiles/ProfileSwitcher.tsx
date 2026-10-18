/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Dropdown, Menu } from '@arco-design/web-react';
import { Down } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import type { BrowserTabProfile } from '@/common/types/browser';
import { iconColors } from '@/renderer/styles/colors';
import { pickableAgents } from '@/renderer/utils/ui/agentPresentation';
import { profilePresentation } from './ProfileBadge';
import { profileKeyOf, useProfileAgents } from './useBrowserProfiles';

type ProfileSwitcherProps = {
  /** Opens a new tab in the chosen profile. */
  onOpen: (profile: BrowserTabProfile) => void;
};

const keyOf = (profile: BrowserTabProfile): string => profileKeyOf(profile);

/**
 * The new-tab menu's profile switcher: a new tab in Personal or in any Agent's profile, e.g. to sign that Agent in
 * to a site it will use.
 */
const ProfileSwitcher: React.FC<ProfileSwitcherProps> = ({ onOpen }) => {
  const { t } = useTranslation();
  const agents = useProfileAgents();
  const label = t('preview.browserChrome.profile.newTabIn');
  const profiles: BrowserTabProfile[] = [
    { kind: 'personal' },
    ...pickableAgents(agents).map((agent): BrowserTabProfile => ({ kind: 'agent', agentId: agent.id })),
  ];

  const handleClick = (key: string): void => {
    const chosen = profiles.find((profile) => keyOf(profile) === key);
    if (chosen) onOpen(chosen);
  };

  return (
    <Dropdown
      trigger='click'
      position='bl'
      droplist={
        <Menu onClickMenuItem={handleClick}>
          {profiles.map((profile) => {
            const { name, avatar } = profilePresentation(profile, agents, t);
            return (
              <Menu.Item key={keyOf(profile)}>
                <span className='flex items-center gap-8px'>
                  {avatar}
                  <span className='truncate'>{name}</span>
                </span>
              </Menu.Item>
            );
          })}
        </Menu>
      }
    >
      <Button
        type='text'
        size='mini'
        aria-label={label}
        title={label}
        icon={<Down theme='outline' size='12' fill={iconColors.secondary} />}
      />
    </Dropdown>
  );
};

export default ProfileSwitcher;
