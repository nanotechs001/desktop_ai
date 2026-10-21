/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Dropdown, Menu, Message, Tooltip } from '@arco-design/web-react';
import { Down } from '@icon-park/react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR, { mutate as swrMutate } from 'swr';
import type { TChatConversation } from '@/common/config/storage';
import { useModelProviderList } from '@/renderer/hooks/agent/useModelProviderList';
import { useChatNavigation } from '@/renderer/pages/agentWidget/chatLocation';
import { afterAssistantsChanged } from '@/renderer/services/crossWindowSync';
import {
  ENGINE_CATALOG_SWR_KEY,
  fetchManagedAgentsOrThrow,
  type ManagedAgent,
} from '@/renderer/utils/model/agentTypes';
import { getConversationOrNull } from '../../utils/conversationCache';
import type { HandoffLabels } from './handoffMessage';
import { pinnableAssistantId, switchAndContinue } from './switchAndContinue';
import { listSwitchTargets, type SwitchTarget } from './switchTargets';

const PREFIX = 'conversation.agentError.switch';

/** Engines are set up under Settings -> Agent, provider models under Settings -> Model. */
const ENGINE_SETTINGS_PATH = '/settings/agent';
const MODEL_SETTINGS_PATH = '/settings/model';

/** Why the chat is moving on: the limit was hit, or it is close (the near-limit warning). */
export type SwitchReason = 'limitHit' | 'nearLimit';

const useHandoffLabels = (reason: SwitchReason): HandoffLabels => {
  const { t } = useTranslation();
  return {
    header: t(reason === 'nearLimit' ? `${PREFIX}.handoff.headerNearLimit` : `${PREFIX}.handoff.header`),
    dataOnly: t(`${PREFIX}.handoff.dataOnly`),
    quoteStart: t(`${PREFIX}.handoff.quoteStart`),
    quoteEnd: t(`${PREFIX}.handoff.quoteEnd`),
    user: t(`${PREFIX}.handoff.user`),
    assistant: t(`${PREFIX}.handoff.assistant`),
    lastRequest: t(`${PREFIX}.handoff.lastRequest`),
    closing: t(`${PREFIX}.handoff.closing`),
  };
};

const currentEngineId = (conversation: TChatConversation): string | undefined =>
  (conversation.extra as { agent_id?: string } | undefined)?.agent_id;

/**
 * Shown on an error whose resolution is `switch_engine` (a usage limit, exhausted credits or quota) and on the
 * near-limit warning: one button per other connected engine and one menu per configured provider, each of which moves
 * this bot (only) there and continues in a new chat. Without any alternative it shows the backup notice, which points
 * to the settings page that adds one.
 */
const LimitSwitchActions: React.FC<{ conversationId: string; reason?: SwitchReason }> = ({
  conversationId,
  reason = 'limitHit',
}) => {
  const { t, i18n } = useTranslation();
  const { openConversation, openPage } = useChatNavigation();
  const labels = useHandoffLabels(reason);
  const [busy, setBusy] = useState(false);
  const { data: conversation } = useSWR(`conversation/${conversationId}`, () => getConversationOrNull(conversationId));
  const { data: engines } = useSWR<ManagedAgent[]>(ENGINE_CATALOG_SWR_KEY, fetchManagedAgentsOrThrow);
  const { providers, getAvailableModels, formatModelLabel } = useModelProviderList();

  if (!conversation || !engines) return null;

  const targets = listSwitchTargets({ conversation, engines, providers, getAvailableModels });
  const { modelEngine } = targets;
  const botId = pinnableAssistantId(conversation);
  const engineName = (engine: ManagedAgent): string => engine.name_i18n?.[i18n.language] || engine.name;
  // Mirrors switchAndContinue: only an engine change re-pins, and only the chat's own bot (until the next default change).
  const tooltipFor = (engine: ManagedAgent, isModel: boolean): string => {
    const engineChanges = !(isModel && conversation.type === 'aionrs') && engine.id !== currentEngineId(conversation);
    return botId && engineChanges
      ? t(`${PREFIX}.tooltipBot`, { engine: engineName(engine) })
      : t(`${PREFIX}.tooltipChatOnly`);
  };

  const run = async (target: SwitchTarget): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const id = await switchAndContinue({ conversationId, target, labels });
      await swrMutate('assistants.list');
      // The bot was re-pinned: windows with their own caches (robots, main) reload it.
      afterAssistantsChanged();
      openConversation(id);
    } catch (error) {
      console.error('[limitSwitch] Switch and continue failed:', error);
      Message.error(t(`${PREFIX}.failed`));
    } finally {
      setBusy(false);
    }
  };

  if (targets.engines.length === 0 && targets.providers.length === 0) {
    const onModelEngine = conversation.type === 'aionrs';
    return (
      <div className='flex flex-wrap items-center gap-6px text-t-secondary text-12px'>
        <span>{t(`${PREFIX}.noAlternatives`)}</span>
        <Button size='mini' onClick={() => openPage(onModelEngine ? MODEL_SETTINGS_PATH : ENGINE_SETTINGS_PATH)}>
          {t(onModelEngine ? `${PREFIX}.openModelSettings` : `${PREFIX}.openEngineSettings`)}
        </Button>
      </div>
    );
  }

  return (
    <div className='flex flex-col gap-6px'>
      <div className='text-t-secondary text-12px'>{t(`${PREFIX}.title`)}</div>
      <div className='flex flex-wrap gap-6px'>
        {targets.engines.map((engine) => (
          <Tooltip key={engine.id} content={tooltipFor(engine, false)}>
            <Button size='mini' disabled={busy} onClick={() => void run({ kind: 'engine', engine })}>
              {engineName(engine)}
            </Button>
          </Tooltip>
        ))}
        {modelEngine &&
          targets.providers.map(({ provider, models }) => (
            <Dropdown
              key={provider.id}
              trigger='click'
              disabled={busy}
              droplist={
                <Menu onClickMenuItem={(model) => void run({ kind: 'model', engine: modelEngine, provider, model })}>
                  {models.map((model) => (
                    <Menu.Item key={model}>{formatModelLabel(provider, model)}</Menu.Item>
                  ))}
                </Menu>
              }
            >
              <Tooltip content={tooltipFor(modelEngine, true)}>
                <Button size='mini' disabled={busy} icon={<Down theme='outline' size='12' />}>
                  {provider.name}
                </Button>
              </Tooltip>
            </Dropdown>
          ))}
      </div>
    </div>
  );
};

export default LimitSwitchActions;
