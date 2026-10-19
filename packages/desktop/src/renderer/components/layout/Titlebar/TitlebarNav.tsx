/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useId, useState } from 'react';
import { Button } from '@arco-design/web-react';
import { AlarmClock, History, Plus, SettingTwo } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import type { TChatConversation } from '@/common/config/storage';
import { DEFAULT_AGENT_SETTING_KEY, isVaBotAgent } from '@/common/types/agent/defaultAgent';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import { usePreviewContext } from '@renderer/pages/conversation/Preview';
import RobotListButton from './RobotListButton';
import HistoryPanel from './HistoryPanel';

/** The VA Bots mark: the robot's helmet, visor and orbit ring, drawn in the toolbar's current color. */
const HaloOrbIcon: React.FC<{ size: number }> = ({ size }) => {
  const maskId = useId();
  return (
    <svg width={size} height={size} viewBox='0 0 24 24' fill='none' aria-hidden='true' className='block'>
      <defs>
        <mask id={maskId} maskUnits='userSpaceOnUse' x='0' y='0' width='24' height='24'>
          <rect width='24' height='24' fill='white' />
          <path
            d='M6.55 11.42c1-1.25 2.5-1.25 3.5 0M13.95 11.42c1-1.25 2.5-1.25 3.5 0'
            fill='none'
            stroke='black'
            strokeWidth='1.45'
            strokeLinecap='round'
          />
        </mask>
      </defs>
      <g stroke='currentColor' strokeWidth='1.5' strokeLinecap='round' strokeLinejoin='round'>
        <path d='M.15 13.58c.48-1.27 1.23-2.27 2.28-3.08' />
        <path d='M21.57 10.5c1.05.81 1.8 1.81 2.28 3.08' />
        <circle cx='12' cy='11.25' r='9.35' />
      </g>
      <rect x='4' y='6.25' width='16' height='9.5' rx='4.55' fill='currentColor' mask={`url(#${maskId})`} />
      <g stroke='currentColor' strokeWidth='1.5' strokeLinecap='round' strokeLinejoin='round'>
        <path d='M.15 13.58c1.12 2.65 5.93 4.52 11.85 4.52 4.86 0 9.12-1.24 10.95-3.2' />
        <circle cx='22.95' cy='14.46' r='1.12' fill='currentColor' stroke='none' />
      </g>
    </svg>
  );
};

type TitlebarNavProps = {
  buttonClassName: string;
  iconSize: number;
  strokeWidth?: number;
};

/**
 * The app's navigation, in the titlebar's top-right corner (desktop): new chat, the regular chats' history, VA Bots,
 * scheduled tasks and settings. Replaces the left icon bar.
 */
const TitlebarNav: React.FC<TitlebarNavProps> = ({ buttonClassName, iconSize, strokeWidth }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { closePreview } = usePreviewContext();
  const [storedDefaultAgentId] = useConfig(DEFAULT_AGENT_SETTING_KEY);
  const [historyOpen, setHistoryOpen] = useState(false);
  const isSettings = pathname.startsWith('/settings');

  const go = (path: string, state?: unknown) => {
    closePreview();
    void Promise.resolve(navigate(path, state ? { state } : undefined)).catch((error: unknown) => {
      console.error('Navigation failed:', error);
    });
  };
  const toggleSettings = () => {
    if (!isSettings) {
      go('/settings/agent');
      return;
    }
    let target = '/guid';
    try {
      target = sessionStorage.getItem('aion:last-non-settings-path') || target;
    } catch {
      // ignore
    }
    void navigate(target.startsWith('/settings') ? '/guid' : target);
  };
  // VA Bots keep their own conversations; this history lists the regular (default agent) chats only.
  const regularChatsOnly = useCallback(
    (conversation: TChatConversation) => !isVaBotAgent(conversation.assistant, storedDefaultAgentId),
    [storedDefaultAgentId]
  );

  const icon = (Icon: typeof Plus) => (
    <Icon
      theme='outline'
      size={iconSize}
      fill='currentColor'
      strokeWidth={strokeWidth}
      className='block leading-none'
    />
  );
  const items: Array<{ key: string; label: string; icon: React.ReactNode; onClick: () => void }> = [
    {
      key: 'new-chat',
      label: t('conversation.welcome.newConversation'),
      icon: icon(Plus),
      onClick: () => go('/guid', { resetAssistant: true }),
    },
    {
      key: 'history',
      label: t('conversation.history.chatHistory'),
      icon: icon(History),
      onClick: () => setHistoryOpen(true),
    },
    {
      key: 'assistants',
      label: t('settings.assistants'),
      icon: <HaloOrbIcon size={iconSize} />,
      onClick: () => go('/assistants'),
    },
    { key: 'scheduled', label: t('cron.scheduledTasks'), icon: icon(AlarmClock), onClick: () => go('/scheduled') },
    {
      key: 'settings',
      label: isSettings ? t('common.back') : t('common.settings'),
      icon: icon(SettingTwo),
      onClick: toggleSettings,
    },
  ];

  return (
    <>
      {items.map((item) => (
        <React.Fragment key={item.key}>
          <Button
            type='text'
            size='mini'
            className={buttonClassName}
            icon={item.icon}
            onClick={item.onClick}
            aria-label={item.label}
            title={item.label}
          />
          {/* Next to VA Bots: only rendered while some bot has a robot. */}
          {item.key === 'assistants' && (
            <RobotListButton buttonClassName={buttonClassName} iconSize={iconSize} strokeWidth={strokeWidth} />
          )}
        </React.Fragment>
      ))}
      <HistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        placement='right'
        title={t('conversation.history.chatHistory')}
        filter={regularChatsOnly}
      />
    </>
  );
};

export default TitlebarNav;
