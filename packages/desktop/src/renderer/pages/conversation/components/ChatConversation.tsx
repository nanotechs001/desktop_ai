/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import type { TChatConversation } from '@/common/config/storage';
import { CronJobManager } from '@/renderer/pages/cron';
import { resolveCronJobId } from '@/renderer/pages/cron/cronUtils';
import { classifyConfigSetError, useAcpConfigOptions } from '@/renderer/hooks/agent/useAcpConfigOptions';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { usePresetAssistantInfo } from '@/renderer/hooks/agent/usePresetAssistantInfo';
import { iconColors } from '@/renderer/styles/colors';
import { Button, Dropdown, Menu, Message, Typography } from '@arco-design/web-react';
import { History } from '@icon-park/react';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import useSWR from 'swr';
import { useChatLocation } from '@/renderer/pages/agentWidget/chatLocation';
import { useRestoreHiddenAgentWidget, useSuspendAgentWidget } from '@/renderer/pages/agentWidget/useAgentWidgetSync';
import WidgetChatPlaceholder, { ShowAgentWidgetButton } from '@/renderer/pages/agentWidget/WidgetChatPlaceholder';
import CloseVaChatButton from './ChatLayout/CloseVaChatButton';
import AgentHistoryButton from '@/renderer/components/layout/Titlebar/AgentHistoryButton';
import WatchBrowserButton from '@/renderer/components/media/browserLive/WatchBrowserButton';
import {
  renderAcpConversationChat,
  renderAionrsConversationChat,
  useAionrsConversationModel,
} from './ConversationChatBody';
import ChatLayout from './ChatLayout';
import { ConversationNewChatButton } from './NewChatButton';
import ChatSlider from './ChatSlider.tsx';
import AcpModelSelector from '@/renderer/components/agent/AcpModelSelector';
import AcpRuntimeRestartButton from '@/renderer/components/agent/AcpRuntimeRestartButton';
import GoogleModelSelector from '../platforms/gemini/GoogleModelSelector';
import AionrsModelSelector from '../platforms/aionrs/AionrsModelSelector';
import { isLegacyReadOnlyConversationType } from '../utils/conversationRuntime';
import { resolveConversationBackend } from '../utils/conversationAssistantIdentity';
import { useActiveLease } from '../hooks/useActiveLease';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import { DEFAULT_AGENT_SETTING_KEY, isVaBotAgent } from '@/common/types/agent/defaultAgent';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview';

const configErrorMessageKey = (error: unknown) => {
  const errorKind = classifyConfigSetError(error);
  if (errorKind === 'command_ack') return 'agent.config.commandAck';
  if (errorKind === 'confirmation_timeout') return 'agent.config.timeout';
  if (errorKind === 'config_update_in_progress') return 'agent.config.busy';
  return 'agent.config.failed';
};

const _AssociatedConversation: React.FC<{ conversation_id: string }> = ({ conversation_id }) => {
  const { data } = useSWR(['getAssociateConversation', conversation_id], () =>
    ipcBridge.conversation.getAssociateConversation.invoke({ conversation_id })
  );
  const navigate = useNavigate();
  const list = useMemo(() => {
    if (!data?.length) return [];
    return data.filter((conversation) => conversation.id !== conversation_id);
  }, [data]);
  if (!list.length) return null;
  return (
    <Dropdown
      droplist={
        <Menu
          onClickMenuItem={(key) => {
            Promise.resolve(navigate(`/conversation/${key}`)).catch((error) => {
              console.error('Navigation failed:', error);
            });
          }}
        >
          {list.map((conversation) => {
            return (
              <Menu.Item key={conversation.id}>
                <Typography.Ellipsis className={'max-w-300px'}>{conversation.name}</Typography.Ellipsis>
              </Menu.Item>
            );
          })}
        </Menu>
      }
      trigger={['click']}
    >
      <Button
        size='mini'
        icon={
          <History
            theme='filled'
            size='14'
            fill={iconColors.primary}
            strokeWidth={2}
            strokeLinejoin='miter'
            strokeLinecap='square'
          />
        }
      ></Button>
    </Dropdown>
  );
};

type AionrsConversation = Extract<TChatConversation, { type: 'aionrs' }>;

const AionrsConversationPanel: React.FC<{ conversation: AionrsConversation; sliderTitle: React.ReactNode }> = ({
  conversation,
  sliderTitle,
}) => {
  const modelSelection = useAionrsConversationModel(conversation);
  const chatLocation = useChatLocation(conversation.id);
  const [storedDefaultAgentId] = useConfig(DEFAULT_AGENT_SETTING_KEY);
  // Project conversations get the Layout-level Explorer column (stage3 FULL);
  // ChatLayout's own right sider is only for no-project (legacy tree), so it does
  // not double up or reserve an empty column.
  const workspaceEnabled = Boolean(conversation.extra?.workspace) && !conversation.project_id;
  const cronJobId = resolveCronJobId(conversation.extra);
  const { info: presetAssistantInfo } = usePresetAssistantInfo(conversation);
  const aionrsAssistantId = presetAssistantInfo?.assistantId;
  const layout = useLayoutContext();
  // Mobile: model selection moved into the sendbox `+` action sheet to free up
  // header space; the dropdown stays available on desktop and tablets ≥768px.
  const isMobile = Boolean(layout?.isMobile);
  const { t } = useTranslation();
  const runtimeConfig = useAcpConfigOptions({
    conversation_id: conversation.id,
    enabled: !isMobile,
  });
  const handleThoughtLevelSetOption = useCallback(
    async (optionId: string, value: string) => {
      try {
        const result = await runtimeConfig.setConfigOption(optionId, value);
        Message.success(t('agent.thoughtLevel.switchSuccess'));
        return result;
      } catch (error) {
        Message.error(t(configErrorMessageKey(error)));
        throw error;
      }
    },
    [runtimeConfig, t]
  );

  const chatLayoutProps = {
    title: conversation.name,
    siderTitle: sliderTitle,
    sider: <ChatSlider conversation={conversation} />,
    headerExtra: (
      <div className='flex items-center gap-8px'>
        <CronJobManager conversation_id={conversation.id} cron_job_id={cronJobId} />
        {conversation.assistant && isVaBotAgent(conversation.assistant, storedDefaultAgentId) && (
          <>
            <AgentHistoryButton agentId={conversation.assistant.id} agentName={conversation.assistant.name} />
            <ShowAgentWidgetButton conversationId={conversation.id} agentId={conversation.assistant?.id} />
          </>
        )}
        {conversation.assistant && <ConversationNewChatButton conversation={conversation} />}
        {!isMobile && (
          <AionrsModelSelector
            selection={modelSelection}
            thoughtLevel={runtimeConfig.thoughtLevel}
            setStatus={runtimeConfig.setStatus}
            onSetThoughtLevel={handleThoughtLevelSetOption}
          />
        )}
      </div>
    ),
    workspaceEnabled,
    // For project conversations the preview panel is hoisted to the Layout-level
    // project host (structurally persistent across same-project conversation
    // switches — no remount). ChatLayout then renders chat only.
    previewHosted: Boolean(conversation.project_id),
    workspacePath: conversation.extra?.workspace,
    // Key the workspace-panel collapse preference per-project (falls back to
    // conversation_id inside ChatLayout when there is no project) so the panel's
    // open/closed state restores when switching conversations within a project.
    workspacePreferenceKey: conversation.project_id,
    isTemporaryWorkspace: (conversation.extra as { is_temporary_workspace?: boolean } | undefined)
      ?.is_temporary_workspace,
    backend: 'aionrs' as const,
    presetAssistant: presetAssistantInfo ? { ...presetAssistantInfo, id: aionrsAssistantId } : undefined,
  };

  return (
    <ChatLayout {...chatLayoutProps} conversation_id={conversation.id}>
      {chatLocation === 'widget' ? (
        <WidgetChatPlaceholder conversationId={conversation.id} />
      ) : (
        renderAionrsConversationChat({ conversation, modelSelection, assistantId: aionrsAssistantId })
      )}
    </ChatLayout>
  );
};

const ChatConversation: React.FC<{
  conversation?: TChatConversation;
  hideSendBox?: boolean;
}> = ({ conversation, hideSendBox }) => {
  const [runtimeReadyConversationId, setRuntimeReadyConversationId] = useState<string | null>(null);
  const { t } = useTranslation();
  // Stable identity: the selector reports readiness from an effect keyed on this
  // callback, so an inline arrow would re-run it on every render.
  const handleRuntimeReadyChange = useCallback(
    (ready: boolean) => setRuntimeReadyConversationId(ready ? (conversation?.id ?? null) : null),
    [conversation?.id]
  );
  useActiveLease({ type: 'conversation', id: conversation?.id });
  // VA Bot conversations switch the page to the browser-on-top / chat-underneath layout.
  const [storedDefaultAgentId] = useConfig(DEFAULT_AGENT_SETTING_KEY);
  const { setVaBotMode, isVaChatCollapsed, isOpen: isPreviewOpen } = usePreviewContext();
  const isVaBot = isVaBotAgent(conversation?.assistant, storedDefaultAgentId);
  useEffect(() => {
    setVaBotMode(isVaBot);
    return () => setVaBotMode(false);
  }, [isVaBot, setVaBotMode]);
  const workspaceEnabled = Boolean(conversation?.extra?.workspace) && !conversation?.project_id;
  const cronJobId = resolveCronJobId(conversation?.extra);
  const layout = useLayoutContext();
  const isMobile = Boolean(layout?.isMobile);

  const isAionrsConversation = conversation?.type === 'aionrs';
  const isLegacyReadOnlyConversation = isLegacyReadOnlyConversationType(conversation?.type);
  const resolvedHideSendBox = hideSendBox || isLegacyReadOnlyConversationType(conversation?.type);

  // 使用统一的 Hook 获取预设助手信息（ACP/Codex 会话）
  // Use unified hook for preset assistant info (ACP/Codex conversations)
  const acpConversation = isAionrsConversation ? undefined : conversation;
  const { info: presetAssistantInfo, isLoading: isLoadingPreset } = usePresetAssistantInfo(acpConversation);
  const acpAssistantId = presetAssistantInfo?.assistantId;
  const resolvedConversationBackend = resolveConversationBackend(conversation, presetAssistantInfo?.backend);

  const chatLocation = useChatLocation(conversation?.id);
  // Watching this VA Bot's chat here: its taskbar robot steps away until the chat closes or the user moves on. The chat
  // is hidden only while collapsed under an open pane; with no pane it fills the page.
  const chatVisible = !(isPreviewOpen && isVaChatCollapsed);
  useSuspendAgentWidget(isVaBot ? conversation?.id : undefined, chatVisible && chatLocation === 'main');
  // Chatting with a VA Bot brings back its robot if it was hidden (not for read-only legacy chats).
  useRestoreHiddenAgentWidget(
    isVaBot && !isLegacyReadOnlyConversation ? conversation?.id : undefined,
    conversation?.assistant?.id
  );
  const conversationNode = useMemo(() => {
    if (!conversation || isAionrsConversation) return null;
    // The floating widget owns this chat right now; the browser/preview pane stays here.
    if (chatLocation === 'widget') return <WidgetChatPlaceholder conversationId={conversation.id} />;
    return renderAcpConversationChat({
      conversation,
      backend: resolvedConversationBackend,
      assistantId: acpAssistantId,
      hideSendBox: resolvedHideSendBox,
    });
  }, [
    conversation,
    isAionrsConversation,
    chatLocation,
    resolvedConversationBackend,
    resolvedHideSendBox,
    acpAssistantId,
  ]);

  const sliderTitle = useMemo(() => {
    return (
      <div className='flex items-center justify-between'>
        <span className='text-16px font-bold text-t-primary'>{t('conversation.workspace.title')}</span>
      </div>
    );
  }, [t]);

  // For ACP/Codex conversations, use AcpModelSelector that can show/switch models.
  // For other conversations, show disabled model selector.
  // Mobile: model selection moves into the sendbox `+` action sheet, so the
  // header selector is suppressed to free up vertical space.
  const modelSelector = useMemo(() => {
    if (!conversation || isAionrsConversation) return undefined;
    if (isMobile) return undefined;
    if (isLegacyReadOnlyConversation) return undefined;
    // Antigravity included: the backend discovers agy's model list and writes it
    // into the same catalog the ACP picker reads, so it must not fall through to
    // the disabled selector below.
    if (conversation.type === 'acp' || conversation.type === 'antigravity') {
      const extra = conversation.extra as { current_model_id?: string };
      return (
        <AcpModelSelector
          conversation_id={conversation.id}
          backend={resolvedConversationBackend}
          initialModelId={extra.current_model_id}
          onRuntimeReadyChange={handleRuntimeReadyChange}
          waitForWarmup
        />
      );
    }
    return <GoogleModelSelector disabled={true} />;
  }, [conversation, isAionrsConversation, isMobile, isLegacyReadOnlyConversation, resolvedConversationBackend]);

  if (conversation && conversation.type === 'aionrs') {
    return <AionrsConversationPanel key={conversation.id} conversation={conversation} sliderTitle={sliderTitle} />;
  }

  // 如果有预设助手信息，使用预设助手的 logo 和名称；加载中时不进入 fallback；否则使用 backend 的 logo
  // If preset assistant info exists, use preset logo/name; while loading, avoid fallback; otherwise use backend logo
  const chatLayoutProps = presetAssistantInfo
    ? {
        presetAssistant: { ...presetAssistantInfo, id: acpAssistantId },
      }
    : isLoadingPreset
      ? {} // Still loading custom agents — avoid showing backend logo prematurely
      : {
          backend: resolvedConversationBackend,
        };

  const headerExtraNode = (
    <div className='flex items-center gap-8px'>
      {conversation && (
        <div className='shrink-0'>
          <CronJobManager conversation_id={conversation.id} cron_job_id={cronJobId} />
        </div>
      )}
      {conversation?.assistant && isVaBot && (
        <AgentHistoryButton agentId={conversation.assistant.id} agentName={conversation.assistant.name} />
      )}
      {conversation?.assistant && !isLegacyReadOnlyConversation && (
        <ConversationNewChatButton conversation={conversation} />
      )}
      {conversation && isVaBot && !isLegacyReadOnlyConversation && (
        <ShowAgentWidgetButton conversationId={conversation.id} agentId={conversation.assistant?.id} />
      )}
      {conversation && <WatchBrowserButton conversationId={conversation.id} />}
      {modelSelector && <div className='shrink-0'>{modelSelector}</div>}
      {conversation && conversation.type === 'acp' && !isMobile && !isLegacyReadOnlyConversation && (
        <div className='shrink-0'>
          <AcpRuntimeRestartButton
            conversation_id={conversation.id}
            availability={runtimeReadyConversationId === conversation.id ? 'ready' : 'initializing'}
          />
        </div>
      )}
      {isVaBot && <CloseVaChatButton />}
    </div>
  );

  return (
    <ChatLayout
      title={conversation?.name}
      {...chatLayoutProps}
      headerExtra={headerExtraNode}
      siderTitle={sliderTitle}
      sider={<ChatSlider conversation={conversation} />}
      workspaceEnabled={workspaceEnabled}
      previewHosted={Boolean(conversation?.project_id)}
      workspacePath={conversation?.extra?.workspace}
      workspacePreferenceKey={conversation?.project_id}
      isTemporaryWorkspace={
        (conversation?.extra as { is_temporary_workspace?: boolean } | undefined)?.is_temporary_workspace
      }
      conversation_id={conversation?.id}
    >
      {conversationNode}
    </ChatLayout>
  );
};

export default ChatConversation;
