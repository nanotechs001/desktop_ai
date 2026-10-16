import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Drawer, Empty, Input, Modal } from '@arco-design/web-react';
import { Search } from '@icon-park/react';
import { useTranslation } from 'react-i18next';

import type { TChatConversation } from '@/common/config/storage';
import { useConversationHistoryContext } from '@/renderer/hooks/context/ConversationHistoryContext';
import ConversationRow from '@/renderer/pages/conversation/GroupedHistory/ConversationRow';
import { useBatchSelection } from '@/renderer/pages/conversation/GroupedHistory/hooks/useBatchSelection';
import { useConversationActions } from '@/renderer/pages/conversation/GroupedHistory/hooks/useConversationActions';
import type { GroupedHistoryResult } from '@/renderer/pages/conversation/GroupedHistory/types';
import { useCronJobsMap } from '@/renderer/pages/cron';
import { getActivityTime, getTimelineLabel } from '@/renderer/utils/chat/timeline';

const PANEL_WIDTH = 360;

type HistorySection = { key: string; label: string; conversations: TChatConversation[] };

/** Pinned chats first, then every other chat by recency under Today / Yesterday / Last 7 Days / Earlier. */
export const buildHistorySections = (
  { pinnedConversations, timelineSections }: GroupedHistoryResult,
  keyword: string,
  now: number,
  t: (key: string) => string
): HistorySection[] => {
  const needle = keyword.trim().toLowerCase();
  const matches = (conversation: TChatConversation) =>
    !needle || (conversation.name ?? '').toLowerCase().includes(needle);

  const others = timelineSections
    .flatMap((section) => section.items)
    .flatMap((item) => item.workspaceGroup?.conversations ?? (item.conversation ? [item.conversation] : []))
    .filter(matches)
    .toSorted((a, b) => getActivityTime(b) - getActivityTime(a));

  const sections: HistorySection[] = [];
  const pinned = pinnedConversations.filter(matches);
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
};

/** Search field and chat list. Mounted only while the drawer is open, so its data hooks cost nothing when closed. */
const HistoryPanelBody: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { t } = useTranslation();
  const [keyword, setKeyword] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const history = useConversationHistoryContext();
  const { getJobStatus, markAsRead } = useCronJobsMap();
  const { selectedConversationIds, setSelectedConversationIds, toggleSelectedConversation } = useBatchSelection(
    false,
    history.conversations
  );
  const actions = useConversationActions({
    batchMode: false,
    onSessionClick: onClose,
    selectedConversationIds,
    setSelectedConversationIds,
    toggleSelectedConversation,
    markAsRead,
    markManualUnread: history.markManualUnread,
    clearManualUnread: history.clearManualUnread,
    isManualUnread: history.isManualUnread,
  });

  const sections = useMemo(
    () => buildHistorySections(history.groupedHistory, keyword, Date.now(), t),
    [history.groupedHistory, keyword, t]
  );
  const visible = useMemo(() => sections.flatMap((section) => section.conversations), [sections]);
  const activeConversation = visible[Math.min(activeIndex, visible.length - 1)];

  useEffect(() => {
    setActiveIndex(0);
  }, [keyword]);

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
        actions.handleConversationClick(activeConversation);
      }
    },
    [activeConversation, actions, visible.length]
  );

  return (
    <>
      <div className='h-full flex flex-col'>
        {/* The titlebar height keeps the search field clear of the macOS traffic lights. */}
        <div className='shrink-0 px-12px pb-8px' style={{ paddingTop: 'var(--titlebar-height, 40px)' }}>
          <Input
            autoFocus
            allowClear
            value={keyword}
            onChange={setKeyword}
            onKeyDown={handleKeyDown}
            prefix={<Search theme='outline' size='14' fill='currentColor' />}
            placeholder={t('conversation.history.searchChats')}
          />
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
                  <ConversationRow
                    key={conversation.id}
                    conversation={conversation}
                    isGenerating={history.isConversationGenerating(conversation.id)}
                    isWaitingConfirmation={history.isConversationWaitingConfirmation(conversation.id)}
                    hasUnread={history.hasCompletionUnread(conversation.id) || history.isManualUnread(conversation.id)}
                    isManualUnread={history.isManualUnread(conversation.id)}
                    collapsed={false}
                    tooltipEnabled={false}
                    batchMode={false}
                    checked={false}
                    selected={activeConversation?.id === conversation.id}
                    menuVisible={actions.dropdownVisibleId === conversation.id}
                    onToggleChecked={toggleSelectedConversation}
                    onConversationClick={actions.handleConversationClick}
                    onOpenMenu={actions.handleOpenMenu}
                    onMenuVisibleChange={actions.handleMenuVisibleChange}
                    onEditStart={actions.handleEditStart}
                    onCreateCronTask={actions.handleCreateCronTask}
                    onArchive={actions.handleArchive}
                    onTogglePin={actions.handleTogglePin}
                    onToggleManualUnread={actions.handleToggleManualUnread}
                    getJobStatus={getJobStatus}
                  />
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
const HistoryPanel: React.FC<HistoryPanelProps> = ({ open, onClose }) => (
  <Drawer
    visible={open}
    placement='left'
    width={PANEL_WIDTH}
    title={null}
    footer={null}
    closable={false}
    unmountOnExit
    onCancel={onClose}
    bodyStyle={{ padding: 0 }}
  >
    <HistoryPanelBody onClose={onClose} />
  </Drawer>
);

export default HistoryPanel;
