/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useState } from 'react';
import classNames from 'classnames';
import { Button, Spin, Tooltip } from '@arco-design/web-react';
import { Close, History, Left, Minus, PreviewCloseOne, PreviewOpen } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { TChatConversation } from '@/common/config/storage';
import type { AgentAnimationState, AgentWidgetLayout } from '@/common/types/agent/agentWidget';
import ConversationChatBody from '@/renderer/pages/conversation/components/ConversationChatBody';
import { HistoryPanelBody } from '@/renderer/components/layout/Titlebar/HistoryPanel';
import { ConversationHistoryProvider } from '@/renderer/hooks/context/ConversationHistoryContext';
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
  const historyLabel = t('conversation.history.botChatHistory', {
    name: props.conversation?.assistant?.name || props.name,
  });

  return (
    <section
      className={classNames(styles.popup, !props.visible && styles.hidden)}
      role='dialog'
      aria-label={props.name}
      data-widget-hit
      onKeyDown={(e) => {
        if (e.key === 'Escape') props.onMinimize();
      }}
    >
      <header className={styles.header}>
        <div className={styles.title}>
          <div className={styles.name}>{props.name}</div>
          <div className={styles.status} aria-live='polite'>
            <span className={styles.dot} data-state={state} aria-hidden />
            {t(`pet.widget.state.${state}`)}
          </div>
        </div>
        {agentId && action(historyLabel, <History theme='outline' size='14' />, () => setHistoryOpen(true))}
        {action(t('pet.widget.returnToMain'), <PreviewOpen theme='outline' size='14' />, props.onReturnToMain)}
        {action(t('pet.widget.hideWidget'), <PreviewCloseOne theme='outline' size='14' />, props.onHideWidget)}
        {action(t('pet.widget.minimize'), <Minus theme='outline' size='14' />, props.onMinimize)}
        {action(t('pet.widget.closePopup'), <Close theme='outline' size='14' />, props.onClose)}
      </header>
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
