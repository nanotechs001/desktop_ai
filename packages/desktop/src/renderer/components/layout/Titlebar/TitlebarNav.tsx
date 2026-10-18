/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useState } from 'react';
import { Button } from '@arco-design/web-react';
import { AlarmClock, Ghost, History, Plus, SettingTwo } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';
import type { TChatConversation } from '@/common/config/storage';
import { DEFAULT_AGENT_SETTING_KEY, isVaBotAgent } from '@/common/types/agent/defaultAgent';
import brandLogo from '@renderer/assets/logos/brand/app.png';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import { usePreviewContext } from '@renderer/pages/conversation/Preview';
import HistoryPanel from './HistoryPanel';

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
    { key: 'assistants', label: t('settings.assistants'), icon: icon(Ghost), onClick: () => go('/assistants') },
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
      <img src={brandLogo} alt='' draggable={false} data-brand-logo className='app-titlebar__logo' />
      {items.map((item) => (
        <Button
          key={item.key}
          type='text'
          size='mini'
          className={buttonClassName}
          icon={item.icon}
          onClick={item.onClick}
          aria-label={item.label}
          title={item.label}
        />
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
