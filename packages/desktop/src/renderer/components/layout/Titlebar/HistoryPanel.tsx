import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Button, Drawer, Empty, Input, Message, Modal } from '@arco-design/web-react';
import { Search } from '@icon-park/react';
import classNames from 'classnames';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import type { TChatConversation } from '@/common/config/storage';
import { removeChats } from '@/renderer/hooks/assistant/botChats';
import { useConversationHistoryContext } from '@/renderer/hooks/context/ConversationHistoryContext';
import ConversationRow from '@/renderer/pages/conversation/GroupedHistory/ConversationRow';
import { useConversationActions } from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationActions';
import type { GroupedHistoryResult } from '@/renderer/pages/conversation/GroupedHistory/types';
import { orderHistoryConversations } from '@/renderer/pages/conversation/GroupedHistory/utils/visibleConversationOrder';
import { getActivityTime, getTimelineLabel } from '@/renderer/utils/chat/timeline';
import { emitter } from '@/renderer/utils/emitter';

const PANEL_WIDTH = 360;

// Rows only toggle a checkbox in batch mode, which this panel does not have.
const ignoreChecked = () => {};

type HistorySection = { key: string; label: string; conversations: TChatConversation[] };

/** Pinned chats first, then every other chat by recency under Today / Yesterday / Last 7 Days / Earlier. */
export const buildHistorySections = (
  grouped: GroupedHistoryResult,
  keyword: string,
  now: number,
  t: (key: string) => string
): HistorySection[] => {
  const { pinned, others } = orderHistoryConversations(grouped, keyword);

  const sections: HistorySection[] = [];
  if (pinned.length > 0) {
    sections.push({ key: 'pinned', label: t('conversation.history.pinned'), conversations: pinned });
  }
  for (const conversation of others) {
    const label = getTimelineLabel(getActivityTime(conversation), now, t);
    const last = sections.at(-1);
    if (last && last.key === label) {
      sections[sections.length - 1] = { ...last, conversations: [...last.conversations, conversation] };
    } else {
      sections.push({ key: label, label, conversations: [conversation] });
    }
  }
  return sections;
};

type HistoryPanelProps = {
  open: boolean;
  onClose: () => void;
  /** Shows a "Search messages" entry in the header; omitted where message search lives elsewhere. */
  onSearchMessages?: () => void;
  /** Only chats that pass are listed (e.g. regular chats, without VA Bot conversations). */
  filter?: (conversation: TChatConversation) => boolean;
  /** Heading above the search field. */
  title?: string;
  placement?: 'left' | 'right';
  /** Replaces opening the chat in this window (e.g. a robot switching to the picked conversation). */
  onSelect?: (conversation: TChatConversation) => void;
  /** Rendered inside another surface (no drawer): no room reserved for the window's titlebar. */
  embedded?: boolean;
  /** Focus the search field on mount (default). The always-visible sider list must not steal focus. */
  autoFocus?: boolean;
};

/** Search field and chat list. Mounted only while the drawer is open, so its data hooks cost nothing when closed. */
export const HistoryPanelBody: React.FC<Omit<HistoryPanelProps, 'open' | 'placement'>> = ({
  onClose,
  onSearchMessages,
  filter,
  title,
  onSelect,
  embedded,
  autoFocus = true,
}) => {
  const { t } = useTranslation();
  const [keyword, setKeyword] = useState('');
  // The keyboard highlight follows the search field; a list nobody is typing into shows only the open chat.
  const [searchFocused, setSearchFocused] = useState(autoFocus);
  const [activeIndex, setActiveIndex] = useState(0);
  const history = useConversationHistoryContext();
  const openConversationId = useLocation().pathname.match(/^\/conversation\/([^/]+)/)?.[1];
  const navigate = useNavigate();
  const actions = useConversationActions({
    onSessionClick: onClose,
    markAsRead: history.markAsRead,
    markManualUnread: history.markManualUnread,
    clearManualUnread: history.clearManualUnread,
    isManualUnread: history.isManualUnread,
  });
  const conversationNameById = useMemo(
    () => new Map(history.conversations.map((conversation) => [conversation.id, conversation.name])),
    [history.conversations]
  );
  const resolveConversationName = useCallback((id: string) => conversationNameById.get(id), [conversationNameById]);
  const openConversation = useCallback(
    (conversation: TChatConversation) => {
      if (!onSelect) {
        actions.handleConversationClick(conversation);
        return;
      }
      onSelect(conversation);
      onClose();
    },
    [actions, onSelect, onClose]
  );

  const sections = useMemo(() => {
    const all = buildHistorySections(history.groupedHistory, keyword, Date.now(), t);
    if (!filter) return all;
    return all
      .map((section) => ({ ...section, conversations: section.conversations.filter(filter) }))
      .filter((section) => section.conversations.length > 0);
  }, [history.groupedHistory, keyword, t, filter]);
  const visible = useMemo(() => sections.flatMap((section) => section.conversations), [sections]);
  const activeConversation = searchFocused ? visible[Math.min(activeIndex, visible.length - 1)] : undefined;

  useEffect(() => {
    setActiveIndex(0);
  }, [keyword]);

  const leaveIfOpen = useCallback(
    (conversationId: string) => {
      if (conversationId === openConversationId) void navigate('/');
    },
    [navigate, openConversationId]
  );

  const handleDelete = useCallback(
    (conversation: TChatConversation) => {
      actions.handleMenuVisibleChange(conversation.id, false);
      Modal.confirm({
        title: t('conversation.history.deleteTitle'),
        content: t('conversation.history.deleteConfirm', { name: conversation.name }),
        okText: t('conversation.history.confirmDelete'),
        cancelText: t('conversation.history.cancelDelete'),
        okButtonProps: { status: 'danger' },
        alignCenter: true,
        getPopupContainer: () => document.body,
        onOk: async () => {
          const { failed } = await removeChats([conversation], { onRemoved: leaveIfOpen });
          emitter.emit('chat.history.refresh');
          if (failed.length > 0) Message.error(t('conversation.history.deleteFailed'));
          else Message.success(t('conversation.history.deleteSuccess'));
        },
      });
    },
    [actions, leaveIfOpen, t]
  );

  useEffect(() => {
    if (activeConversation)
      document.getElementById(`c-${activeConversation.id}`)?.scrollIntoView?.({ block: 'nearest' });
  }, [activeConversation]);

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const step = event.key === 'ArrowDown' ? 1 : -1;
        setActiveIndex((prev) => Math.max(0, Math.min(prev + step, visible.length - 1)));
      } else if (event.key === 'Enter' && activeConversation && !event.nativeEvent.isComposing) {
        event.preventDefault();
        openConversation(activeConversation);
      }
    },
    [activeConversation, openConversation, visible.length]
  );

  return (
    <>
      <div className='h-full flex flex-col'>
        {/* The titlebar height keeps the search field clear of the macOS traffic lights. */}
        <div
          className='shrink-0 px-12px pb-8px'
          style={{ paddingTop: embedded ? '8px' : 'var(--titlebar-height, 40px)' }}
        >
          {title && <div className='px-4px pb-8px text-16px font-semibold text-t-primary'>{title}</div>}
          <Input
            autoFocus={autoFocus}
            onFocus={() => setSearchFocused(true)}
            onBlur={() => setSearchFocused(false)}
            allowClear
            value={keyword}
            onChange={setKeyword}
            onKeyDown={handleKeyDown}
            prefix={<Search theme='outline' size='14' fill='currentColor' />}
            placeholder={t('conversation.history.searchChats')}
          />
          {onSearchMessages && (
            <Button
              long
              type='text'
              size='small'
              className='mt-4px !flex items-center gap-6px !justify-start'
              icon={<Search theme='outline' size='14' fill='currentColor' />}
              onClick={onSearchMessages}
            >
              {t('conversation.historySearch.tooltip')}
            </Button>
          )}
        </div>
        <div className='flex-1 min-h-0 overflow-y-auto px-8px pb-12px'>
          {sections.length === 0 ? (
            <div className='py-48px flex-center'>
              <Empty
                description={keyword.trim() ? t('conversation.history.noMatches') : t('conversation.history.noHistory')}
              />
            </div>
          ) : (
            sections.map((section) => (
              <section key={section.key}>
                <div className='px-12px h-28px mt-8px flex items-center text-14px text-t-tertiary font-[500]'>
                  {section.label}
                </div>
                {section.conversations.map((conversation) => (
                  <div
                    key={conversation.id}
                    data-active={activeConversation?.id === conversation.id}
                    className={classNames({ 'rd-8px bg-fill-2': activeConversation?.id === conversation.id })}
                  >
                    <ConversationRow
                      conversation={conversation}
                      isGenerating={history.isConversationGenerating(conversation.id)}
                      isWaitingConfirmation={history.isConversationWaitingConfirmation(conversation.id)}
                      hasUnread={
                        history.hasCompletionUnread(conversation.id) || history.isManualUnread(conversation.id)
                      }
                      isManualUnread={history.isManualUnread(conversation.id)}
                      collapsed={false}
                      tooltipEnabled={false}
                      batchMode={false}
                      checked={false}
                      selected={openConversationId === conversation.id}
                      menuVisible={actions.dropdownVisibleId === conversation.id}
                      onToggleChecked={ignoreChecked}
                      onConversationClick={openConversation}
                      onOpenMenu={actions.handleOpenMenu}
                      onMenuVisibleChange={actions.handleMenuVisibleChange}
                      onEditStart={actions.handleEditStart}
                      onCreateCronTask={actions.handleCreateCronTask}
                      onArchive={actions.handleArchive}
                      onDelete={handleDelete}
                      onTogglePin={actions.handleTogglePin}
                      onToggleManualUnread={actions.handleToggleManualUnread}
                      getJobStatus={history.getJobStatus}
                      resolveConversationName={resolveConversationName}
                    />
                  </div>
                ))}
              </section>
            ))
          )}
        </div>
      </div>
      <Modal
        title={t('conversation.history.renameTitle')}
        visible={actions.renameModalVisible}
        onOk={actions.handleRenameConfirm}
        onCancel={actions.handleRenameCancel}
        okText={t('conversation.history.saveName')}
        cancelText={t('conversation.history.cancelEdit')}
        confirmLoading={actions.renameLoading}
        okButtonProps={{ disabled: !actions.renameModalName.trim() }}
        alignCenter
        getPopupContainer={() => document.body}
      >
        <Input
          autoFocus
          value={actions.renameModalName}
          onChange={actions.setRenameModalName}
          onPressEnter={actions.handleRenameConfirm}
          placeholder={t('conversation.history.renamePlaceholder')}
          allowClear
        />
      </Modal>
    </>
  );
};

/** Left drawer listing every chat by date with title search; clicking a chat opens it and closes the panel. */
const HistoryPanel: React.FC<HistoryPanelProps> = ({ open, onClose, placement = 'left', ...body }) => (
  <Drawer
    visible={open}
    placement={placement}
    width={PANEL_WIDTH}
    title={null}
    footer={null}
    closable={false}
    unmountOnExit
    onCancel={onClose}
    bodyStyle={{ padding: 0 }}
  >
    <HistoryPanelBody onClose={onClose} {...body} />
  </Drawer>
);

export default HistoryPanel;
