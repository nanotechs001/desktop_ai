/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MemoryVaultRef } from '@/common/types/agent/memory';
import { Tabs } from '@arco-design/web-react';
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SectionCard } from '../editorSectionPrimitives';
import { SHARED_VAULT } from './memoryLabels';
import MemoryVaultView from './MemoryVaultView';

type MemoryPanelProps = {
  agentId: string;
};

/**
 * The Agent's long-term memory in its editor: what this Agent remembers for its own work, and what every agent knows
 * about the user. Each has pinned facts (always in the rule) and notes the agent searches while it works.
 */
const MemoryPanel: React.FC<MemoryPanelProps> = ({ agentId }) => {
  const { t } = useTranslation();
  const [tab, setTab] = useState<MemoryVaultRef['kind']>('agent');
  const agentVault = useMemo<MemoryVaultRef>(() => ({ kind: 'agent', agentId }), [agentId]);

  return (
    <SectionCard title={t('agent.memory.title')} testId='assistant-card-memory'>
      <div className='mb-8px text-12px leading-18px text-t-tertiary'>{t('agent.memory.hint')}</div>
      <Tabs activeTab={tab} onChange={(key) => setTab(key as MemoryVaultRef['kind'])} destroyOnHide>
        <Tabs.TabPane key='agent' title={t('agent.memory.tabs.agent')}>
          <MemoryVaultView vault={agentVault} />
        </Tabs.TabPane>
        <Tabs.TabPane key='shared' title={t('agent.memory.tabs.shared')}>
          <MemoryVaultView vault={SHARED_VAULT} />
        </Tabs.TabPane>
      </Tabs>
    </SectionCard>
  );
};

export default MemoryPanel;
