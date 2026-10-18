/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Badge, Button, Dropdown, Menu } from '@arco-design/web-react';
import { Robot } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { AgentWidgetHiddenRobot } from '@/common/types/agent/agentWidget';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { useAgentWidgetSettings, useHiddenRobots } from '@/renderer/pages/agentWidget/useAgentWidgetSync';

type HiddenRobotsButtonProps = {
  buttonClassName?: string;
  iconSize: number;
  strokeWidth?: number;
};

/** `name` is empty when neither the bot nor the chat has one (shown as the untitled label). */
type NamedRobot = AgentWidgetHiddenRobot & { name: string };

const SHOW_ALL_KEY = '__all__';

const showRobot = (robot: AgentWidgetHiddenRobot): Promise<unknown> =>
  ipcBridge.agentWidget.ensure
    .invoke({ conversation_id: robot.conversation_id, force: true, agent_id: robot.agent_id })
    .catch(() => {});

/**
 * Titlebar action, shown only while some VA Bot robots are hidden: lists them by bot name so each (or all) can be
 * put back on the desktop. Robots whose chat no longer exists are left out.
 */
const HiddenRobotsButton: React.FC<HiddenRobotsButtonProps> = ({ buttonClassName, iconSize, strokeWidth }) => {
  const { t } = useTranslation();
  const settings = useAgentWidgetSettings();
  const hidden = useHiddenRobots();
  const [robots, setRobots] = useState<NamedRobot[]>([]);

  useEffect(() => {
    let active = true;
    void Promise.all(
      hidden.map(async (robot) => {
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
    // Only the hidden list drives the lookup (a changing `t` must not re-run it).
  }, [hidden]);

  if (!settings?.enabled || robots.length === 0) return null;

  const label = t('pet.widget.showHiddenRobots');
  const menu = (
    <Menu
      onClickMenuItem={(key) => {
        const targets = key === SHOW_ALL_KEY ? robots : robots.filter((robot) => robot.conversation_id === key);
        for (const robot of targets) void showRobot(robot);
      }}
    >
      {robots.map((robot) => (
        <Menu.Item key={robot.conversation_id} data-testid={`hidden-robot-${robot.conversation_id}`}>
          {robot.name || t('pet.widget.untitledAgent')}
        </Menu.Item>
      ))}
      {robots.length > 1 && (
        <Menu.Item key={SHOW_ALL_KEY} data-testid='hidden-robots-show-all'>
          {t('pet.widget.showAllRobots')}
        </Menu.Item>
      )}
    </Menu>
  );

  return (
    <Dropdown droplist={menu} trigger='click' position='br'>
      <Button
        type='text'
        size='mini'
        className={buttonClassName}
        aria-label={label}
        title={label}
        data-testid='titlebar-hidden-robots'
        icon={
          <Badge count={robots.length} dotStyle={{ fontSize: 9, minWidth: 14, height: 14, lineHeight: '14px' }}>
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

export default HiddenRobotsButton;
