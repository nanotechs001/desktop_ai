/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { TFunction } from 'i18next';
import { describe, expect, it } from 'vitest';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { ICronJob } from '@/common/adapter/ipcBridge';
import { getJobAgentMeta } from '@/renderer/pages/cron/ScheduledTasksPage/jobAgentMeta';

const t = ((key: string) => (key === 'agent.displayName' ? 'Agent' : key)) as TFunction;

describe('getJobAgentMeta', () => {
  it('prefers assistant catalog metadata for assistant-backed jobs', () => {
    const meta = getJobAgentMeta(
      cronJob({
        metadata: {
          agent_type: 'acp',
          agent_config: {
            assistant_id: 'assistant-1',
            name: 'Legacy name',
          },
        },
      }),
      [
        assistant({
          id: 'assistant-1',
          name: '文件规划助手',
          avatar: '🤖',
        }),
      ],
      t
    );

    expect(meta).toEqual({
      name: '文件规划助手',
      emoji: '🤖',
    });
  });

  it('names a legacy job "Agent" with the robot icon, not the engine behind it', () => {
    for (const agent_type of ['acp', 'codex', 'cli:claude']) {
      const meta = getJobAgentMeta(
        cronJob({ metadata: { agent_type, agent_config: { name: 'Codex 助手' } } as ICronJob['metadata'] }),
        [],
        t
      );

      expect(meta).toEqual({ name: 'Agent', assistantFallback: true });
    }
  });

  it('ignores legacy custom_agent_id rows without assistant_id', () => {
    const meta = getJobAgentMeta(
      cronJob({
        metadata: {
          agent_type: 'acp',
          agent_config: { custom_agent_id: 'assistant-1', name: 'Legacy name' },
        },
      }),
      [assistant({ id: 'assistant-1', name: '文件规划助手', avatar: '🤖' })],
      t
    );

    expect(meta).toEqual({ name: 'Agent', assistantFallback: true });
  });

  it('uses the neutral Agent when assistant_id is present but the assistant is missing', () => {
    const meta = getJobAgentMeta(
      cronJob({
        metadata: {
          agent_type: 'acp',
          agent_config: { assistant_id: 'missing-assistant', name: 'Legacy name' },
        },
      }),
      [],
      t
    );

    expect(meta).toEqual({ name: 'Agent', assistantFallback: true });
  });
});

function cronJob(overrides: Partial<ICronJob>): ICronJob {
  return {
    id: 'job-1',
    name: 'Job',
    description: '',
    enabled: true,
    schedule: { kind: 'cron', expr: '0 * * * *' },
    timezone: 'UTC',
    target: { execution_mode: 'new_conversation', payload: { text: 'hi' } },
    state: {},
    metadata: {
      agent_type: 'acp',
      agent_config: {},
      team_id: undefined,
      task_type: 'conversation',
    },
    ...overrides,
  };
}

function assistant(overrides: Partial<Assistant> & Pick<Assistant, 'id' | 'name'>): Assistant {
  return {
    id: overrides.id,
    source: 'builtin',
    name: overrides.name,
    name_i18n: {},
    description_i18n: {},
    enabled: true,
    sort_order: 1,
    agent_id: 'agent-codex',
    agent: { type: 'acp', source: 'builtin', acp_backend: 'codex' },
    enabled_skills: [],
    custom_skill_names: [],
    disabled_builtin_skills: [],
    context_i18n: {},
    prompts: [],
    prompts_i18n: {},
    models: [],
    ...overrides,
  };
}
