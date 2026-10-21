/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * "Switch and continue" after a usage limit: re-pin only this bot, start the new chat with fresh built-in MCPs,
 * stash the handoff as its first message, and undo the pin when the chat cannot be made.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TChatConversation } from '@/common/config/storage';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';

const mocks = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    store,
    configService: {
      isInitialized: () => true,
      get: (key: string) => store.get(key),
      set: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
      subscribe: () => () => {},
      reload: vi.fn(async () => {}),
    },
    getConversation: vi.fn(),
    clone: vi.fn(),
    getMessages: vi.fn(),
    getAssistant: vi.fn(),
    listAssistants: vi.fn(),
    clientSetting: vi.fn(),
    updateAssistant: vi.fn(),
    catalog: vi.fn(),
    emit: vi.fn(),
    send: vi.fn(),
    remove: vi.fn(),
    runtimeMode: vi.fn(),
  };
});

vi.mock('@/common/config/configService', () => ({ configService: mocks.configService }));
vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      get: { invoke: mocks.getConversation },
      createWithConversation: { invoke: mocks.clone },
      sendMessage: { invoke: mocks.send },
      remove: { invoke: mocks.remove },
      runtimeMode: { invoke: mocks.runtimeMode },
    },
    database: { getConversationMessages: { invoke: mocks.getMessages } },
    assistants: {
      get: { invoke: mocks.getAssistant },
      update: { invoke: mocks.updateAssistant },
      list: { invoke: mocks.listAssistants },
    },
  },
}));
vi.mock('@/renderer/hooks/mcp/catalog', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/hooks/mcp/catalog')>()),
  ensureBackendMcpCatalog: mocks.catalog,
}));
vi.mock('@/renderer/services/clientBusinessSettings', () => ({ getClientBusinessSetting: mocks.clientSetting }));
vi.mock('@/renderer/utils/emitter', () => ({ emitter: { emit: mocks.emit } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { switchAndContinue } from '@/renderer/pages/conversation/components/limitSwitch/switchAndContinue';
import { HANDOFF_TAG, type HandoffLabels } from '@/renderer/pages/conversation/components/limitSwitch/handoffMessage';

const labels: HandoffLabels = {
  header: 'HEADER',
  dataOnly: 'DATA',
  quoteStart: 'START',
  quoteEnd: 'END',
  user: 'User',
  assistant: 'Assistant',
  lastRequest: 'LAST',
  closing: 'CLOSING',
};

const BROWSER = {
  id: 'b-browser',
  name: 'aionui-browser',
  builtin: true,
  enabled: true,
  transport: { type: 'stdio', command: 'node', args: ['fresh.js'] },
};
const ARTIFACTS = { ...BROWSER, id: 'b-artifacts', name: 'aionui-artifacts' };
const NOTES = { ...BROWSER, id: 'b-notes', name: 'aionui-notes' };
const freshMcps = [BROWSER, ARTIFACTS, NOTES].map(({ id, name, transport }) => ({ id, name, transport }));

const SOURCE = {
  id: 'c1',
  name: 'Trip',
  type: 'acp',
  assistant: { id: 'bot-1', source: 'user', name: 'Travel Bot', avatar: '', backend: 'claude' },
  extra: {
    backend: 'claude',
    agent_id: 'claude',
    session_mode: 'plan',
    current_model_id: 'opus',
    workspace: '/work',
    preset_assistant_id: 'bot-1',
    session_mcp_servers: [{ ...freshMcps[0], transport: { type: 'stdio', command: 'stale' } }],
  },
  created_at: 1,
  modified_at: 1,
} as unknown as TChatConversation;

const CODEX = { id: 'codex', name: 'Codex', agent_type: 'acp', backend: 'codex' } as ManagedAgent;
const AIONRS = { id: 'aionrs', name: 'Aion', agent_type: 'aionrs', backend: 'aionrs' } as ManagedAgent;

const DETAIL = {
  id: 'bot-1',
  engine: { agent_id: 'claude' },
  defaults: {
    model: { mode: 'fixed', value: 'opus' },
    permission: { mode: 'fixed', value: 'plan' },
    thought_level: { mode: 'auto' },
  },
};

const sent = () =>
  mocks.clone.mock.calls[0][0].conversation as Record<string, unknown> & { extra: Record<string, unknown> };

beforeEach(() => {
  mocks.store.clear();
  mocks.store.set('agent.enginePins', { 'bot-1': 'claude', other: 'x' });
  mocks.store.set('agent.defaultAgentId', 'claude');
  mocks.store.set('agent.builtinDefaultId', 'aion-default-agent');
  sessionStorage.clear();
  mocks.getConversation.mockResolvedValue(SOURCE);
  mocks.getMessages.mockResolvedValue({
    items: [
      { id: 'u1', type: 'text', position: 'right', conversation_id: 'c1', content: { content: 'plan my trip' } },
      { id: 't1', type: 'tool_call', position: 'left', conversation_id: 'c1', content: {} },
    ],
  });
  mocks.getAssistant.mockResolvedValue(DETAIL);
  mocks.updateAssistant.mockResolvedValue({});
  mocks.catalog.mockResolvedValue({ allServers: [BROWSER, ARTIFACTS, NOTES], userServers: [], builtinServers: [] });
  mocks.clone.mockResolvedValue({ id: 'c2' });
  mocks.runtimeMode.mockResolvedValue({ mode: null, live: false });
  mocks.clientSetting.mockResolvedValue([BROWSER, ARTIFACTS, NOTES]);
  mocks.listAssistants.mockResolvedValue([
    { id: 'bot-1', source: 'user', name: 'Travel Bot', agent_id: 'claude' },
    {
      id: 'bare:claude',
      source: 'generated',
      name: 'Claude',
      avatar: '🤖',
      agent_id: 'claude',
      agent: { type: 'acp', acp_backend: 'claude' },
    },
    {
      id: 'bare:codex',
      source: 'generated',
      name: 'Codex',
      avatar: '🧠',
      agent_id: 'codex',
      agent: { type: 'acp', acp_backend: 'codex' },
    },
  ]);
});

afterEach(() => vi.clearAllMocks());

describe('switchAndContinue', () => {
  it('pins only this bot to the new engine and never touches the default engine', async () => {
    const id = await switchAndContinue({ conversationId: 'c1', target: { kind: 'engine', engine: CODEX }, labels });

    expect(id).toBe('c2');
    expect(mocks.store.get('agent.enginePins')).toEqual({ 'bot-1': 'codex', other: 'x' });
    expect(mocks.store.get('agent.enginePinOrigins')).toEqual({ 'bot-1': 'limit' });
    expect(mocks.store.get('agent.defaultAgentId')).toBe('claude');
    expect(mocks.configService.set).not.toHaveBeenCalledWith('agent.defaultAgentId', expect.anything());
    expect(mocks.updateAssistant).toHaveBeenCalledWith({
      id: 'bot-1',
      agent_id: 'codex',
      defaults: { model: { mode: 'auto' }, permission: { mode: 'auto' }, thought_level: { mode: 'auto' } },
    });
  });

  it('creates the chat with the same bot, fresh built-in MCPs and no settings of the old engine', async () => {
    await switchAndContinue({ conversationId: 'c1', target: { kind: 'engine', engine: CODEX }, labels });

    const conversation = sent();
    expect(conversation).toMatchObject({ type: 'acp', assistant: { id: 'bot-1' } });
    expect(conversation.model).toBeUndefined();
    expect(conversation.extra).toEqual({
      workspace: '/work',
      preset_assistant_id: 'bot-1',
      selected_session_mcp_servers: freshMcps,
    });
  });

  it('stashes the handoff as the first ACP message', async () => {
    await switchAndContinue({ conversationId: 'c1', target: { kind: 'engine', engine: CODEX }, labels });

    const stored = JSON.parse(sessionStorage.getItem('acp_initial_message_c2') ?? 'null');
    expect(stored.input).toBe(
      [
        HANDOFF_TAG,
        'HEADER',
        'DATA',
        '',
        'START',
        '> User: plan my trip',
        'END',
        '',
        'LAST',
        'plan my trip',
        '',
        'CLOSING',
      ].join('\n')
    );
    expect(mocks.getMessages).toHaveBeenCalledWith(
      expect.objectContaining({ conversation_id: 'c1', content_mode: 'full' })
    );
  });

  it('moves to a provider model on the model engine and stashes an aionrs first message', async () => {
    const provider = {
      id: 'openrouter',
      name: 'OpenRouter',
      platform: 'custom',
      base_url: 'u',
      api_key: 'k',
      models: ['a', 'b'],
    };
    await switchAndContinue({
      conversationId: 'c1',
      target: { kind: 'model', engine: AIONRS, provider, model: 'b' } as never,
      labels,
    });

    expect(mocks.store.get('agent.enginePins')).toMatchObject({ 'bot-1': 'aionrs' });
    expect(sent()).toMatchObject({
      type: 'aionrs',
      model: { id: 'openrouter', name: 'OpenRouter', use_model: 'b' },
    });
    expect(sent().model).not.toHaveProperty('models');
    expect(sessionStorage.getItem('aionrs_initial_message_c2')).toContain('plan my trip');
  });

  it('pins the default Agent like any bot, so the new chat keeps its rules, notes and skills', async () => {
    mocks.store.set('agent.enginePins', {});
    mocks.getConversation.mockResolvedValue({
      ...SOURCE,
      assistant: { ...SOURCE.assistant, id: 'aion-default-agent', name: 'Agent' },
    });
    mocks.getAssistant.mockResolvedValue({ ...DETAIL, id: 'aion-default-agent' });

    await switchAndContinue({ conversationId: 'c1', target: { kind: 'engine', engine: CODEX }, labels });

    expect(mocks.store.get('agent.enginePins')).toEqual({ 'aion-default-agent': 'codex' });
    expect(mocks.store.get('agent.defaultAgentId')).toBe('claude');
    expect(mocks.updateAssistant).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'aion-default-agent', agent_id: 'codex' })
    );
    expect(sent().assistant).toMatchObject({ id: 'aion-default-agent' });
  });

  it("continues an engine chat on the target engine's own entry, pinning nothing", async () => {
    mocks.getConversation.mockResolvedValue({
      ...SOURCE,
      assistant: { id: 'bare:claude', source: 'generated', name: 'Claude', avatar: '🤖', backend: 'claude' },
      extra: { ...SOURCE.extra, preset_assistant_id: 'bare:claude' },
    });

    await switchAndContinue({ conversationId: 'c1', target: { kind: 'engine', engine: CODEX }, labels });

    expect(mocks.updateAssistant).not.toHaveBeenCalled();
    expect(mocks.store.get('agent.enginePins')).toEqual({ 'bot-1': 'claude', other: 'x' });
    expect(sent().assistant).toEqual({
      id: 'bare:codex',
      source: 'generated',
      name: 'Codex',
      avatar: '🧠',
      backend: 'codex',
    });
    expect(sent().extra).not.toHaveProperty('preset_assistant_id');
    expect(sessionStorage.getItem('acp_initial_message_c2')).toContain('plan my trip');
  });

  it('refuses an engine chat switch when the target engine has no entry, creating nothing', async () => {
    mocks.getConversation.mockResolvedValue({
      ...SOURCE,
      assistant: { id: 'bare:claude', source: 'generated', name: 'Claude', avatar: '', backend: 'claude' },
    });
    mocks.listAssistants.mockResolvedValue([]);

    await expect(
      switchAndContinue({ conversationId: 'c1', target: { kind: 'engine', engine: CODEX }, labels })
    ).rejects.toThrow(/codex/);
    expect(mocks.clone).not.toHaveBeenCalled();
  });

  it('still creates the chat with the built-in MCPs when the MCP list cannot be fetched', async () => {
    mocks.catalog.mockRejectedValue(new Error('mcp list down'));
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});

    await switchAndContinue({ conversationId: 'c1', target: { kind: 'engine', engine: CODEX }, labels });

    expect(sent().extra.selected_session_mcp_servers).toEqual(freshMcps);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it('rolls the pin back and stashes nothing when the chat cannot be created', async () => {
    mocks.clone.mockRejectedValue(new Error('boom'));

    await expect(
      switchAndContinue({ conversationId: 'c1', target: { kind: 'engine', engine: CODEX }, labels })
    ).rejects.toThrow('boom');

    expect(mocks.store.get('agent.enginePins')).toEqual({ 'bot-1': 'claude', other: 'x' });
    expect(mocks.store.get('agent.enginePinOrigins')).toEqual({});
    expect(mocks.updateAssistant).toHaveBeenLastCalledWith({
      id: 'bot-1',
      agent_id: 'claude',
      defaults: DETAIL.defaults,
    });
    expect(sessionStorage.length).toBe(0);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  describe('when the handoff cannot be stashed (M7)', () => {
    const stashFails = () =>
      vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
        throw new DOMException('full', 'QuotaExceededError');
      });

    it('sends it to the new chat right away and keeps the pin', async () => {
      const setItem = stashFails();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mocks.send.mockResolvedValue({});

      const id = await switchAndContinue({ conversationId: 'c1', target: { kind: 'engine', engine: CODEX }, labels });

      expect(id).toBe('c2');
      expect(mocks.send).toHaveBeenCalledWith({
        input: expect.stringContaining('> User: plan my trip'),
        conversation_id: 'c2',
        files: [],
      });
      expect(mocks.store.get('agent.enginePins')).toEqual({ 'bot-1': 'codex', other: 'x' });
      expect(mocks.remove).not.toHaveBeenCalled();
      setItem.mockRestore();
      warn.mockRestore();
    });

    it('removes the new chat and rolls the pin back when the send fails too: no empty chat is left', async () => {
      const setItem = stashFails();
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mocks.send.mockRejectedValue(new Error('send down'));
      mocks.remove.mockResolvedValue(true);

      await expect(
        switchAndContinue({ conversationId: 'c1', target: { kind: 'engine', engine: CODEX }, labels })
      ).rejects.toThrow('send down');

      expect(mocks.remove).toHaveBeenCalledWith({ id: 'c2' });
      expect(mocks.store.get('agent.enginePins')).toEqual({ 'bot-1': 'claude', other: 'x' });
      setItem.mockRestore();
      warn.mockRestore();
    });
  });

  describe('from a chat in a bypass mode (M5)', () => {
    const CODEX_YOLO = { ...CODEX, yolo_id: 'agent-full-access' } as ManagedAgent;
    const YOLO_PERMISSION = { mode: 'fixed', value: 'yolo' };

    it('keeps the new chat and the bot in bypass mode, with the alias the backend maps per engine', async () => {
      mocks.runtimeMode.mockResolvedValue({ mode: 'bypassPermissions', live: true });

      await switchAndContinue({ conversationId: 'c1', target: { kind: 'engine', engine: CODEX_YOLO }, labels });

      expect(mocks.runtimeMode).toHaveBeenCalledWith({ conversation_id: 'c1' });
      expect(mocks.updateAssistant).toHaveBeenCalledWith({
        id: 'bot-1',
        agent_id: 'codex',
        defaults: { model: { mode: 'auto' }, permission: YOLO_PERMISSION, thought_level: { mode: 'auto' } },
      });
      expect(sent().extra.session_mode).toBe('yolo');
      expect(sent().assistant).toMatchObject({ id: 'bot-1', conversation_overrides: { permission: 'yolo' } });
    });

    it('reads the stored mode when the chat has no live runtime', async () => {
      mocks.getConversation.mockResolvedValue({ ...SOURCE, extra: { ...SOURCE.extra, session_mode: 'yolo' } });

      await switchAndContinue({ conversationId: 'c1', target: { kind: 'engine', engine: CODEX_YOLO }, labels });

      expect(sent().extra.session_mode).toBe('yolo');
    });

    it('trusts the live mode over a stale stored one', async () => {
      mocks.getConversation.mockResolvedValue({
        ...SOURCE,
        extra: { ...SOURCE.extra, session_mode: 'bypassPermissions' },
      });
      mocks.runtimeMode.mockResolvedValue({ mode: 'default', live: true });

      await switchAndContinue({ conversationId: 'c1', target: { kind: 'engine', engine: CODEX_YOLO }, labels });

      expect(sent().extra).not.toHaveProperty('session_mode');
      expect(mocks.updateAssistant.mock.calls[0][0].defaults.permission).toEqual({ mode: 'auto' });
    });

    it('starts a target engine with no bypass mode on its defaults', async () => {
      mocks.runtimeMode.mockResolvedValue({ mode: 'bypassPermissions', live: true });

      for (const engine of [CODEX, { ...CODEX, yolo_id: 'build' } as ManagedAgent]) {
        mocks.clone.mockClear();
        mocks.updateAssistant.mockClear();
        await switchAndContinue({ conversationId: 'c1', target: { kind: 'engine', engine }, labels });

        expect(sent().extra).not.toHaveProperty('session_mode');
        expect(sent().assistant).not.toHaveProperty('conversation_overrides');
        expect(mocks.updateAssistant.mock.calls[0][0].defaults.permission).toEqual({ mode: 'auto' });
      }
    });

    it("moves an engine chat to the target's entry in bypass mode", async () => {
      mocks.getConversation.mockResolvedValue({
        ...SOURCE,
        assistant: { id: 'bare:claude', source: 'generated', name: 'Claude', avatar: '🤖', backend: 'claude' },
        extra: { ...SOURCE.extra, preset_assistant_id: 'bare:claude' },
      });
      mocks.runtimeMode.mockResolvedValue({ mode: 'bypassPermissions', live: true });

      await switchAndContinue({ conversationId: 'c1', target: { kind: 'engine', engine: CODEX_YOLO }, labels });

      expect(mocks.updateAssistant).not.toHaveBeenCalled();
      expect(sent().extra.session_mode).toBe('yolo');
      expect(sent().assistant).toMatchObject({ id: 'bare:codex', conversation_overrides: { permission: 'yolo' } });
    });

    it('asks nothing of a failed mode lookup and falls back to the stored mode', async () => {
      mocks.runtimeMode.mockRejectedValue(new Error('offline'));

      await switchAndContinue({ conversationId: 'c1', target: { kind: 'engine', engine: CODEX_YOLO }, labels });

      expect(sent().extra).not.toHaveProperty('session_mode');
    });
  });
});
