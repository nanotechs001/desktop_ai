/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Badge, Button, Dropdown, Menu, Tag, Tooltip } from '@arco-design/web-react';
import { Message, PreviewOpen, Robot } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ipcBridge } from '@/common';
import type { AgentWidgetRobot } from '@/common/types/agent/agentWidget';
import { usePreviewContext } from '@renderer/pages/conversation/Preview';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { useAgentWidgetSettings, useRobots } from '@/renderer/pages/agentWidget/useAgentWidgetSync';

type RobotListButtonProps = {
  buttonClassName?: string;
  iconSize: number;
  strokeWidth?: number;
};

/** `name` is empty when neither the bot nor the chat has one (shown as the untitled label). */
type NamedRobot = AgentWidgetRobot & { name: string };

const SHOW_ALL_KEY = '__all__';
const ROW_ICON_SIZE = 14;

const showRobot = (robot: AgentWidgetRobot): Promise<unknown> =>
  ipcBridge.agentWidget.ensure
    .invoke({ conversation_id: robot.conversation_id, force: true, agent_id: robot.agent_id })
    .catch(() => {});

/**
 * Titlebar action, shown while any VA Bot has a robot: hovering lists them by bot name. Watch (or the row) opens the
 * chat here with its browser pane; Chat opens the robot's popup on the desktop. Hidden robots are tagged and counted
 * in the badge. Robots whose chat no longer exists are left out.
 */
const RobotListButton: React.FC<RobotListButtonProps> = ({ buttonClassName, iconSize, strokeWidth }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { revealBrowserFor } = usePreviewContext();
  const settings = useAgentWidgetSettings();
  const listed = useRobots();
  const [robots, setRobots] = useState<NamedRobot[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    let active = true;
    void Promise.all(
      listed.map(async (robot) => {
        const conversation = await getConversationOrNull(robot.conversation_id).catch((): null => null);
        if (!conversation) return null;
        return { ...robot, name: conversation.assistant?.name?.trim() || conversation.name?.trim() || '' };
      })
    ).then((list) => {
      if (active) setRobots(list.filter((robot): robot is NamedRobot => robot !== null));
    });
    return () => {
      active = false;
    };
    // Only the robot list drives the lookup (a changing `t` must not re-run it).
  }, [listed]);

  if (!settings?.enabled || robots.length === 0) return null;

  const hidden = robots.filter((robot) => robot.hidden);
  const label = t('pet.widget.robotList');
  const watchLabel = t('pet.widget.watchRobot');
  const chatLabel = t('pet.widget.chatWithRobot');

  const watch = (conversationId: string): void => {
    void ipcBridge.agentWidget.setChatLocation
      .invoke({ conversation_id: conversationId, location: 'main' })
      .catch(() => {});
    revealBrowserFor(conversationId);
    void navigate(`/conversation/${conversationId}`);
  };

  const chat = (event: Event, robot: NamedRobot): void => {
    // The row itself means Watch: keep this click from reaching it.
    event.stopPropagation();
    setOpen(false);
    void ipcBridge.agentWidget.openPopup
      .invoke({ conversation_id: robot.conversation_id, agent_id: robot.agent_id })
      .catch(() => {});
  };

  const menu = (
    <Menu
      onClickMenuItem={(key) => {
        if (key === SHOW_ALL_KEY) for (const robot of hidden) void showRobot(robot);
        else watch(key);
      }}
    >
      {robots.map((robot) => (
        <Menu.Item key={robot.conversation_id} data-testid={`robot-row-${robot.conversation_id}`}>
          <div className='flex items-center gap-6px'>
            <span className='flex-1 min-w-0 truncate'>{robot.name || t('pet.widget.untitledAgent')}</span>
            {robot.hidden && <Tag size='small'>{t('pet.widget.hiddenTag')}</Tag>}
            {/* Watch is the row's own action: its click goes on to the menu item. */}
            <Tooltip content={watchLabel}>
              <Button
                type='text'
                size='mini'
                aria-label={watchLabel}
                icon={<PreviewOpen theme='outline' size={ROW_ICON_SIZE} fill='currentColor' />}
              />
            </Tooltip>
            <Tooltip content={chatLabel}>
              <Button
                type='text'
                size='mini'
                aria-label={chatLabel}
                icon={<Message theme='outline' size={ROW_ICON_SIZE} fill='currentColor' />}
                onClick={(event) => chat(event, robot)}
              />
            </Tooltip>
          </div>
        </Menu.Item>
      ))}
      {hidden.length > 1 && (
        <Menu.Item key={SHOW_ALL_KEY} data-testid='robots-show-all'>
          {t('pet.widget.showAllRobots')}
        </Menu.Item>
      )}
    </Menu>
  );

  return (
    <Dropdown droplist={menu} trigger='hover' position='br' popupVisible={open} onVisibleChange={setOpen}>
      <Button
        type='text'
        size='mini'
        className={buttonClassName}
        aria-label={label}
        title={label}
        data-testid='titlebar-robots'
        icon={
          <Badge count={hidden.length} dotStyle={{ fontSize: 9, minWidth: 14, height: 14, lineHeight: '14px' }}>
            <Robot
              theme='outline'
              size={iconSize}
              fill='currentColor'
              strokeWidth={strokeWidth}
              className='block leading-none'
            />
          </Badge>
        }
      />
    </Dropdown>
  );
};

export default RobotListButton;
