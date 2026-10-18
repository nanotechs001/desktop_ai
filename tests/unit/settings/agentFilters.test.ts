/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  filterAgentsByAvailability,
  getAgentAvailabilityFilterStats,
  isBuiltinAionCli,
  type AgentAvailabilityFilter,
} from '@/renderer/pages/settings/AgentSettings/agentFilters';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';

const agent = (id: string, status: ManagedAgent['status']): ManagedAgent =>
  ({
    id,
    name: id,
    agent_type: 'acp',
    agent_source: 'builtin',
    enabled: true,
    installed: status !== 'missing',
    status,
  }) as ManagedAgent;

describe('agent availability filters', () => {
  const agents = [agent('a', 'offline'), agent('b', 'online'), agent('c', 'missing'), agent('d', 'online')];

  it('counts available and unavailable agents', () => {
    expect(getAgentAvailabilityFilterStats(agents)).toEqual({
      available: 2,
      unavailable: 2,
    });
  });

  it.each<[AgentAvailabilityFilter, string[]]>([
    ['available', ['b', 'd']],
    ['unavailable', ['a', 'c']],
  ])('filters %s agents without changing relative order', (filter, expectedIds) => {
    expect(filterAgentsByAvailability(agents, filter).map((item) => item.id)).toEqual(expectedIds);
  });

  it('recognizes only the internal aionrs engine as the built-in CLI', () => {
    expect(isBuiltinAionCli({ agent_type: 'aionrs', agent_source: 'internal' })).toBe(true);
    expect(isBuiltinAionCli({ agent_type: 'aionrs', agent_source: 'custom' })).toBe(false);
    expect(isBuiltinAionCli({ agent_type: 'acp', agent_source: 'internal' })).toBe(false);
  });
});
