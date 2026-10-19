/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { parseError } from '@/common/utils';
import { revalidateAcpConfigOptions } from '@/renderer/hooks/agent/useAcpConfigOptions';
import { useConversationRuntimeView } from '@/renderer/pages/conversation/runtime/useConversationRuntimeView';
import { getConversationOrNull } from '@/renderer/pages/conversation/utils/conversationCache';
import { iconColors } from '@/renderer/styles/colors';
import { Button, Message, Popconfirm, Tooltip } from '@arco-design/web-react';
import { Refresh } from '@icon-park/react';
import React, { useCallback, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type RuntimeRestartAvailability = 'ready' | 'initializing' | 'unavailable';

export const useAcpRuntimeRestart = ({ conversation_id }: { conversation_id: string }) => {
  const { t } = useTranslation();
  const [restarting, setRestarting] = useState(false);
  const restartingRef = useRef(false);
  const runtimeView = useConversationRuntimeView(conversation_id);

  const restart = useCallback(async () => {
    if (restartingRef.current) return;
    restartingRef.current = true;
    setRestarting(true);
    runtimeView.markRestartStarted();
    try {
      const response = await ipcBridge.conversation.restartRuntime.invoke({ conversation_id });
      runtimeView.markRestartSucceeded(response.runtime);
      await revalidateAcpConfigOptions(conversation_id);
      Message.success(t('agent.runtimeRestart.success'));
    } catch (error) {
      let runtime = null;
      try {
        runtime = (await getConversationOrNull(conversation_id))?.runtime ?? null;
      } catch {
        // The local gate still needs to recover if the follow-up refresh also fails.
      }
      runtimeView.markRestartFailed(runtime, parseError(error) || 'runtime restart failed');
      Message.error(t('agent.runtimeRestart.failed'));
      throw error;
    } finally {
      restartingRef.current = false;
      setRestarting(false);
    }
  }, [conversation_id, runtimeView, t]);

  return { restart, restarting };
};

/**
 * Header button for ACP conversations that restarts the agent runtime: the
 * backend tears down the cached CLI agent process (cancelling any active
 * turn) and respawns it, resuming the session when possible. Chat history is
 * preserved. Use after external CLI config changes — e.g. switching the
 * Codex channel via ccswitch — which a running process cannot pick up.
 */
const AcpRuntimeRestartButton: React.FC<{
  conversation_id: string;
  availability?: RuntimeRestartAvailability;
  disabled?: boolean;
  disabledReason?: string;
}> = ({ conversation_id, availability = 'ready', disabled, disabledReason }) => {
  const { t } = useTranslation();
  const { restart, restarting } = useAcpRuntimeRestart({ conversation_id });

  if (availability === 'unavailable') {
    return null;
  }

  const initializing = availability === 'initializing';
  const effectivelyDisabled = disabled || initializing;
  const effectiveDisabledReason =
    disabledReason ?? (initializing ? t('agent.runtimeRestart.initializingTooltip') : undefined);
  const button = (
    <Button
      type='text'
      size='mini'
      className='h-28px w-28px'
      loading={restarting}
      disabled={effectivelyDisabled || restarting}
      icon={<Refresh theme='outline' size='14' fill={iconColors.secondary} />}
      aria-label={t('agent.runtimeRestart.tooltip')}
    />
  );

  if (effectivelyDisabled) {
    return <Tooltip content={effectiveDisabledReason ?? t('agent.runtimeRestart.tooltip')}>{button}</Tooltip>;
  }

  return (
    <Popconfirm
      title={t('agent.runtimeRestart.tooltip')}
      content={t('agent.runtimeRestart.confirmContent')}
      okText={t('common.confirm')}
      cancelText={t('common.cancel')}
      onOk={() => {
        void restart().catch((): void => undefined);
      }}
    >
      <span className='inline-flex'>
        <Tooltip content={t('agent.runtimeRestart.tooltip')}>{button}</Tooltip>
      </span>
    </Popconfirm>
  );
};

export default AcpRuntimeRestartButton;
