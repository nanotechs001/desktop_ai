/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import { useConfig } from '@/renderer/hooks/config/useConfig';
import {
  ENGINE_CATALOG_SWR_KEY,
  fetchManagedAgentsOrThrow,
  type ManagedAgent,
} from '@/renderer/utils/model/agentTypes';

/**
 * Which engine runs an Agent, as text only: "Engine: <name>" when the Agent is pinned to an engine
 * (or is a bare CLI entry), "Engine: Use default" when it follows the default. Never a vendor logo.
 */
const RuntimeBadge: React.FC<{ assistant: Assistant; framed?: boolean }> = ({ assistant, framed = false }) => {
  const { t, i18n } = useTranslation();
  const { data: engines } = useSWR<ManagedAgent[]>(ENGINE_CATALOG_SWR_KEY, fetchManagedAgentsOrThrow);
  const [pins] = useConfig('agent.enginePins');

  // Generated entries are an engine's own CLI and never follow the default.
  const engineId = pins?.[assistant.id] ?? (assistant.source === 'generated' ? assistant.agent_id : undefined);
  const engine = engineId ? engines?.find((candidate) => candidate.id === engineId) : undefined;
  const label = t('agent.engine.label');
  const detail = engineId ? engine?.name_i18n?.[i18n.language] || engine?.name : t('agent.engine.useDefault');

  return (
    <span
      className={
        framed
          ? 'inline-flex items-center rounded-8px border border-solid border-arco-2 bg-fill-1 px-8px py-4px text-11px text-t-tertiary'
          : 'inline-flex items-center text-11px text-t-tertiary'
      }
      data-testid={`assistant-runtime-${assistant.id}`}
    >
      <span className='max-w-160px truncate'>{detail ? `${label}: ${detail}` : label}</span>
    </span>
  );
};

export default RuntimeBadge;
