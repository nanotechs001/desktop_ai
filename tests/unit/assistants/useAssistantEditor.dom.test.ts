/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for renderer/hooks/assistant/useAssistantEditor.ts (A2 in N4a).
 * Tests useAssistantEditor hook: core form state management and save/create/delete flows.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act, waitFor } from '@testing-library/react';

// Mock @/common
vi.mock('@/common', () => ({
  ipcBridge: {
    assistants: {
      get: { invoke: vi.fn() },
      create: { invoke: vi.fn() },
      update: { invoke: vi.fn() },
      delete: { invoke: vi.fn() },
      setState: { invoke: vi.fn() },
    },
    mcpService: {
      listServers: { invoke: vi.fn() },
    },
    fs: {
      readAssistantRule: { invoke: vi.fn() },
      listAvailableSkills: { invoke: vi.fn() },
      writeAssistantRule: { invoke: vi.fn() },
      deleteAssistantRule: { invoke: vi.fn() },
      importSkills: { invoke: vi.fn() },
    },
    browser: { deleteProfileData: { invoke: vi.fn(async () => ({ success: true })) } },
    // Deleting a bot also removes its chats, robots, tasks and channel bindings; by default it owns none.
    database: { getUserConversations: { invoke: vi.fn(async () => ({ items: [], total: 0, has_more: false })) } },
    sidebar: {
      get: { invoke: vi.fn(async () => ({ groups: [], has_more_groups: false })) },
      items: { invoke: vi.fn() },
    },
    conversation: { remove: { invoke: vi.fn(async () => true) } },
    agentWidget: { remove: { invoke: vi.fn(async () => undefined) }, listRobots: { invoke: vi.fn(async () => []) } },
    cron: { listJobs: { invoke: vi.fn(async () => []) }, removeJob: { invoke: vi.fn(async () => undefined) } },
    channel: {
      getPlatformSettings: { invoke: vi.fn(async () => ({ platform: 'x', assistant: null, default_model: null })) },
      syncChannelSettings: { invoke: vi.fn(async () => undefined) },
    },
    agentNotes: { removeAgent: { invoke: vi.fn(async () => ({ success: true })) } },
    // The rule is saved through main, which adds the managed blocks.
    agentBrowser: {
      ensureAgentRule: { invoke: vi.fn(async () => ({ success: true })) },
    },
  },
}));

const engineConfig = vi.hoisted(() => {
  const store = new Map<string, unknown>();
  return {
    store,
    configService: {
      get: (key: string) => store.get(key),
      set: vi.fn(async (key: string, value: unknown) => {
        store.set(key, value);
      }),
      reload: vi.fn(async () => {}),
    },
  };
});
vi.mock('@/common/config/configService', () => ({ configService: engineConfig.configService }));

// Mock react-i18next
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string) => k,
    i18n: { language: 'en' },
  }),
}));

vi.mock('swr', () => ({
  mutate: vi.fn(),
}));

const router = vi.hoisted(() => ({ navigate: vi.fn(), openChatId: undefined as string | undefined }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => router.navigate,
  useMatch: () => (router.openChatId ? { params: { id: router.openChatId } } : null),
}));

vi.mock('@/renderer/hooks/mcp/catalog', () => ({
  ensureBackendMcpCatalog: vi.fn(async () => ({
    userServers: [{ id: 'mcp-a', name: 'Server A', enabled: true }],
    builtinServers: [],
    allServers: [{ id: 'mcp-a', name: 'Server A', enabled: true }],
  })),
}));

import { useAssistantEditor } from '@/renderer/hooks/assistant/useAssistantEditor';
import { ipcBridge } from '@/common';
import type { AssistantListItem } from '@/renderer/pages/settings/AssistantSettings/types';
import { mutate as swrMutate } from 'swr';
import { BOT_COLOR_PALETTE } from '@/common/types/agent/botColors';
import { releaseLimitPins } from '@/renderer/hooks/agent/useDefaultEngine';

describe('useAssistantEditor', () => {
  const mockAssistantDetail = {
    id: 'a1',
    source: 'user',
    profile: {
      name: 'TestAssistant',
      name_i18n: {},
      description: 'Test desc',
      description_i18n: {},
      avatar: '🤖',
    },
    state: {
      enabled: true,
      sort_order: 1,
    },
    engine: {
      agent_id: 'agent-claude',
      agent: { type: 'acp', source: 'builtin', acp_backend: 'claude' },
    },
    rules: {
      content: 'Rule content',
      storage_mode: 'user_file',
    },
    prompts: {
      recommended: ['Prompt one', 'Prompt two'],
      recommended_i18n: {},
    },
    defaults: {
      model: { mode: 'fixed', value: 'gemini-2.5-pro' },
      permission: { mode: 'fixed', value: 'acceptEdits' },
      thought_level: { mode: 'fixed', value: 'high' },
      skills: { mode: 'auto', value: ['skill-one'] },
      mcps: { mode: 'fixed', value: ['mcp-a'] },
    },
    capabilities: {
      default_skill_ids: ['skill-one'],
      custom_skill_names: [],
      default_disabled_builtin_skill_ids: [],
    },
    preferences: {
      last_model_id: undefined,
      last_permission_value: undefined,
      last_thought_level_value: undefined,
      last_skill_ids: [],
      last_disabled_builtin_skill_ids: [],
      last_mcp_ids: [],
    },
  } as const;

  const mockMessage = {
    success: vi.fn(),
    error: vi.fn(),
    warning: vi.fn(),
    info: vi.fn(),
  } as any;

  const defaultParams = {
    localeKey: 'en',
    activeAssistant: null,
    setActiveAssistantId: vi.fn(),
    loadAssistants: vi.fn(),
    assistants: [] as AssistantListItem[],
    assistantOrder: [] as string[],
    setAssistantOrder: vi.fn(async () => {}),
    message: mockMessage,
  };

  beforeEach(() => {
    vi.clearAllMocks();
    engineConfig.store.clear();
    (ipcBridge.assistants.get.invoke as any).mockResolvedValue(mockAssistantDetail);
    (ipcBridge.fs.listAvailableSkills.invoke as any).mockResolvedValue([]);
    (ipcBridge.mcpService.listServers.invoke as any).mockResolvedValue([
      { id: 'mcp-a', name: 'Server A', enabled: true },
    ]);
    (ipcBridge.fs.writeAssistantRule.invoke as any).mockResolvedValue(true);
    (ipcBridge.fs.deleteAssistantRule.invoke as any).mockResolvedValue(true);
    (ipcBridge.fs.importSkills.invoke as any).mockResolvedValue(true);
  });

  describe('deleting an Agent', () => {
    const agent: AssistantListItem = { id: 'bare:gone', name: 'Gone', sort_order: 1, source: 'user', enabled: true };
    const ownedChat = (id: string) => ({ id, name: id, assistant: { id: 'bare:gone' } });
    const withChats = (...ids: string[]) =>
      (ipcBridge.database.getUserConversations.invoke as any).mockResolvedValueOnce({
        items: ids.map(ownedChat),
        total: ids.length,
        has_more: false,
      });
    const deleteAgent = async () => {
      const hook = renderHook(() => useAssistantEditor({ ...defaultParams, activeAssistant: agent }));
      await act(async () => {
        await hook.result.current.handleDeleteConfirm();
      });
      return hook;
    };

    beforeEach(() => {
      router.openChatId = undefined;
    });

    it('deletes its browser data before the Agent, always', async () => {
      const order: string[] = [];
      (ipcBridge.assistants.delete.invoke as any).mockImplementation(async () => order.push('agent'));
      (ipcBridge.browser.deleteProfileData.invoke as any).mockImplementation(async () => {
        order.push('browser data');
        return { success: true };
      });

      await deleteAgent();

      expect(ipcBridge.browser.deleteProfileData.invoke).toHaveBeenCalledWith({ agentId: 'bare:gone' });
      expect(order).toEqual(['browser data', 'agent']);
      expect(mockMessage.success).toHaveBeenCalled();
    });

    it('closes the dialog, refreshes the catalog and the chat history once it is all gone', async () => {
      const refreshed = vi.fn();
      const { emitter } = await import('@/renderer/utils/emitter');
      emitter.on('chat.history.refresh', refreshed);
      const loadAssistants = vi.fn();
      const { result } = renderHook(() =>
        useAssistantEditor({ ...defaultParams, loadAssistants, activeAssistant: agent })
      );
      act(() => result.current.setDeleteConfirmVisible(true));

      await act(async () => {
        await result.current.handleDeleteConfirm();
      });

      expect(result.current.deleteConfirmVisible).toBe(false);
      expect(loadAssistants).toHaveBeenCalled();
      expect(refreshed).toHaveBeenCalledTimes(1);
      emitter.off('chat.history.refresh', refreshed);
    });

    it('says the browser data is gone but the Agent is not when only the Agent delete fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      (ipcBridge.assistants.delete.invoke as any).mockRejectedValueOnce(new Error('backend down'));

      await deleteAgent();

      expect(mockMessage.error).toHaveBeenCalledWith('agent.browserProfile.partialDelete');
      expect(mockMessage.success).not.toHaveBeenCalled();
    });

    it('forgets what the Agent learned: its notebook in main and its engine pin', async () => {
      engineConfig.store.set('agent.enginePins', { 'bare:gone': 'engine-x', other: 'engine-y' });
      (ipcBridge.assistants.delete.invoke as any).mockResolvedValueOnce(undefined);

      await deleteAgent();

      expect(ipcBridge.agentNotes.removeAgent.invoke).toHaveBeenCalledWith({ agentId: 'bare:gone' });
      expect(engineConfig.store.get('agent.enginePins')).toEqual({ other: 'engine-y' });
      expect(mockMessage.success).toHaveBeenCalled();
    });

    it('writes no engine pins when the Agent had none (first-run seeding stays possible)', async () => {
      (ipcBridge.assistants.delete.invoke as any).mockResolvedValueOnce(undefined);
      await deleteAgent();
      expect(engineConfig.configService.set).not.toHaveBeenCalledWith('agent.enginePins', expect.anything());
    });

    it('keeps the notebook when the Agent delete fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      (ipcBridge.assistants.delete.invoke as any).mockRejectedValueOnce(new Error('backend down'));
      await deleteAgent();
      expect(ipcBridge.agentNotes.removeAgent.invoke).not.toHaveBeenCalled();
    });

    it('keeps the Agent, and says so, when its browser data could not be removed', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      (ipcBridge.browser.deleteProfileData.invoke as any).mockResolvedValueOnce({ success: false, msg: 'busy' });
      await deleteAgent();
      (ipcBridge.browser.deleteProfileData.invoke as any).mockRejectedValueOnce(new Error('ipc down'));
      await deleteAgent();

      expect(ipcBridge.assistants.delete.invoke).not.toHaveBeenCalled();
      expect(mockMessage.error).toHaveBeenCalledWith('agent.browserProfile.deleteFailed');
      expect(mockMessage.success).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('browser data'), 'busy');
      warn.mockRestore();
    });

    it('deletes its chats first, then the Agent', async () => {
      withChats('c1', 'c2');
      await deleteAgent();

      expect(ipcBridge.conversation.remove.invoke).toHaveBeenCalledWith({ id: 'c1' });
      expect(ipcBridge.conversation.remove.invoke).toHaveBeenCalledWith({ id: 'c2' });
      expect(ipcBridge.assistants.delete.invoke).toHaveBeenCalledWith({ id: 'bare:gone' });
      expect(mockMessage.success).toHaveBeenCalled();
    });

    it('keeps the Agent, and says how many chats could not be deleted, when a chat fails', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      withChats('c1', 'c2', 'c3');
      (ipcBridge.conversation.remove.invoke as any).mockImplementation(async ({ id }: { id: string }) => id !== 'c2');

      const { result } = await deleteAgent();

      expect(ipcBridge.assistants.delete.invoke).not.toHaveBeenCalled();
      expect(mockMessage.error).toHaveBeenCalledWith('agent.deleteBot.chatsFailed');
      expect(mockMessage.success).not.toHaveBeenCalled();
      expect(result.current.deleting).toBe(false);
      (ipcBridge.conversation.remove.invoke as any).mockImplementation(async () => true);
    });

    it('keeps the Agent when its chats cannot be listed or its tasks cannot be removed', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      (ipcBridge.database.getUserConversations.invoke as any).mockRejectedValueOnce(new Error('down'));
      await deleteAgent();
      expect(mockMessage.error).toHaveBeenLastCalledWith('agent.deleteBot.chatsListFailed');

      (ipcBridge.cron.listJobs.invoke as any).mockRejectedValueOnce(new Error('down'));
      await deleteAgent();
      expect(mockMessage.error).toHaveBeenLastCalledWith('agent.deleteBot.tasksFailed');
      expect(ipcBridge.assistants.delete.invoke).not.toHaveBeenCalled();
    });

    it('goes home when the open chat was one of the bot chats, and stays put otherwise', async () => {
      router.openChatId = 'c2';
      withChats('c1', 'c2');
      await deleteAgent();
      expect(router.navigate).toHaveBeenCalledWith('/');

      router.navigate.mockClear();
      router.openChatId = 'unrelated';
      withChats('c1', 'c2');
      await deleteAgent();
      expect(router.navigate).not.toHaveBeenCalled();
    });

    it('shows the progress of the chat deletion, and is busy until it is done', async () => {
      withChats('c1', 'c2');
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      (ipcBridge.conversation.remove.invoke as any).mockImplementation(async () => {
        await gate;
        return true;
      });
      const { result } = renderHook(() => useAssistantEditor({ ...defaultParams, activeAssistant: agent }));

      let pending: Promise<void> = Promise.resolve();
      act(() => {
        pending = result.current.handleDeleteConfirm();
      });
      await waitFor(() => expect(result.current.deleting).toBe(true));

      release();
      await act(async () => {
        await pending;
      });
      expect(result.current.deleting).toBe(false);
      expect(result.current.deleteProgress).toBeNull();
      (ipcBridge.conversation.remove.invoke as any).mockImplementation(async () => true);
    });
  });

  it('initializes with default state (no active assistant)', () => {
    const { result } = renderHook(() => useAssistantEditor(defaultParams));

    expect(result.current.editVisible).toBe(false);
    expect(result.current.editName).toBe('');
    expect(result.current.isCreating).toBe(false);
    expect(result.current.defaultModelMode).toBe('auto');
    expect(result.current.defaultPermissionMode).toBe('auto');
    expect((result.current as any).defaultThoughtLevelMode).toBe('auto');
    expect(result.current.defaultMcpMode).toBe('auto');
  });

  it('handles handleEdit to populate form from active assistant', async () => {
    const assistant: AssistantListItem = {
      id: 'a1',
      name: 'TestAssistant',
      description: 'Test desc',
      avatar: '🤖',
      agent_id: 'agent-claude',
      agent: { type: 'acp', source: 'builtin', acp_backend: 'claude' },
      sort_order: 1,
      source: 'user',
      enabled: true,
    };

    const { result } = renderHook(() => useAssistantEditor(defaultParams));

    await act(async () => {
      await result.current.handleEdit(assistant);
    });

    await waitFor(() => expect(result.current.editVisible).toBe(true));

    expect(result.current.editName).toBe('TestAssistant');
    expect(result.current.editDescription).toBe('Test desc');
    expect(result.current.editAvatar).toBe('🤖');
    expect(result.current.editAgent).toBe('agent-claude');
    expect(result.current.editRecommendedPromptsText).toBe('Prompt one\nPrompt two');
    expect(result.current.defaultModelMode).toBe('fixed');
    expect(result.current.defaultModelValue).toBe('gemini-2.5-pro');
    expect(result.current.defaultPermissionMode).toBe('fixed');
    expect(result.current.defaultPermissionValue).toBe('acceptEdits');
    expect((result.current as any).defaultThoughtLevelMode).toBe('fixed');
    expect((result.current as any).defaultThoughtLevelValue).toBe('high');
    expect(result.current.defaultSkillsMode).toBe('auto');
    expect(result.current.defaultMcpMode).toBe('fixed');
    expect(result.current.selectedMcpIds).toEqual(['mcp-a']);
    expect(result.current.isCreating).toBe(false);
  });

  it('refreshes builtin localized detail when locale changes while editing', async () => {
    const builtinAssistant: AssistantListItem = {
      id: 'builtin-1',
      name: 'Academic Paper',
      name_i18n: { 'en-US': 'Academic Paper', 'zh-CN': '学术论文助手' },
      description: 'English description',
      description_i18n: { 'en-US': 'English description', 'zh-CN': '中文描述' },
      avatar: '📚',
      agent_id: 'agent-claude',
      agent: { type: 'acp', source: 'builtin', acp_backend: 'claude' },
      sort_order: 1,
      source: 'builtin',
      enabled: true,
    };

    (ipcBridge.assistants.get.invoke as any).mockImplementation(({ locale }: { locale: string }) =>
      Promise.resolve({
        ...mockAssistantDetail,
        id: 'builtin-1',
        source: 'builtin',
        profile:
          locale === 'zh-CN'
            ? {
                name: '学术论文助手',
                name_i18n: { 'en-US': 'Academic Paper', 'zh-CN': '学术论文助手' },
                description: '中文描述',
                description_i18n: { 'en-US': 'English description', 'zh-CN': '中文描述' },
                avatar: '📚',
              }
            : {
                name: 'Academic Paper',
                name_i18n: { 'en-US': 'Academic Paper', 'zh-CN': '学术论文助手' },
                description: 'English description',
                description_i18n: { 'en-US': 'English description', 'zh-CN': '中文描述' },
                avatar: '📚',
              },
        rules: {
          content: locale === 'zh-CN' ? '中文规则' : 'English rules',
          storage_mode: 'builtin_asset',
        },
        prompts: {
          recommended: ['English prompt'],
          recommended_i18n: {
            'en-US': ['English prompt'],
            'zh-CN': ['中文提示词'],
          },
        },
      })
    );

    const { result, rerender } = renderHook(
      ({ localeKey, activeAssistant }) =>
        useAssistantEditor({
          ...defaultParams,
          localeKey,
          activeAssistant,
        }),
      {
        initialProps: { localeKey: 'en-US', activeAssistant: builtinAssistant },
      }
    );

    await act(async () => {
      await result.current.handleEdit(builtinAssistant);
    });

    await waitFor(() => expect(result.current.editName).toBe('Academic Paper'));
    expect(result.current.editDescription).toBe('English description');
    expect(result.current.editContext).toBe('English rules');
    expect(result.current.editRecommendedPromptsText).toBe('English prompt');

    rerender({ localeKey: 'zh-CN', activeAssistant: builtinAssistant });

    await waitFor(() => expect(result.current.editName).toBe('学术论文助手'));
    expect(result.current.editDescription).toBe('中文描述');
    expect(result.current.editContext).toBe('中文规则');
    expect(result.current.editRecommendedPromptsText).toBe('中文提示词');
  });

  it('uses localized builtin profile fields when opening the editor', async () => {
    const builtinAssistant: AssistantListItem = {
      id: 'builtin-2',
      name: 'English Dashboard',
      name_i18n: { 'en-US': 'English Dashboard', 'zh-CN': '仪表板助手' },
      description: 'English description',
      description_i18n: { 'en-US': 'English description', 'zh-CN': '中文描述' },
      avatar: '📊',
      agent_id: 'agent-claude',
      agent: { type: 'acp', source: 'builtin', acp_backend: 'claude' },
      sort_order: 1,
      source: 'builtin',
      enabled: true,
    };

    (ipcBridge.assistants.get.invoke as any).mockResolvedValue({
      ...mockAssistantDetail,
      id: 'builtin-2',
      source: 'builtin',
      profile: {
        name: 'English Dashboard',
        name_i18n: { 'en-US': 'English Dashboard', 'zh-CN': '仪表板助手' },
        description: 'English description',
        description_i18n: { 'en-US': 'English description', 'zh-CN': '中文描述' },
        avatar: '📊',
      },
    });

    const { result } = renderHook(() =>
      useAssistantEditor({
        ...defaultParams,
        localeKey: 'zh-CN',
      })
    );

    await act(async () => {
      await result.current.handleEdit(builtinAssistant);
    });

    await waitFor(() => expect(result.current.editName).toBe('仪表板助手'));
    expect(result.current.editDescription).toBe('中文描述');
  });

  it('calls handleCreate and initializes empty form', async () => {
    const { result } = renderHook(() => useAssistantEditor(defaultParams));

    await act(async () => {
      await result.current.handleCreate();
    });

    expect(result.current.isCreating).toBe(true);
    expect(result.current.editVisible).toBe(true);
    expect(result.current.editName).toBe('');
    expect(result.current.editDescription).toBe('');
    expect(result.current.defaultModelMode).toBe('auto');
    expect(result.current.defaultPermissionMode).toBe('auto');
    expect((result.current as any).defaultThoughtLevelMode).toBe('auto');
    expect(result.current.defaultMcpMode).toBe('auto');
  });

  it('calls handleSave for creating new assistant', async () => {
    (ipcBridge.assistants.create.invoke as any).mockResolvedValue({ id: 'new-id' });

    const loadAssistantsMock = vi.fn();
    const setActiveAssistantIdMock = vi.fn();

    const { result } = renderHook(() =>
      useAssistantEditor({
        ...defaultParams,
        loadAssistants: loadAssistantsMock,
        setActiveAssistantId: setActiveAssistantIdMock,
      })
    );

    act(() => {
      result.current.handleCreate();
      result.current.setEditName('NewAssistant');
      result.current.setEditRecommendedPromptsText('Prompt A\n\nPrompt B');
      result.current.setDefaultModelMode('fixed');
      result.current.setDefaultModelValue('gpt-4.1');
      result.current.setDefaultPermissionMode('fixed');
      result.current.setDefaultPermissionValue('plan');
      (result.current as any).setDefaultThoughtLevelMode('fixed');
      (result.current as any).setDefaultThoughtLevelValue('high');
      result.current.setDefaultSkillsMode('auto');
      result.current.setSelectedSkills(['skill-one']);
      result.current.setDefaultMcpMode('fixed');
      result.current.setSelectedMcpIds(['mcp-a']);
    });

    await act(async () => {
      await result.current.handleSave();
    });

    await waitFor(() => expect(ipcBridge.assistants.create.invoke).toHaveBeenCalled());
    expect(ipcBridge.assistants.create.invoke).toHaveBeenCalledWith(
      expect.objectContaining({
        recommended_prompts: ['Prompt A', 'Prompt B'],
        defaults: {
          model: { mode: 'fixed', value: 'gpt-4.1' },
          permission: { mode: 'fixed', value: 'plan' },
          thought_level: { mode: 'fixed', value: 'high' },
          skills: { mode: 'auto', value: ['skill-one'] },
          mcps: { mode: 'fixed', value: ['mcp-a'] },
        },
      })
    );
    expect(mockMessage.success).toHaveBeenCalled();
    expect(loadAssistantsMock).toHaveBeenCalled();
    expect(setActiveAssistantIdMock).toHaveBeenCalledWith('new-id');
    expect(swrMutate).toHaveBeenCalledWith('assistants.list');
    expect(result.current.editVisible).toBe(false);
  });

  it('calls handleSave for updating existing assistant', async () => {
    const assistant: AssistantListItem = {
      id: 'a1',
      name: 'Existing',
      sort_order: 1,
      source: 'user',
      enabled: true,
    };

    (ipcBridge.assistants.update.invoke as any).mockResolvedValue({ id: 'a1' });

    const loadAssistantsMock = vi.fn();

    const { result } = renderHook(() =>
      useAssistantEditor({
        ...defaultParams,
        loadAssistants: loadAssistantsMock,
        activeAssistant: assistant,
      })
    );

    await act(async () => {
      await result.current.handleEdit(assistant);
    });

    act(() => {
      result.current.setEditName('UpdatedName');
    });

    await act(async () => {
      await result.current.handleSave();
    });

    await waitFor(() => expect(ipcBridge.assistants.update.invoke).toHaveBeenCalled());
    expect(mockMessage.success).toHaveBeenCalled();
    expect(loadAssistantsMock).toHaveBeenCalled();
    expect(swrMutate).toHaveBeenCalledWith('assistants.list');
    expect(swrMutate).toHaveBeenCalledWith('guid.assistant.detail.a1.en');
  });

  it('clears model and permission defaults when the main agent changes', async () => {
    const assistant: AssistantListItem = {
      id: 'a1',
      name: 'TestAssistant',
      description: 'Test desc',
      avatar: '🤖',
      agent_id: 'agent-claude',
      agent: { type: 'acp', source: 'builtin', acp_backend: 'claude' },
      sort_order: 1,
      source: 'user',
      enabled: true,
    };

    const { result } = renderHook(() => useAssistantEditor(defaultParams));

    await act(async () => {
      await result.current.handleEdit(assistant);
    });

    expect(result.current.defaultModelMode).toBe('fixed');
    expect(result.current.defaultModelValue).toBe('gemini-2.5-pro');
    expect(result.current.defaultPermissionMode).toBe('fixed');
    expect(result.current.defaultPermissionValue).toBe('acceptEdits');
    expect((result.current as any).defaultThoughtLevelMode).toBe('fixed');
    expect((result.current as any).defaultThoughtLevelValue).toBe('high');

    act(() => {
      result.current.setEditAgent('agent-gemini');
    });

    expect(result.current.editAgent).toBe('agent-gemini');
    expect(result.current.defaultModelMode).toBe('auto');
    expect(result.current.defaultModelValue).toBe('');
    expect(result.current.defaultPermissionMode).toBe('auto');
    expect(result.current.defaultPermissionValue).toBe('');
    expect((result.current as any).defaultThoughtLevelMode).toBe('auto');
    expect((result.current as any).defaultThoughtLevelValue).toBe('');
  });

  it('allows builtin assistants to persist main agent plus default model and permission', async () => {
    const builtinDetail = {
      ...mockAssistantDetail,
      source: 'builtin',
      prompts: {
        recommended: ['Builtin prompt'],
        recommended_i18n: {},
      },
      defaults: {
        model: { mode: 'auto' as const, value: undefined },
        permission: { mode: 'auto' as const, value: undefined },
        thought_level: { mode: 'auto' as const, value: undefined },
        skills: { mode: 'fixed' as const, value: ['skill-one'] },
        mcps: { mode: 'auto' as const, value: [] },
      },
    };
    (ipcBridge.assistants.get.invoke as any).mockResolvedValue(builtinDetail);
    (ipcBridge.assistants.update.invoke as any).mockResolvedValue({ id: 'builtin-1' });

    const assistant: AssistantListItem = {
      id: 'builtin-1',
      name: 'Builtin',
      sort_order: 1,
      source: 'builtin',
      enabled: true,
      agent_id: 'agent-claude',
      agent: { type: 'acp', source: 'builtin', acp_backend: 'claude' },
    };

    const { result } = renderHook(() =>
      useAssistantEditor({
        ...defaultParams,
        activeAssistant: assistant,
      })
    );

    await act(async () => {
      await result.current.handleEdit(assistant);
    });

    act(() => {
      result.current.setEditAgent('agent-gemini');
      result.current.setDefaultModelMode('fixed');
      result.current.setDefaultModelValue('gemini-2.5-pro');
      result.current.setDefaultPermissionMode('fixed');
      result.current.setDefaultPermissionValue('default');
      (result.current as any).setDefaultThoughtLevelMode('fixed');
      (result.current as any).setDefaultThoughtLevelValue('high');
      result.current.setEditRecommendedPromptsText('Should not be sent');
      result.current.setSelectedSkills(['skill-two']);
      result.current.setSelectedMcpIds(['mcp-b']);
    });

    await act(async () => {
      await result.current.handleSave();
    });

    expect(ipcBridge.assistants.update.invoke).toHaveBeenCalledWith({
      id: 'builtin-1',
      agent_id: 'agent-gemini',
      defaults: {
        model: { mode: 'fixed', value: 'gemini-2.5-pro' },
        permission: { mode: 'fixed', value: 'default' },
        thought_level: { mode: 'fixed', value: 'high' },
      },
    });
  });

  it('loads builtin auto defaults when no fixed values are configured', async () => {
    const builtinDetail = {
      ...mockAssistantDetail,
      source: 'builtin',
      defaults: {
        model: { mode: 'auto' as const, value: undefined },
        permission: { mode: 'auto' as const, value: undefined },
        thought_level: { mode: 'auto' as const, value: undefined },
        skills: { mode: 'fixed' as const, value: ['skill-one'] },
        mcps: { mode: 'auto' as const, value: [] },
      },
    };
    (ipcBridge.assistants.get.invoke as any).mockResolvedValue(builtinDetail);

    const assistant: AssistantListItem = {
      id: 'builtin-1',
      name: 'Builtin',
      sort_order: 1,
      source: 'builtin',
      enabled: true,
      agent_id: 'agent-claude',
      agent: { type: 'acp', source: 'builtin', acp_backend: 'claude' },
    };

    const { result } = renderHook(() =>
      useAssistantEditor({
        ...defaultParams,
        activeAssistant: assistant,
      })
    );

    await act(async () => {
      await result.current.handleEdit(assistant);
    });

    expect(result.current.defaultModelMode).toBe('auto');
    expect(result.current.defaultModelValue).toBe('');
    expect(result.current.defaultPermissionMode).toBe('auto');
    expect(result.current.defaultPermissionValue).toBe('');
    expect((result.current as any).defaultThoughtLevelMode).toBe('auto');
    expect((result.current as any).defaultThoughtLevelValue).toBe('');
    expect(result.current.defaultMcpMode).toBe('auto');
    expect(result.current.selectedMcpIds).toEqual([]);
  });

  it('optimistically updates and revalidates the shared assistant list when toggling enabled', async () => {
    const assistant: AssistantListItem = {
      id: 'builtin-1',
      name: 'Builtin',
      sort_order: 1,
      source: 'builtin',
      enabled: true,
    };
    (ipcBridge.assistants.setState.invoke as any).mockResolvedValue(undefined);

    const loadAssistantsMock = vi.fn();
    const { result } = renderHook(() =>
      useAssistantEditor({
        ...defaultParams,
        loadAssistants: loadAssistantsMock,
      })
    );

    await act(async () => {
      await result.current.handleToggleEnabled(assistant, false);
    });

    expect(swrMutate).toHaveBeenNthCalledWith(1, 'assistants.list', expect.any(Function), { revalidate: false });
    expect(ipcBridge.assistants.setState.invoke).toHaveBeenCalledWith({ id: 'builtin-1', enabled: false });
    expect(loadAssistantsMock).toHaveBeenCalled();
    expect(swrMutate).toHaveBeenCalledWith('guid.assistant.detail.builtin-1.en');
  });

  it('appends a re-enabled assistant to the shared enabled order', async () => {
    const cli = {
      id: 'cli',
      name: 'CLI',
      sort_order: 1,
      source: 'generated',
      enabled: true,
    } as AssistantListItem;
    const custom = {
      id: 'custom',
      name: 'Custom',
      sort_order: 2,
      source: 'user',
      enabled: true,
    } as AssistantListItem;
    const official = {
      id: 'official',
      name: 'Official',
      sort_order: 3,
      source: 'builtin',
      enabled: false,
    } as AssistantListItem;
    const setAssistantOrder = vi.fn(async () => {});
    (ipcBridge.assistants.setState.invoke as any).mockResolvedValue(undefined);

    const { result } = renderHook(() =>
      useAssistantEditor({
        ...defaultParams,
        assistants: [cli, custom, official],
        assistantOrder: ['custom', 'cli'],
        setAssistantOrder,
      })
    );

    await act(async () => {
      await result.current.handleToggleEnabled(official, true);
    });

    expect(setAssistantOrder).toHaveBeenCalledWith(['custom', 'cli', 'official']);
    expect(ipcBridge.assistants.setState.invoke).toHaveBeenCalledWith({ id: 'official', enabled: true });
  });

  it('revalidates the shared assistant list if toggle enabled fails', async () => {
    const assistant: AssistantListItem = {
      id: 'builtin-1',
      name: 'Builtin',
      sort_order: 1,
      source: 'builtin',
      enabled: true,
    };
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (ipcBridge.assistants.setState.invoke as any).mockRejectedValue(new Error('toggle failed'));

    const { result } = renderHook(() => useAssistantEditor(defaultParams));

    await act(async () => {
      await result.current.handleToggleEnabled(assistant, false);
    });

    expect(consoleErrorSpy).toHaveBeenCalled();
    expect(mockMessage.error).toHaveBeenCalled();
    expect(swrMutate).toHaveBeenNthCalledWith(1, 'assistants.list', expect.any(Function), { revalidate: false });

    consoleErrorSpy.mockRestore();
  });

  it('logs error when save fails', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (ipcBridge.assistants.create.invoke as any).mockRejectedValue(new Error('Backend error'));

    const { result } = renderHook(() => useAssistantEditor(defaultParams));

    act(() => {
      result.current.handleCreate();
      result.current.setEditName('NewAssistant');
    });

    await act(async () => {
      await result.current.handleSave();
    });

    await waitFor(() => expect(consoleErrorSpy).toHaveBeenCalled());
    expect(mockMessage.error).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  it('shows backend skill import failure detail while saving pending skills', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    (ipcBridge.fs.importSkills.invoke as any).mockRejectedValue(
      Object.assign(new Error('wrapped import failure'), {
        name: 'BackendHttpError',
        status: 400,
        code: 'SKILL_IMPORT_FILE_TOO_LARGE',
      })
    );

    const { result } = renderHook(() => useAssistantEditor(defaultParams));

    act(() => {
      result.current.handleCreate();
      result.current.setEditName('NewAssistant');
      result.current.setPendingSkills([{ name: 'huge-skill', path: '/tmp/huge-skill' }]);
    });

    await act(async () => {
      await result.current.handleSave();
    });

    expect(mockMessage.error).toHaveBeenCalledWith('settings.skillsHub.importErrors.SKILL_IMPORT_FILE_TOO_LARGE');
    expect(ipcBridge.assistants.create.invoke).not.toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });
  describe('bot color', () => {
    const userAssistant: AssistantListItem = {
      id: 'a1',
      name: 'Existing',
      agent_id: 'agent-claude',
      sort_order: 1,
      source: 'user',
      enabled: true,
    };

    it('gives a new Agent a random palette color nobody uses yet and stores it on create', async () => {
      (ipcBridge.assistants.create.invoke as any).mockResolvedValue({ id: 'new-id' });
      engineConfig.store.set(
        'agent.colors',
        Object.fromEntries(BOT_COLOR_PALETTE.slice(0, 11).map((color, index) => [`b${index}`, color]))
      );
      const { result } = renderHook(() => useAssistantEditor(defaultParams));

      await act(async () => {
        await result.current.handleCreate();
      });
      act(() => result.current.setEditName('Fresh'));
      expect(result.current.editColor).toBe(BOT_COLOR_PALETTE[11]);

      await act(async () => {
        await result.current.handleSave();
      });

      expect(engineConfig.store.get('agent.colors')).toMatchObject({ 'new-id': BOT_COLOR_PALETTE[11] });
      expect(Object.keys(engineConfig.store.get('agent.colors') as object)).toHaveLength(12);
    });

    it("stores the user's pick instead of the random color on create", async () => {
      (ipcBridge.assistants.create.invoke as any).mockResolvedValue({ id: 'new-id' });
      const { result } = renderHook(() => useAssistantEditor(defaultParams));

      await act(async () => {
        await result.current.handleCreate();
      });
      act(() => {
        result.current.setEditName('Fresh');
        result.current.setEditColor('#123abc');
      });
      await act(async () => {
        await result.current.handleSave();
      });

      expect(engineConfig.store.get('agent.colors')).toEqual({ 'new-id': '#123abc' });
    });

    it('gives a duplicate its own new color', async () => {
      (ipcBridge.assistants.create.invoke as any).mockResolvedValue({ id: 'copy-id' });
      engineConfig.store.set('agent.colors', { a1: BOT_COLOR_PALETTE[0] });
      const { result } = renderHook(() => useAssistantEditor(defaultParams));

      await act(async () => {
        await result.current.handleDuplicate(userAssistant);
      });
      expect(BOT_COLOR_PALETTE).toContain(result.current.editColor);
      expect(result.current.editColor).not.toBe(BOT_COLOR_PALETTE[0]);
      await act(async () => {
        await result.current.handleSave();
      });

      const colors = engineConfig.store.get('agent.colors') as Record<string, string>;
      expect(colors.a1).toBe(BOT_COLOR_PALETTE[0]);
      expect(colors['copy-id']).toBe(result.current.editColor);
    });

    it('opens an Agent with its stored color, or none when it has none', async () => {
      engineConfig.store.set('agent.colors', { a1: '#112233' });
      const { result } = renderHook(() => useAssistantEditor({ ...defaultParams, activeAssistant: userAssistant }));

      await act(async () => {
        await result.current.handleEdit(userAssistant);
      });
      expect(result.current.editColor).toBe('#112233');

      await act(async () => {
        await result.current.handleEdit({ ...userAssistant, id: 'a2' });
      });
      expect(result.current.editColor).toBe('');
    });

    it.each(['red;', 'url(x)', '#12', 42])(
      'opens an Agent whose stored color is malformed (%j) with no color',
      async (bad) => {
        engineConfig.store.set('agent.colors', { a1: bad });
        const { result } = renderHook(() => useAssistantEditor({ ...defaultParams, activeAssistant: userAssistant }));

        await act(async () => {
          await result.current.handleEdit(userAssistant);
        });

        expect(result.current.editColor).toBe('');
      }
    );

    it('still finishes creating the Agent when the color cannot be stored', async () => {
      const error = vi.spyOn(console, 'error').mockImplementation(() => {});
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      (ipcBridge.assistants.create.invoke as any).mockResolvedValue({ id: 'new-id' });
      const loadAssistants = vi.fn();
      const originalSet = engineConfig.configService.set.getMockImplementation()!;
      engineConfig.configService.set.mockImplementation(async (key: string, value: unknown) => {
        if (key === 'agent.colors') throw new Error('settings down');
        return originalSet(key, value);
      });
      const { result } = renderHook(() => useAssistantEditor({ ...defaultParams, loadAssistants }));

      await act(async () => {
        await result.current.handleCreate();
      });
      act(() => result.current.setEditName('Fresh'));
      await act(async () => {
        await result.current.handleSave();
      });
      engineConfig.configService.set.mockImplementation(originalSet);

      expect(warn).toHaveBeenCalledWith(expect.stringContaining('color'), expect.any(Error));
      expect(loadAssistants).toHaveBeenCalled();
      expect(ipcBridge.agentBrowser.ensureAgentRule.invoke).toHaveBeenCalled();
      expect(mockMessage.success).toHaveBeenCalled();
      expect(result.current.editVisible).toBe(false);
      error.mockRestore();
      warn.mockRestore();
    });

    it('saves a changed color of an existing Agent with Save, and writes nothing when it did not change', async () => {
      (ipcBridge.assistants.update.invoke as any).mockResolvedValue({ id: 'a1' });
      engineConfig.store.set('agent.colors', { a1: '#112233', other: '#445566' });
      const { result } = renderHook(() => useAssistantEditor({ ...defaultParams, activeAssistant: userAssistant }));

      await act(async () => {
        await result.current.handleEdit(userAssistant);
      });
      await act(async () => {
        await result.current.handleSave();
      });
      expect(engineConfig.configService.set).not.toHaveBeenCalledWith('agent.colors', expect.anything());

      act(() => result.current.setEditColor('#abcdef'));
      await act(async () => {
        await result.current.handleSave();
      });
      expect(engineConfig.store.get('agent.colors')).toEqual({ a1: '#abcdef', other: '#445566' });
    });

    it('does not give the default Agent a color', async () => {
      (ipcBridge.assistants.update.invoke as any).mockResolvedValue({ id: 'the-default' });
      engineConfig.store.set('agent.builtinDefaultId', 'the-default');
      const defaultAgent = { ...userAssistant, id: 'the-default' };
      const { result } = renderHook(() => useAssistantEditor({ ...defaultParams, activeAssistant: defaultAgent }));

      await act(async () => {
        await result.current.handleEdit(defaultAgent);
      });
      act(() => result.current.setEditColor('#abcdef'));
      await act(async () => {
        await result.current.handleSave();
      });

      expect(engineConfig.configService.set).not.toHaveBeenCalledWith('agent.colors', expect.anything());
    });

    it('removes the color of a deleted Agent', async () => {
      engineConfig.store.set('agent.colors', { a1: '#112233', other: '#445566' });
      (ipcBridge.assistants.delete.invoke as any).mockResolvedValueOnce(undefined);
      const { result } = renderHook(() => useAssistantEditor({ ...defaultParams, activeAssistant: userAssistant }));

      await act(async () => {
        await result.current.handleDeleteConfirm();
      });

      expect(engineConfig.store.get('agent.colors')).toEqual({ other: '#445566' });
    });

    it('keeps the color when the Agent delete fails', async () => {
      vi.spyOn(console, 'error').mockImplementation(() => {});
      engineConfig.store.set('agent.colors', { a1: '#112233' });
      (ipcBridge.assistants.delete.invoke as any).mockRejectedValueOnce(new Error('backend down'));
      const { result } = renderHook(() => useAssistantEditor({ ...defaultParams, activeAssistant: userAssistant }));

      await act(async () => {
        await result.current.handleDeleteConfirm();
      });

      expect(engineConfig.store.get('agent.colors')).toEqual({ a1: '#112233' });
    });
  });

  describe('engine pinning', () => {
    const userAssistant: AssistantListItem = {
      id: 'a1',
      name: 'Existing',
      agent_id: 'agent-claude',
      sort_order: 1,
      source: 'user',
      enabled: true,
    };
    const enginePinWrites = () =>
      engineConfig.configService.set.mock.calls.filter(([key]) => key === 'agent.enginePins');

    it('starts a new Agent on the default engine without pinning it', async () => {
      (ipcBridge.assistants.create.invoke as any).mockResolvedValue({ id: 'new-id' });
      const { result } = renderHook(() => useAssistantEditor({ ...defaultParams, defaultEngineId: 'agent-default' }));

      await act(async () => {
        await result.current.handleCreate();
      });
      act(() => result.current.setEditName('Fresh'));

      expect(result.current.editAgent).toBe('agent-default');
      expect(result.current.editUsesDefault).toBe(true);

      await act(async () => {
        await result.current.handleSave();
      });

      expect(ipcBridge.assistants.create.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ agent_id: 'agent-default' })
      );
      expect(enginePinWrites()).toEqual([]);
    });

    it('pins a new Agent when a specific engine is chosen', async () => {
      (ipcBridge.assistants.create.invoke as any).mockResolvedValue({ id: 'new-id' });
      const { result } = renderHook(() => useAssistantEditor({ ...defaultParams, defaultEngineId: 'agent-default' }));

      await act(async () => {
        await result.current.handleCreate();
      });
      act(() => {
        result.current.setEditName('Pinned');
        result.current.chooseEngine('agent-gemini');
      });
      await act(async () => {
        await result.current.handleSave();
      });

      expect(ipcBridge.assistants.create.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ agent_id: 'agent-gemini' })
      );
      expect(engineConfig.store.get('agent.enginePins')).toEqual({ 'new-id': 'agent-gemini' });
    });

    it('opens a pinned Agent as pinned and an unpinned one as following the default', async () => {
      engineConfig.store.set('agent.enginePins', { a1: 'agent-claude' });
      const { result } = renderHook(() => useAssistantEditor({ ...defaultParams, defaultEngineId: 'agent-default' }));

      await act(async () => {
        await result.current.handleEdit(userAssistant);
      });
      expect(result.current.editUsesDefault).toBe(false);
      expect(result.current.editAgent).toBe('agent-claude');

      await act(async () => {
        await result.current.handleEdit({ ...userAssistant, id: 'a2' });
      });
      expect(result.current.editUsesDefault).toBe(true);
    });

    it('re-binds an Agent to the default engine and clears its pin when it goes back to "Use default"', async () => {
      engineConfig.store.set('agent.enginePins', { a1: 'agent-claude', other: 'agent-gemini' });
      (ipcBridge.assistants.update.invoke as any).mockResolvedValue({ id: 'a1' });
      const { result } = renderHook(() =>
        useAssistantEditor({ ...defaultParams, activeAssistant: userAssistant, defaultEngineId: 'agent-default' })
      );

      await act(async () => {
        await result.current.handleEdit(userAssistant);
      });
      act(() => result.current.followDefaultEngine());
      expect(result.current.editAgent).toBe('agent-default');
      expect(result.current.editUsesDefault).toBe(true);

      await act(async () => {
        await result.current.handleSave();
      });

      expect(ipcBridge.assistants.update.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a1', agent_id: 'agent-default' })
      );
      expect(engineConfig.store.get('agent.enginePins')).toEqual({ other: 'agent-gemini' });
    });

    it('pins an existing Agent that moves to a specific engine', async () => {
      (ipcBridge.assistants.update.invoke as any).mockResolvedValue({ id: 'a1' });
      const { result } = renderHook(() =>
        useAssistantEditor({ ...defaultParams, activeAssistant: userAssistant, defaultEngineId: 'agent-default' })
      );

      await act(async () => {
        await result.current.handleEdit(userAssistant);
      });
      act(() => result.current.chooseEngine('agent-gemini'));
      await act(async () => {
        await result.current.handleSave();
      });

      expect(ipcBridge.assistants.update.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a1', agent_id: 'agent-gemini' })
      );
      expect(engineConfig.store.get('agent.enginePins')).toEqual({ a1: 'agent-gemini' });
    });

    it('does not touch pins when an unpinned Agent keeps following the default', async () => {
      (ipcBridge.assistants.update.invoke as any).mockResolvedValue({ id: 'a1' });
      const { result } = renderHook(() =>
        useAssistantEditor({ ...defaultParams, activeAssistant: userAssistant, defaultEngineId: 'agent-default' })
      );

      await act(async () => {
        await result.current.handleEdit(userAssistant);
      });
      await act(async () => {
        await result.current.handleSave();
      });

      expect(ipcBridge.assistants.update.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'a1', agent_id: 'agent-default' })
      );
      expect(enginePinWrites()).toEqual([]);
    });

    it('confirms a usage-limit pin on a same-engine save, so a later default change keeps it', async () => {
      engineConfig.store.set('agent.enginePins', { a1: 'agent-claude', other: 'agent-gemini' });
      engineConfig.store.set('agent.enginePinOrigins', { a1: 'limit', other: 'limit' });
      (ipcBridge.assistants.update.invoke as any).mockResolvedValue({ id: 'a1' });
      const { result } = renderHook(() =>
        useAssistantEditor({ ...defaultParams, activeAssistant: userAssistant, defaultEngineId: 'agent-default' })
      );

      await act(async () => {
        await result.current.handleEdit(userAssistant);
      });
      expect(result.current.editAgent).toBe('agent-claude');
      await act(async () => {
        await result.current.handleSave();
      });

      expect(engineConfig.store.get('agent.enginePinOrigins')).toEqual({ other: 'limit' });
      await releaseLimitPins();
      expect(engineConfig.store.get('agent.enginePins')).toEqual({ a1: 'agent-claude' });
    });

    it('opens a generated (bare CLI) assistant on its own engine, not following the default', async () => {
      const generated: AssistantListItem = { ...userAssistant, id: 'bare:claude', source: 'generated' };
      const { result } = renderHook(() =>
        useAssistantEditor({ ...defaultParams, activeAssistant: generated, defaultEngineId: 'agent-default' })
      );

      await act(async () => {
        await result.current.handleEdit(generated);
      });

      expect(result.current.editUsesDefault).toBe(false);
      expect(result.current.editAgent).toBe('agent-claude');
    });

    it('duplicates a generated (bare CLI) assistant onto its engine and pins the copy there', async () => {
      (ipcBridge.assistants.create.invoke as any).mockResolvedValue({ id: 'copy-id' });
      const generated: AssistantListItem = { ...userAssistant, id: 'bare:claude', source: 'generated' };
      const { result } = renderHook(() => useAssistantEditor({ ...defaultParams, defaultEngineId: 'agent-default' }));

      await act(async () => {
        await result.current.handleDuplicate(generated);
      });
      expect(result.current.editUsesDefault).toBe(false);
      expect(result.current.editAgent).toBe('agent-claude');

      await act(async () => {
        await result.current.handleSave();
      });
      expect(ipcBridge.assistants.create.invoke).toHaveBeenCalledWith(
        expect.objectContaining({ agent_id: 'agent-claude' })
      );
      expect(engineConfig.store.get('agent.enginePins')).toEqual({ 'copy-id': 'agent-claude' });
    });

    it('leaves a generated (bare CLI) assistant on its own engine', async () => {
      const generated: AssistantListItem = { ...userAssistant, id: 'bare:claude', source: 'generated' };
      (ipcBridge.assistants.update.invoke as any).mockResolvedValue({ id: generated.id });
      const { result } = renderHook(() =>
        useAssistantEditor({ ...defaultParams, activeAssistant: generated, defaultEngineId: 'agent-default' })
      );

      await act(async () => {
        await result.current.handleEdit(generated);
      });
      await act(async () => {
        await result.current.handleSave();
      });

      expect(ipcBridge.assistants.update.invoke).toHaveBeenCalledWith(
        expect.not.objectContaining({ agent_id: expect.anything() })
      );
      expect(enginePinWrites()).toEqual([]);
    });
  });
});
