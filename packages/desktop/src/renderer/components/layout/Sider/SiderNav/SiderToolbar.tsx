/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button, Tooltip } from '@arco-design/web-react';
import { Plus } from '@icon-park/react';
import classNames from 'classnames';
import type { SiderTooltipProps } from '@renderer/utils/ui/siderTooltip';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { SidebarIcon } from '../../Titlebar';
import styles from '../Sider.module.css';

interface SiderToolbarProps {
  isMobile: boolean;
  collapsed: boolean;
  siderTooltipProps: SiderTooltipProps;
  onNewChat: () => void;
}

/** Opens or closes the sidebar; it sits above New chat, in the rail and in the open sidebar alike. */
const SidebarToggle: React.FC<{ collapsed: boolean; className: string }> = ({ collapsed, className }) => {
  const { t } = useTranslation();
  const layout = useLayoutContext();
  if (!layout?.setSiderCollapsed) return null;
  const label = collapsed
    ? t('common.expandMore', { defaultValue: 'Expand sidebar' })
    : t('common.collapse', { defaultValue: 'Collapse sidebar' });
  return (
    <Tooltip content={label} position='right'>
      <Button
        type='text'
        className={className}
        aria-label={label}
        icon={<SidebarIcon size={16} />}
        onClick={() => layout.setSiderCollapsed?.(!collapsed)}
      />
    </Tooltip>
  );
};

const SiderToolbar: React.FC<SiderToolbarProps> = ({ isMobile, collapsed, siderTooltipProps, onNewChat }) => {
  const { t } = useTranslation();

  if (collapsed) {
    return (
      <div className='shrink-0 flex flex-col items-center gap-2px w-full'>
        <SidebarToggle collapsed className='!w-full !h-34px !rd-8px text-t-primary' />
        <Tooltip {...siderTooltipProps} content={t('conversation.welcome.newConversation')} position='right'>
          <div
            role='button'
            aria-label={t('conversation.welcome.newConversation')}
            className={classNames(
              'w-full h-34px flex items-center justify-center cursor-pointer transition-colors text-t-primary rd-8px hover:bg-fill-3 active:bg-fill-4',
              styles.newChatTrigger
            )}
            onClick={onNewChat}
          >
            <Plus
              theme='outline'
              size='16'
              fill='currentColor'
              className={classNames('block leading-none', styles.newChatIcon)}
              style={{ lineHeight: 0 }}
            />
          </div>
        </Tooltip>
      </div>
    );
  }

  return (
    <div className='shrink-0 flex flex-col gap-2px'>
      {!isMobile && <SidebarToggle collapsed={false} className='!w-34px !h-34px !rd-8px text-t-primary' />}
      <Tooltip {...siderTooltipProps} content={t('conversation.welcome.newConversation')} position='right'>
        <div
          role='button'
          aria-label={t('conversation.welcome.newConversation')}
          className={classNames(
            styles.newChatTrigger,
            'h-34px flex-1 flex items-center justify-start gap-8px ps-10px pe-8px rd-0.5rem cursor-pointer group transition-all bg-transparent text-t-primary hover:bg-fill-3 active:bg-fill-4',
            isMobile && 'sider-action-btn-mobile'
          )}
          onClick={onNewChat}
        >
          <span className='size-22px rd-6px bg-aou-2 border border-solid border-[var(--color-border-2)] group-hover:bg-fill-3 group-hover:border-transparent flex items-center justify-center shrink-0 transition-colors'>
            <Plus
              theme='outline'
              size='14'
              fill='currentColor'
              className={classNames('block leading-none', styles.newChatIcon)}
              style={{ lineHeight: 0 }}
            />
          </span>
          <span className='collapsed-hidden text-t-primary text-14px font-[500] leading-24px'>
            {t('conversation.welcome.newConversation')}
          </span>
        </div>
      </Tooltip>
    </div>
  );
};

export default SiderToolbar;
