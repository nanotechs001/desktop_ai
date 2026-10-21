/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import classNames from 'classnames';
import { Alert, Button, Spin, Tooltip } from '@arco-design/web-react';
import { Close, History, Left, Minus, Plus, PreviewCloseOne, SettingTwo, Tv } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { TChatConversation } from '@/common/config/storage';
import type { TabOwnership } from '@/common/types/browser';
import type { AgentAnimationState, AgentWidgetLayout } from '@/common/types/agent/agentWidget';
import ConversationChatBody from '@/renderer/pages/conversation/components/ConversationChatBody';
import { HistoryPanelBody } from '@/renderer/components/layout/Titlebar/HistoryPanel';
import { ConversationHistoryProvider } from '@/renderer/hooks/context/ConversationHistoryContext';
import { useStartNewChat } from '@/renderer/pages/conversation/components/NewChatButton';
import styles from './AgentWidget.module.css';

type WidgetChatPopupProps = {
  conversation: TChatConversation | null | undefined;
  name: string;
  state: AgentAnimationState;
  layout: AgentWidgetLayout;
  visible: boolean;
  /** The chat is mounted here (lazy: only after the first open, and only while the widget owns it). */
  chatReady: boolean;
  onMinimize: () => void;
  onClose: () => void;
  onReturnToMain: () => void;
  onHideWidget: () => void;
  /** A conversation picked from this bot's history: the robot switches to it. */
  onShowConversation: (conversationId: string) => void;
  /** The gear: open this VA Bot's settings in the main window. */
  onOpenBotSettings: (agentId: string) => void;
};

/** Agent actions on a tab that put another page in front of the user. */
const NOTICE_OPS = new Set(['open', 'switch', 'navigate']);
const MAX_SITE_LENGTH = 80;

/** A page's host, or the (untrusted, shown as text) label itself when it is not a URL. */
const siteOf = (url: string): string => {
  try {
    return new URL(url).host || url.slice(0, MAX_SITE_LENGTH);
  } catch {
    return url.slice(0, MAX_SITE_LENGTH);
  }
};

/**
 * The site this conversation's agent last opened, switched to or navigated in the browser (main's open request and
 * action report, a tab's chat from relay ownership), until dismissed. The robot window keeps no tab state of its own.
 */
const useAgentTabNotice = (conversationId: string | undefined): [string | null, () => void] => {
  const [site, setSite] = useState<string | null>(null);
  useEffect(() => {
    setSite(null);
    if (!conversationId) return;
    let alive = true;
    let chatOfTab = new Map<number, string | undefined>();
    let gotOwnership = false;
    const setOwnership = (list: TabOwnership[]) => {
      chatOfTab = new Map(
        list.map((entry) => [entry.webContentsId, entry.owner === 'user' ? undefined : entry.owner.conversationId])
      );
    };
    const offOwnership = ipcBridge.agentBrowser.ownershipChanged.on((list) => {
      gotOwnership = true;
      setOwnership(list);
    });
    void ipcBridge.agentBrowser.getOwnership
      .invoke()
      .then((res) => {
        if (alive && !gotOwnership && res.success && res.data) setOwnership(res.data);
      })
      .catch((error: unknown) => console.warn('[WidgetChatPopup] could not read tab ownership:', error));
    const offAction = ipcBridge.agentBrowser.agentAction.on((event) => {
      if (NOTICE_OPS.has(event.op) && chatOfTab.get(event.webContentsId) === conversationId)
        setSite(siteOf(event.label));
    });
    const offOpen = ipcBridge.browser.openTabRequested.on((request) => {
      if (request.conversationId === conversationId && !request.background) setSite(siteOf(request.url));
    });
    return () => {
      alive = false;
      offOwnership();
      offAction();
      offOpen();
    };
  }, [conversationId]);
  return [site, useCallback(() => setSite(null), [])];
};

const action = (label: string, icon: React.ReactNode, onClick: () => void) => (
  <Tooltip content={label} position='bottom'>
    <Button size='mini' type='text' aria-label={label} icon={icon} onClick={onClick} />
  </Tooltip>
);

/**
 * Compact chat popup above the robot. The body is the same chat surface the
 * main window renders (history, streaming, tools, approvals, send box with mic
 * + waveform + stop), bound to the same backend conversation.
 */
const WidgetChatPopup: React.FC<WidgetChatPopupProps> = (props) => {
  const { t } = useTranslation();
  const { layout, state } = props;
  const [historyOpen, setHistoryOpen] = useState(false);
  const agentId = props.conversation?.assistant?.id;
  const thisBotOnly = useCallback((c: TChatConversation) => Boolean(agentId) && c.assistant?.id === agentId, [agentId]);
  // The robot stands for a bot, so the header names the bot; the chat's own title is in its history.
  const botName = props.conversation?.assistant?.name || props.name;
  const historyLabel = t('conversation.history.botChatHistory', {
    name: props.conversation?.assistant?.name || props.name,
  });
  // A new chat with this bot; the robot moves to it the same way as to a chat picked from its history.
  const startNewChat = useStartNewChat(props.conversation, props.onShowConversation);
  const conversationId = props.conversation?.id;
  const [agentSite, dismissAgentSite] = useAgentTabNotice(conversationId);
  const watch = () => {
    dismissAgentSite();
    if (!conversationId) return;
    ipcBridge.agentWidget.watchInMain
      .invoke({ conversation_id: conversationId })
      .catch((error: unknown) =>
        console.warn('[WidgetChatPopup] could not show the browser in the main window:', error)
      );
  };

  return (
    <section
      className={classNames(styles.popup, !props.visible && styles.hidden)}
      role='dialog'
      aria-label={botName}
      data-widget-hit
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onMinimize();
      }}
    >
      <header className={styles.header}>
        <div className={styles.title}>
          <div className={styles.name}>{botName}</div>
          <div className={styles.status} aria-live='polite'>
            <span className={styles.dot} data-state={state} aria-hidden />
            {t(`pet.widget.state.${state}`)}
          </div>
        </div>
        {agentId && action(historyLabel, <History theme='outline' size='14' />, () => setHistoryOpen(true))}
        {agentId &&
          action(
            t('conversation.welcome.newConversation'),
            <Plus theme='outline' size='14' />,
            () => void startNewChat()
          )}
        {action(t('pet.widget.returnToMain'), <Tv theme='outline' size='14' />, props.onReturnToMain)}
        {agentId &&
          action(t('pet.widget.botSettings'), <SettingTwo theme='outline' size='14' />, () =>
            props.onOpenBotSettings(agentId)
          )}
        {action(t('pet.widget.hideWidget'), <PreviewCloseOne theme='outline' size='14' />, props.onHideWidget)}
        {action(t('pet.widget.minimize'), <Minus theme='outline' size='14' />, props.onMinimize)}
        {action(t('pet.widget.closePopup'), <Close theme='outline' size='14' />, props.onClose)}
      </header>
      {agentSite && (
        <Alert
          className='shrink-0'
          type='info'
          banner
          closable
          onClose={dismissAgentSite}
          content={t('pet.widget.agentOpenedSite', { site: agentSite })}
          action={
            <Button size='mini' type='text' onClick={watch}>
              {t('pet.widget.watchTab')}
            </Button>
          }
        />
      )}
      {/* Hidden, not unmounted, while the history is open: the chat comes back instantly. */}
      <div className={classNames(styles.body, historyOpen && styles.hidden)}>
        {props.chatReady && props.conversation ? (
          <ConversationChatBody conversation={props.conversation} />
        ) : (
          <div className={styles.loading}>
            <Spin />
          </div>
        )}
      </div>
      {/* Covers the whole popup; the list needs the chat-list provider, mounted only while it is open. */}
      {historyOpen && (
        <div className={styles.historyOverlay}>
          <header className={styles.header}>
            {action(t('common.back'), <Left theme='outline' size='14' />, () => setHistoryOpen(false))}
            <div className={classNames(styles.title, styles.name)}>{historyLabel}</div>
          </header>
          <div className={styles.historyBody}>
            <ConversationHistoryProvider>
              <HistoryPanelBody
                embedded
                onClose={() => setHistoryOpen(false)}
                filter={thisBotOnly}
                onSelect={(c) => props.onShowConversation(c.id)}
              />
            </ConversationHistoryProvider>
          </div>
        </div>
      )}
      <span className={styles.pointer} style={{ left: layout.bot_offset_x + layout.bot_size / 2 - 7 }} aria-hidden />
    </section>
  );
};

export default WidgetChatPopup;
