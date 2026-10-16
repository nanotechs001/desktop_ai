/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The Butler (`aionui-assistant`) stays in the backend catalog but is never offered as an Agent.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const catalog = vi.hoisted(() => ({
  items: [] as Array<{ id: string; name: string }>,
}));

vi.mock('@/common/platform/bridge', () => ({
  bridge: {
    buildProvider: vi.fn(() => ({ provider: vi.fn(), invoke: vi.fn() })),
    buildEmitter: vi.fn(() => ({ on: vi.fn(() => vi.fn()), emit: vi.fn() })),
  },
}));

vi.mock('@/common/adapter/httpBridge', () => {
  const emitter = () => ({ on: vi.fn(() => vi.fn()), emit: vi.fn() });
  const provider = (path?: unknown) => ({
    provider: vi.fn(),
    invoke: vi.fn(async () => (path === '/api/assistants' ? catalog.items : undefined)),
  });
  return {
    httpGet: provider,
    httpPost: () => provider(),
    httpPut: () => provider(),
    httpPatch: () => provider(),
    httpDelete: () => provider(),
    httpRequest: vi.fn(),
    getBaseUrl: vi.fn(() => ''),
    stubProvider: vi.fn(() => provider()),
    withResponseMap: vi.fn((inner: unknown) => inner),
    wsEmitter: vi.fn(emitter),
    wsMappedEmitter: vi.fn(emitter),
    stubEmitter: vi.fn(emitter),
  };
});

import { HIDDEN_AGENT_IDS, isHiddenAgentId, withoutHiddenAgents } from '@/common/types/agent/hiddenAgents';

describe('hidden Agents', () => {
  it('hides the Butler with or without the builtin- prefix', () => {
    expect(HIDDEN_AGENT_IDS.has('aionui-assistant')).toBe(true);
    expect(isHiddenAgentId('aionui-assistant')).toBe(true);
    expect(isHiddenAgentId('builtin-aionui-assistant')).toBe(true);
  });

  it.each([null, undefined, '', 'aion-default-agent', 'builtin-writer'])('keeps %j', (id) => {
    expect(isHiddenAgentId(id)).toBe(false);
  });

  it('withoutHiddenAgents returns a new list without the hidden ids', () => {
    const input = [{ id: 'a' }, { id: 'aionui-assistant' }, { id: 'b' }];
    const output = withoutHiddenAgents(input);

    expect(output).toEqual([{ id: 'a' }, { id: 'b' }]);
    expect(input).toHaveLength(3);
  });
});

describe('ipcBridge.assistants.list', () => {
  beforeEach(() => {
    catalog.items = [
      { id: 'builtin-aionui-assistant', name: 'AionUi Butler' },
      { id: 'aionui-assistant', name: 'AionUi Butler' },
      { id: 'aion-default-agent', name: 'Agent' },
      { id: 'my-writer', name: 'Writer' },
    ];
  });

  it('drops the Butler from the list every Agent picker reads', async () => {
    const { assistants } = await import('@/common/adapter/ipcBridge');
    const list = await assistants.list.invoke();

    expect(list.map((item) => item.id)).toEqual(['aion-default-agent', 'my-writer']);
  });
});
