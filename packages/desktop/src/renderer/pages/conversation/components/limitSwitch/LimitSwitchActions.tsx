/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Message, Tooltip } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR, { mutate as swrMutate } from 'swr';
import type { IProvider, TChatConversation, TProviderWithModel } from '@/common/config/storage';
import { useModelProviderList } from '@/renderer/hooks/agent/useModelProviderList';
import { useChatNavigation } from '@/renderer/pages/agentWidget/chatLocation';
import GuidModelSelector from '@/renderer/pages/guid/components/GuidModelSelector';
import { afterAssistantsChanged } from '@/renderer/services/crossWindowSync';
import {
  buildAgentRuntimeModelInfo,
  buildAgentRuntimeThoughtLevelOption,
} from '@/renderer/utils/model/agentRuntimeCatalog';
import {
  ENGINE_ACCOUNT_STATUS_SWR_KEY,
  ENGINE_CATALOG_SWR_KEY,
  fetchEngineAccountSignedIn,
  fetchManagedAgentsOrThrow,
  type ManagedAgent,
} from '@/renderer/utils/model/agentTypes';
import { getConversationOrNull } from '../../utils/conversationCache';
import type { HandoffLabels } from './handoffMessage';
import { useAllSubscriptionUsage } from './subscriptionUsage';
import { pinnableAssistantId, switchAndContinue } from './switchAndContinue';
import { listSwitchTargets, type SwitchTarget, type SwitchTargets } from './switchTargets';
import { formatResetTime } from './usageWarning';

const PREFIX = 'conversation.agentError.switch';

/** Engines are set up under Settings -> Agent, provider models under Settings -> Model. */
const ENGINE_SETTINGS_PATH = '/settings/agent';
const MODEL_SETTINGS_PATH = '/settings/model';

/** Why the chat is moving on: the limit was hit, it is close (the near-limit warning), or the user chose to. */
export type SwitchReason = 'limitHit' | 'nearLimit' | 'manual';

const HANDOFF_HEADER_KEYS: Record<SwitchReason, string> = {
  limitHit: 'header',
  nearLimit: 'headerNearLimit',
  manual: 'headerManual',
};

const useHandoffLabels = (reason: SwitchReason): HandoffLabels => {
  const { t } = useTranslation();
  return {
    header: t(`${PREFIX}.handoff.${HANDOFF_HEADER_KEYS[reason]}`),
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

/** The model and thinking level a picked CLI engine will start on, both changeable, and Proceed. */
const EnginePicker: React.FC<{ engine: ManagedAgent; busy: boolean; onProceed: (target: SwitchTarget) => void }> = ({
  engine,
  busy,
  onProceed,
}) => {
  const { t } = useTranslation();
  // Unpicked, the model stays the engine's own default (no override), as on the new-chat page.
  const [model, setModel] = useState<string | null>(null);
  const [thoughtLevel, setThoughtLevel] = useState<string | null>(null);
  const modelInfo = buildAgentRuntimeModelInfo(engine);
  const thoughtOption = buildAgentRuntimeThoughtLevelOption(engine);
  const shownThoughtLevel = thoughtLevel || thoughtOption?.currentValue || thoughtOption?.options[0]?.value;
  return (
    <div className='flex flex-wrap items-center gap-6px'>
      <GuidModelSelector
        isGeminiMode={false}
        modelList={[]}
        current_model={undefined}
        setCurrentModel={async () => {}}
        currentAcpCachedModelInfo={modelInfo}
        selectedAcpModel={model}
        setSelectedAcpModel={setModel}
        thoughtLevelOption={thoughtOption && { ...thoughtOption, currentValue: shownThoughtLevel }}
        onThoughtLevelSelect={setThoughtLevel}
      />
      <Button
        size='mini'
        type='primary'
        loading={busy}
        onClick={() =>
          onProceed({ kind: 'engine', engine, model: model ?? undefined, thoughtLevel: shownThoughtLevel })
        }
      >
        {t(`${PREFIX}.proceed`)}
      </Button>
    </div>
  );
};

/** Which of a provider's models the model engine will start on (the first until another is picked), and Proceed. */
const ProviderModelPicker: React.FC<{
  engine: ManagedAgent;
  entry: SwitchTargets['providers'][number];
  busy: boolean;
  onProceed: (target: SwitchTarget) => void;
}> = ({ engine, entry, busy, onProceed }) => {
  const { t } = useTranslation();
  const { provider, models } = entry;
  // Only the models a switch can move to (the chat's current one is left out).
  const modelList = [{ ...provider, models }];
  const [picked, setPicked] = useState<TProviderWithModel>({ ...provider, use_model: models[0] } as TProviderWithModel);
  return (
    <div className='flex flex-wrap items-center gap-6px'>
      <GuidModelSelector
        isGeminiMode
        modelList={modelList}
        current_model={picked}
        setCurrentModel={async (model) => setPicked(model)}
        currentAcpCachedModelInfo={null}
        selectedAcpModel={null}
        setSelectedAcpModel={() => {}}
      />
      <Button
        size='mini'
        type='primary'
        loading={busy}
        onClick={() => onProceed({ kind: 'model', engine, provider, model: picked.use_model })}
      >
        {t(`${PREFIX}.proceed`)}
      </Button>
    </div>
  );
};

/**
 * Where the chat can continue: shown on an error whose resolution is `switch_engine` (a usage limit, exhausted credits
 * or quota), on the near-limit warning and from the chat header. One button per other connected engine and one per
 * configured provider; picking one shows the model (and thinking level) it will start on, and Proceed moves this bot
 * (only) there and continues in a new chat. Without any alternative it shows the backup notice, which points to the settings
 * page that adds one.
 */
const LimitSwitchActions: React.FC<{ conversationId: string; reason?: SwitchReason; onSwitched?: () => void }> = ({
  conversationId,
  reason = 'limitHit',
  onSwitched,
}) => {
  const { t, i18n } = useTranslation();
  const { openConversation, openPage } = useChatNavigation();
  const labels = useHandoffLabels(reason);
  const [busy, setBusy] = useState(false);
  const [pickedId, setPickedId] = useState<string | null>(null);
  const { data: conversation } = useSWR(`conversation/${conversationId}`, () => getConversationOrNull(conversationId));
  const { data: engines } = useSWR<ManagedAgent[]>(ENGINE_CATALOG_SWR_KEY, fetchManagedAgentsOrThrow);
  const { providers, getAvailableModels } = useModelProviderList();
  const usage = useAllSubscriptionUsage();
  const { data: signedIn } = useSWR(ENGINE_ACCOUNT_STATUS_SWR_KEY, fetchEngineAccountSignedIn);

  if (!conversation || !engines) return null;

  const targets = listSwitchTargets({ conversation, engines, providers, getAvailableModels, usage });
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

  // An engine still at its own plan limit is shown but cannot be picked until it resets.
  const limitedTooltip = (engine: ManagedAgent): string | null => {
    if (!(engine.id in targets.limitedUntil)) return null;
    const until = targets.limitedUntil[engine.id];
    return until === null
      ? t(`${PREFIX}.targetLimited`, { engine: engineName(engine) })
      : t(`${PREFIX}.targetLimitedUntil`, { engine: engineName(engine), time: formatResetTime(until, i18n.language) });
  };

  // An engine account never signed in fails its first message ("Not logged in"), so it waits for Settings -> Agent.
  const notSignedIn = (engine: ManagedAgent): boolean => signedIn?.[engine.id] === false;

  const run = async (target: SwitchTarget): Promise<void> => {
    if (busy) return;
    setBusy(true);
    try {
      const id = await switchAndContinue({ conversationId, target, labels });
      await swrMutate('assistants.list');
      // The bot was re-pinned: windows with their own caches (robots, main) reload it.
      afterAssistantsChanged();
      onSwitched?.();
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

  const choice = (id: string, label: string, tooltip: string, limited = false) => (
    <Tooltip key={id} content={tooltip}>
      <Button
        size='mini'
        type={pickedId === id ? 'primary' : 'secondary'}
        aria-pressed={pickedId === id}
        disabled={busy || limited}
        onClick={() => setPickedId(id)}
      >
        {label}
      </Button>
    </Tooltip>
  );
  const providerChoiceId = (provider: IProvider): string => `provider:${provider.id}`;
  const pickedEngine = targets.engines.find((engine) => engine.id === pickedId);
  const pickedProvider = targets.providers.find(({ provider }) => providerChoiceId(provider) === pickedId);

  return (
    <div className='flex flex-col gap-6px'>
      <div className='text-t-secondary text-12px'>
        {t(reason === 'manual' ? `${PREFIX}.titleManual` : `${PREFIX}.title`)}
      </div>
      <div className='flex flex-wrap gap-6px'>
        {targets.engines.map((engine) => {
          if (notSignedIn(engine)) {
            const label = `${engineName(engine)} · ${t(`${PREFIX}.notSignedIn`)}`;
            return choice(engine.id, label, t(`${PREFIX}.notSignedInTooltip`), true);
          }
          const limited = limitedTooltip(engine);
          return choice(engine.id, engineName(engine), limited ?? tooltipFor(engine, false), limited !== null);
        })}
        {modelEngine &&
          targets.providers.map(({ provider }) =>
            choice(providerChoiceId(provider), provider.name, tooltipFor(modelEngine, true))
          )}
      </div>
      {/* Keyed by choice, so a newly picked one starts from its own defaults. */}
      {pickedEngine && <EnginePicker key={pickedEngine.id} engine={pickedEngine} busy={busy} onProceed={run} />}
      {modelEngine && pickedProvider && (
        <ProviderModelPicker
          key={pickedProvider.provider.id}
          engine={modelEngine}
          entry={pickedProvider}
          busy={busy}
          onProceed={run}
        />
      )}
    </div>
  );
};

export default LimitSwitchActions;
