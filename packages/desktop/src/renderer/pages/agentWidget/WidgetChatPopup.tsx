/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useId, useMemo, useState } from 'react';
import classNames from 'classnames';
import { Alert, Button, Spin, Tooltip } from '@arco-design/web-react';
import {
  Close,
  Comments,
  FullScreen,
  History,
  Left,
  OffScreen,
  Plus,
  PreviewCloseOne,
  SettingTwo,
  Tv,
} from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { TChatConversation } from '@/common/config/storage';
import type { AgentAnimationState, AgentWidgetLayout, AgentWidgetWindowMode } from '@/common/types/agent/agentWidget';
import ConversationChatBody from '@/renderer/pages/conversation/components/ConversationChatBody';
import { HistoryPanelBody } from '@/renderer/components/layout/Titlebar/HistoryPanel';
import { ConversationHistoryProvider } from '@/renderer/hooks/context/ConversationHistoryContext';
import { useStartNewChat } from '@/renderer/pages/conversation/components/NewChatButton';
import { useConversationListSync } from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync';
import { EmbeddedAssistantEditor } from '@/renderer/pages/settings/AssistantSettings/AssistantEditorPage';
import { getActivityTime } from '@/renderer/utils/chat/timeline';
import { formatRelativeTime } from '@/renderer/utils/chat/relativeTime';
import styles from './AgentWidget.module.css';
import { onAgentTabActivity } from './useAgentWidgetSync';

type WidgetChatPopupProps = {
  conversation: TChatConversation | null | undefined;
  name: string;
  state: AgentAnimationState;
  layout: AgentWidgetLayout;
  visible: boolean;
  /** The chat is mounted here (lazy: only after the first open, and only while the widget owns it). */
  chatReady: boolean;
  /** Escape: close the popup back to the robot. */
  onMinimize: () => void;
  onClose: () => void;
  onReturnToMain: () => void;
  onHideWidget: () => void;
  /** A conversation picked from this bot's history: the robot switches to it. */
  onShowConversation: (conversationId: string) => void;
  /** The gear: open this VA Bot's settings in the main window. */
  onOpenBotSettings: (agentId: string) => void;
};

const MAX_SITE_LENGTH = 80;
// The expanded window's sidebar lists at most this many of the bot's chats (Recent has the full, searchable list).
const RECENT_LIMIT = 30;

/** What the expanded window's main area shows. */
type ExpandedView = 'chat' | 'recent' | 'settings';

/** A page's host, or the (untrusted, shown as text) label itself when it is not a URL. */
const siteOf = (url: string): string => {
  try {
    return new URL(url).host || url.slice(0, MAX_SITE_LENGTH);
  } catch {
    return url.slice(0, MAX_SITE_LENGTH);
  }
};

/**
 * The site this conversation's agent last opened, switched to or navigated in the browser, until dismissed. The robot
 * window keeps no tab state of its own.
 */
const useAgentTabNotice = (conversationId: string | undefined): [string | null, () => void] => {
  const [site, setSite] = useState<string | null>(null);
  useEffect(() => {
    setSite(null);
    if (!conversationId) return;
    return onAgentTabActivity((chat, url) => {
      if (chat === conversationId) setSite(siteOf(url));
    });
  }, [conversationId]);
  return [site, useCallback(() => setSite(null), [])];
};

const action = (label: string, icon: React.ReactNode, onClick: () => void) => (
  <Tooltip content={label} position='bottom'>
    <Button size='mini' type='text' aria-label={label} icon={icon} onClick={onClick} />
  </Tooltip>
);

type RecentConversationsProps = {
  filter: (conversation: TChatConversation) => boolean;
  currentId: string | undefined;
  onSelect: (conversationId: string) => void;
};

/** The bot's latest chats in the expanded window's sidebar; mounted only there, so the list store costs nothing else. */
const RecentConversations: React.FC<RecentConversationsProps> = ({ filter, currentId, onSelect }) => {
  const { t, i18n } = useTranslation();
  const captionId = useId();
  const { conversations } = useConversationListSync();
  const recent = useMemo(
    () =>
      conversations
        .filter(filter)
        .toSorted((a, b) => getActivityTime(b) - getActivityTime(a))
        .slice(0, RECENT_LIMIT),
    [conversations, filter]
  );
  const now = Date.now();
  return (
    <div className={styles.recent}>
      <div id={captionId} className={styles.caption}>
        {t('pet.widget.recentConversations')}
      </div>
      <ul className={styles.recentList} aria-labelledby={captionId}>
        {recent.map((conversation) => {
          const selected = conversation.id === currentId;
          return (
            <li key={conversation.id}>
              <Button
                long
                type='text'
                className={classNames(styles.navItem, styles.recentRow, selected && styles.selected)}
                aria-current={selected || undefined}
                icon={<Comments theme='outline' size='16' />}
                onClick={() => onSelect(conversation.id)}
              >
                <span className={styles.rowText}>
                  <span className={styles.rowTitle} data-row-title>
                    {conversation.name || t('conversation.welcome.newConversation')}
                  </span>
                  <span className={styles.rowTime} data-row-time>
                    {formatRelativeTime(getActivityTime(conversation), i18n.language, now)}
                  </span>
                </span>
              </Button>
            </li>
          );
        })}
      </ul>
    </div>
  );
};

/**
 * Compact chat popup above the robot. The body is the same chat surface the
 * main window renders (history, streaming, tools, approvals, send box with mic
 * + waveform + stop), bound to the same backend conversation. In the expanded window a sidebar (Chat, Recent,
 * Settings, the bot's recent chats) sits beside it; the chat keeps its place in the tree, so switching never remounts it.
 */
const WidgetChatPopup: React.FC<WidgetChatPopupProps> = (props) => {
  const { t } = useTranslation();
  const { layout, state } = props;
  const [historyOpen, setHistoryOpen] = useState(false);
  const [expandedView, setExpandedView] = useState<ExpandedView>('chat');
  // The sidebar (and the list store behind it) only exists while the expanded window shows.
  const expandedWindow = layout.window_mode === 'expanded' && props.visible;
  const view: ExpandedView = expandedWindow ? expandedView : 'chat';
  const showChat = useCallback(() => setExpandedView('chat'), []);
  // A closed window reopens on the chat, not on a half-edited Settings view.
  useEffect(() => {
    if (!props.visible) setExpandedView('chat');
  }, [props.visible]);
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
  const setWindowMode = (mode: AgentWidgetWindowMode) => {
    ipcBridge.agentWidget.setWindowMode
      .invoke({ conversation_id: layout.conversation_id, mode })
      .catch((error: unknown) => console.warn('[WidgetChatPopup] could not change the window mode:', error));
  };
  const navItem = (key: ExpandedView, label: string, icon: React.ReactNode) => (
    <Button
      long
      type='text'
      className={classNames(styles.navItem, view === key && styles.selected)}
      aria-current={view === key ? 'page' : undefined}
      icon={icon}
      onClick={() => setExpandedView(key)}
    >
      {label}
    </Button>
  );
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
      data-layout={expandedWindow ? 'expanded' : 'compact'}
      role='dialog'
      aria-label={botName}
      data-widget-hit
      onKeyDown={(e) => {
        // Escape that something inside already handled, from a portal (an Arco menu), or inside Recent/Settings (an
        // editor with unsaved edits) is not a request to close the window.
        if (e.key !== 'Escape' || e.defaultPrevented) return;
        const target = e.target as Element;
        if (!e.currentTarget.contains(target) || target.closest('[data-view]')) return;
        props.onMinimize();
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
        {agentId &&
          action(historyLabel, <History theme='outline' size='14' />, () =>
            expandedWindow ? setExpandedView('recent') : setHistoryOpen(true)
          )}
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
        {layout.window_mode === 'expanded'
          ? action(t('pet.widget.restoreWindow'), <OffScreen theme='outline' size='14' />, () =>
              setWindowMode('compact')
            )
          : action(t('pet.widget.expandWindow'), <FullScreen theme='outline' size='14' />, () =>
              setWindowMode('expanded')
            )}
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
      <div className={styles.frame}>
        {expandedWindow && (
          <aside className={styles.sidebar}>
            <nav className={styles.nav} aria-label={botName}>
              {navItem('chat', t('pet.widget.navChat'), <Comments theme='outline' size='16' />)}
              {agentId && navItem('recent', t('conversation.history.recents'), <History theme='outline' size='16' />)}
              {agentId && navItem('settings', t('common.settings'), <SettingTwo theme='outline' size='16' />)}
            </nav>
            {agentId && (
              <RecentConversations
                filter={thisBotOnly}
                currentId={conversationId}
                onSelect={props.onShowConversation}
              />
            )}
          </aside>
        )}
        <div className={styles.main}>
          {/* Hidden, not unmounted, while another view or the history is open: the chat comes back instantly. */}
          <div className={classNames(styles.body, (historyOpen || view !== 'chat') && styles.hidden)}>
            {props.chatReady && props.conversation ? (
              <ConversationChatBody conversation={props.conversation} />
            ) : (
              <div className={styles.loading}>
                <Spin />
              </div>
            )}
          </div>
          {view === 'recent' && (
            <div className={styles.view} data-view>
              <ConversationHistoryProvider>
                <HistoryPanelBody
                  embedded
                  title={historyLabel}
                  onClose={showChat}
                  filter={thisBotOnly}
                  onSelect={(c) => props.onShowConversation(c.id)}
                />
              </ConversationHistoryProvider>
            </div>
          )}
          {/* Kept mounted (hidden) across Restore, so a half-edited bot survives a trip to the compact popup. */}
          {expandedView === 'settings' && agentId && (
            <div className={classNames(styles.view, view !== 'settings' && styles.hidden)} data-view>
              <EmbeddedAssistantEditor assistantId={agentId} onBack={showChat} />
            </div>
          )}
        </div>
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
