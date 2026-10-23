/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Badge, Button, Dropdown, Menu, Tag, Tooltip } from '@arco-design/web-react';
import { Message, PreviewOpen } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { ipcBridge } from '@/common';
import { VaBotColorDot } from '@/renderer/components/agent/BotColorDot';
import type { TConversationAssistantIdentity } from '@/common/config/storage';
import type { AgentWidgetRobot } from '@/common/types/agent/agentWidget';
import { usePreviewContext } from '@renderer/pages/conversation/Preview';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { useAgentWidgetSettings, useRobots } from '@/renderer/pages/agentWidget/useAgentWidgetSync';
import { useProfileAgents } from '@renderer/pages/conversation/Preview/browser/BrowserProfiles/useBrowserProfiles';

type RobotListButtonProps = {
  buttonClassName?: string;
  /** The VA Bots button's own label and icon; `onClick` opens the Agents dashboard (the list's Manage row). */
  label: string;
  icon: React.ReactNode;
  onClick: () => void;
};

/** `name` is empty when neither the bot nor the chat has one (shown as the untitled label). */
type NamedRobot = AgentWidgetRobot & { name: string; assistant: TConversationAssistantIdentity | undefined };

const SHOW_ALL_KEY = '__all__';
const MANAGE_KEY = '__manage__';
const ROW_ICON_SIZE = 14;

// Arco's Menu.Item treats Enter as a row click (Watch): a row button's own Enter must not reach it.
const stopRowKey = (event: React.KeyboardEvent): void => event.stopPropagation();

const showRobot = (robot: AgentWidgetRobot): Promise<unknown> =>
  ipcBridge.agentWidget.ensure
    .invoke({ conversation_id: robot.conversation_id, force: true, agent_id: robot.agent_id })
    .catch(() => {});

/**
 * The titlebar VA Bots button: it names the bot whose browser is on screen, and a click opens its list. The list has
 * every VA Bot robot by bot name: Watch (or the row) opens the chat here with its browser pane, Chat opens the robot's
 * popup on the desktop. Hidden robots are tagged and counted in the badge; robots whose chat no longer exists are left
 * out. Manage VA Bots, last, opens the Agents dashboard.
 */
const RobotListButton: React.FC<RobotListButtonProps> = ({ buttonClassName, label, icon, onClick }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { revealBrowserFor, activeBotId } = usePreviewContext();
  const agents = useProfileAgents();
  const activeBotName = activeBotId ? agents.find((agent) => agent.id === activeBotId)?.name?.trim() : undefined;
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
        return {
          ...robot,
          name: conversation.assistant?.name?.trim() || conversation.name?.trim() || '',
          assistant: conversation.assistant,
        };
      })
    ).then((list) => {
      if (active) setRobots(list.filter((robot): robot is NamedRobot => robot !== null));
    });
    return () => {
      active = false;
    };
    // Only the robot list drives the lookup (a changing `t` must not re-run it).
  }, [listed]);

  // Robots are listed only while the floating widgets are on; Manage is always there.
  const shown = settings?.enabled ? robots : [];
  const hidden = shown.filter((robot) => robot.hidden);
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
        setOpen(false);
        if (key === MANAGE_KEY) onClick();
        else if (key === SHOW_ALL_KEY) for (const robot of hidden) void showRobot(robot);
        else watch(key);
      }}
    >
      {shown.map((robot) => (
        <Menu.Item key={robot.conversation_id} data-testid={`robot-row-${robot.conversation_id}`}>
          <div className='flex items-center gap-6px'>
            <VaBotColorDot assistant={robot.assistant} />
            <span className='flex-1 min-w-0 truncate'>{robot.name || t('pet.widget.untitledAgent')}</span>
            {robot.hidden && <Tag size='small'>{t('pet.widget.hiddenTag')}</Tag>}
            {/* Watch is the row's own action: its click goes on to the menu item. */}
            <Tooltip content={watchLabel}>
              <Button
                type='text'
                size='mini'
                aria-label={watchLabel}
                onKeyDown={stopRowKey}
                icon={<PreviewOpen theme='outline' size={ROW_ICON_SIZE} fill='currentColor' />}
              />
            </Tooltip>
            <Tooltip content={chatLabel}>
              <Button
                type='text'
                size='mini'
                aria-label={chatLabel}
                onKeyDown={stopRowKey}
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
      <Menu.Item key={MANAGE_KEY} data-testid='robots-manage'>
        {t('pet.widget.manageBots')}
      </Menu.Item>
    </Menu>
  );

  return (
    <Dropdown droplist={menu} trigger='click' position='br' popupVisible={open} onVisibleChange={setOpen}>
      <Button
        type='text'
        size='mini'
        className={buttonClassName}
        aria-label={label}
        title={label}
        data-testid='titlebar-assistants'
        icon={
          <Badge count={hidden.length} dotStyle={{ fontSize: 9, minWidth: 14, height: 14, lineHeight: '14px' }}>
            {icon}
          </Badge>
        }
      >
        {activeBotName && (
          <span data-testid='titlebar-active-bot' className='max-w-140px truncate text-12px'>
            {activeBotName}
          </span>
        )}
      </Button>
    </Dropdown>
  );
};

export default RobotListButton;
