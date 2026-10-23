/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Task 4: Assistants became Agents. The UI says Agent(s), shows the engine as a text label only,
 * keeps the default Agent undeletable and gives new Agents the AionUi rule block. Lives under
 * tests/unit/assets because the settings and renderer test directories are over the size limit.
 */

import { ConfigProvider } from '@arco-design/web-react';
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const LOCALES_DIR = join(__dirname, '../../../packages/desktop/src/renderer/services/i18n/locales/en-US');
type Json = { [key: string]: string | Json };
const enUS: Record<string, Json> = Object.fromEntries(
  readdirSync(LOCALES_DIR)
    .filter((file) => file.endsWith('.json'))
    .map((file) => [file.replace('.json', ''), JSON.parse(readFileSync(join(LOCALES_DIR, file), 'utf-8')) as Json])
);

/** Every string in the en-US locale with its dotted path. */
const flatten = (node: Json, prefix: string): Array<[string, string]> =>
  Object.entries(node).flatMap(([key, value]) =>
    typeof value === 'string' ? [[`${prefix}.${key}`, value] as [string, string]] : flatten(value, `${prefix}.${key}`)
  );
const ALL_EN_STRINGS = Object.entries(enUS).flatMap(([module, json]) => flatten(json, module));

/** Look a key up the way i18next does: a flat dotted key inside the file wins over nested objects. */
const lookup = (key: string): string | undefined => {
  const [moduleName, ...path] = key.split('.');
  const json = enUS[moduleName];
  if (!json) return undefined;
  const flat = json[path.join('.')];
  if (typeof flat === 'string') return flat;
  const nested = path.reduce<unknown>((node, segment) => (node as Json | undefined)?.[segment], json);
  return typeof nested === 'string' ? nested : undefined;
};
const translate = (key: string, options?: Record<string, unknown>): string => {
  const fallback = typeof options?.defaultValue === 'string' ? options.defaultValue : key;
  return (lookup(key) ?? fallback).replace(/\{\{(\w+)\}\}/g, (_m, name: string) => String(options?.[name] ?? ''));
};

const mocks = vi.hoisted(() => ({
  config: new Map<string, unknown>(),
  engines: { current: [] as unknown[] },
  invoke: {
    create: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    get: vi.fn(),
    writeRule: vi.fn(),
    deleteRule: vi.fn(),
    ensureRule: vi.fn(),
    ensureDefaultAgent: vi.fn(),
  },
  swrMutate: vi.fn(),
  ready: { current: undefined as ((event: { id: string }) => void) | undefined },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'en-US' } }),
}));

// The desktop app, whose main adds the managed rule blocks.
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true }));

vi.mock('@/renderer/hooks/config/useConfig', () => ({
  useConfig: (key: string) => [mocks.config.get(key), vi.fn()],
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: (key: string) => mocks.config.get(key),
    set: vi.fn(async () => {}),
    reload: async () => {},
    setLocal: (key: string, value: unknown) => mocks.config.set(key, value),
    whenReady: async () => {},
    initialize: async () => {},
    isInitialized: () => true,
    subscribe: () => () => {},
  },
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn(), useMatch: () => null }));

vi.mock('swr', () => ({
  __esModule: true,
  default: () => ({ data: mocks.engines.current }),
  mutate: mocks.swrMutate,
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    assistants: {
      get: { invoke: mocks.invoke.get },
      create: { invoke: mocks.invoke.create },
      update: { invoke: mocks.invoke.update },
      delete: { invoke: mocks.invoke.remove },
      setState: { invoke: vi.fn() },
    },
    mcpService: { listServers: { invoke: vi.fn(async () => []) } },
    // Deleting a bot also deletes what it owns; here it owns nothing.
    browser: { deleteProfileData: { invoke: vi.fn(async () => ({ success: true })) } },
    agentNotes: { removeAgent: { invoke: vi.fn(async () => ({ success: true })) } },
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
    fs: {
      readAssistantRule: { invoke: vi.fn() },
      listAvailableSkills: { invoke: vi.fn(async () => []) },
      writeAssistantRule: { invoke: mocks.invoke.writeRule },
      deleteAssistantRule: { invoke: mocks.invoke.deleteRule },
      importSkills: { invoke: vi.fn() },
    },
    agentBrowser: {
      ensureAgentRule: { invoke: mocks.invoke.ensureRule },
      ensureDefaultAgent: { invoke: mocks.invoke.ensureDefaultAgent },
      defaultAgentReady: {
        on: (callback: (event: { id: string }) => void) => {
          mocks.ready.current = callback;
          return () => {
            mocks.ready.current = undefined;
          };
        },
      },
    },
  },
}));

vi.mock('@/renderer/hooks/mcp/catalog', () => ({
  ensureBackendMcpCatalog: vi.fn(async () => ({ userServers: [], builtinServers: [], allServers: [] })),
}));

vi.mock('@/renderer/pages/settings/AssistantSettings/AssistantAvatar', () => ({ default: () => <span /> }));
vi.mock('@/renderer/pages/settings/AssistantSettings/AssistantEditorSections', () => ({ default: () => <div /> }));

import { DEFAULT_AGENT_ID } from '@/common/types/agent/defaultAgent';
import { useAssistantEditor } from '@/renderer/hooks/assistant/useAssistantEditor';
import { useDefaultAgentSync } from '@/renderer/hooks/agent/useDefaultEngine';
import SiderAssistantEntry from '@/renderer/components/layout/Sider/SiderNav/SiderAssistantEntry';
import AssistantEditorPage from '@/renderer/pages/settings/AssistantSettings/AssistantEditorPage';
import DeleteAssistantModal from '@/renderer/pages/settings/AssistantSettings/DeleteAssistantModal';
import MyAssistantCard from '@/renderer/pages/settings/AssistantSettings/home/MyAssistantCard';
import RuntimeBadge from '@/renderer/pages/settings/AssistantSettings/home/RuntimeBadge';
import type { AssistantListItem } from '@/renderer/pages/settings/AssistantSettings/types';

const assistant = (overrides: Partial<AssistantListItem> = {}): AssistantListItem =>
  ({
    id: 'mine',
    source: 'user',
    name: 'Researcher',
    name_i18n: {},
    description: '',
    description_i18n: {},
    enabled: true,
    sort_order: 1,
    agent_id: 'engine-a',
    agent_status: 'online',
    enabled_skills: [],
    custom_skill_names: [],
    disabled_builtin_skills: [],
    context_i18n: {},
    prompts: [],
    ...overrides,
  }) as AssistantListItem;

beforeEach(() => {
  mocks.config.clear();
  mocks.engines.current = [{ id: 'engine-a', name: 'Engine Alpha', name_i18n: {} }];
  Object.values(mocks.invoke).forEach((fn) => fn.mockReset());
  mocks.swrMutate.mockReset();
  mocks.ready.current = undefined;
  mocks.invoke.writeRule.mockResolvedValue(true);
  mocks.invoke.deleteRule.mockResolvedValue(true);
  mocks.invoke.ensureRule.mockResolvedValue({ success: true });
  mocks.invoke.ensureDefaultAgent.mockResolvedValue({ success: true });
});

afterEach(cleanup);

describe('the UI says Agent, not Assistant', () => {
  it('no en-US string says "assistant", apart from API field names', () => {
    const offenders = ALL_EN_STRINGS.filter(([, text]) =>
      /assistant/i.test(text.replace(/assistant_id|\{\{[^}]*\}\}/g, ''))
    ).map(([path, text]) => `${path}: ${text}`);

    expect(offenders).toEqual([]);
  });

  it('the sider entry, the agent cards and the delete dialog show Agent(s)', () => {
    const { container } = render(
      <ConfigProvider>
        <SiderAssistantEntry
          isMobile={false}
          isActive={false}
          collapsed={false}
          siderTooltipProps={{}}
          onClick={vi.fn()}
        />
        <MyAssistantCard
          assistant={assistant()}
          localeKey='en-US'
          onOpenDetail={vi.fn()}
          onDelete={vi.fn()}
          onToggleEnabled={vi.fn()}
          onStartChat={vi.fn()}
        />
        <DeleteAssistantModal visible onCancel={vi.fn()} onConfirm={vi.fn()} activeAssistant={assistant()} />
      </ConfigProvider>
    );

    expect(screen.getByText('Pixebots')).toBeInTheDocument();
    expect(screen.getByText('Delete "Researcher"?')).toBeInTheDocument();
    expect(`${container.textContent}${document.body.textContent}`).not.toMatch(/assistant/i);
  });
});

describe('the Agent card shows the engine as a text label only', () => {
  it('names the pinned engine, with no logo image', () => {
    mocks.config.set('agent.enginePins', { mine: 'engine-a' });

    const { container } = render(<RuntimeBadge assistant={assistant()} />);

    expect(screen.getByTestId('assistant-runtime-mine')).toHaveTextContent('Engine: Engine Alpha');
    expect(container.querySelector('img, svg')).toBeNull();
  });

  it('says "Use default" for an Agent that follows the default engine', () => {
    render(<RuntimeBadge assistant={assistant()} />);

    expect(screen.getByTestId('assistant-runtime-mine')).toHaveTextContent('Engine: Use default');
  });

  it('shows a bare CLI entry on its own engine', () => {
    render(<RuntimeBadge assistant={assistant({ id: 'bare', source: 'generated' })} />);

    expect(screen.getByTestId('assistant-runtime-bare')).toHaveTextContent('Engine: Engine Alpha');
  });
});

describe('the default Agent cannot be deleted', () => {
  beforeEach(() => mocks.config.set('agent.builtinDefaultId', 'mine'));

  it('disables Delete in the card menu and explains why', async () => {
    const onDelete = vi.fn();
    render(
      <ConfigProvider>
        <MyAssistantCard
          assistant={assistant()}
          localeKey='en-US'
          onOpenDetail={vi.fn()}
          onDelete={onDelete}
          onToggleEnabled={vi.fn()}
          onStartChat={vi.fn()}
        />
      </ConfigProvider>
    );

    fireEvent.click(screen.getByTestId('btn-assistant-more-mine'));
    const label = await screen.findByTestId('menu-delete-mine');
    const item = label.closest('[role="menuitem"]');
    expect(item?.className).toContain('disabled');
    fireEvent.click(screen.getByTestId('menu-delete-mine'));
    expect(onDelete).not.toHaveBeenCalled();

    fireEvent.mouseEnter(screen.getByTestId('menu-delete-mine'));
    expect(await screen.findByText("The default Agent can't be deleted.")).toBeInTheDocument();
  });

  it('disables Delete in the editor and explains why', async () => {
    const requestDelete = vi.fn();
    render(
      <ConfigProvider>
        <AssistantEditorPage
          editor={
            {
              isCreating: false,
              profile: { name: 'Agent' },
              actions: { save: vi.fn(), requestDelete, duplicate: vi.fn() },
            } as never
          }
          activeAssistant={assistant()}
          onBack={vi.fn()}
        />
      </ConfigProvider>
    );

    const button = screen.getByTestId('btn-delete-assistant');
    expect(button).toBeDisabled();
    fireEvent.click(button);
    expect(requestDelete).not.toHaveBeenCalled();

    fireEvent.mouseEnter(button.parentElement as HTMLElement);
    expect(await screen.findByText("The default Agent can't be deleted.")).toBeInTheDocument();
  });

  it('refuses a delete request that slips past the buttons, and still deletes other Agents', async () => {
    mocks.invoke.remove.mockResolvedValue(undefined);
    const warning = vi.fn();
    const params = {
      localeKey: 'en-US',
      activeAssistant: assistant(),
      setActiveAssistantId: vi.fn(),
      loadAssistants: vi.fn(),
      assistants: [] as AssistantListItem[],
      assistantOrder: [] as string[],
      setAssistantOrder: vi.fn(async () => {}),
      message: { success: vi.fn(), error: vi.fn(), warning, info: vi.fn() } as never,
    };
    const { result } = renderHook(() => useAssistantEditor(params));

    act(() => result.current.handleDeleteRequest(assistant()));
    expect(warning).toHaveBeenCalledWith("The default Agent can't be deleted.");
    expect(result.current.deleteConfirmVisible).toBe(false);

    act(() => result.current.handleDeleteRequest(assistant({ id: 'other' })));
    expect(result.current.deleteConfirmVisible).toBe(true);
  });
});

describe('creating, editing and deleting an Agent with its own skills and MCPs', () => {
  const detail = {
    id: 'mine',
    source: 'user',
    profile: { name: 'Researcher', name_i18n: {}, description: '', description_i18n: {}, avatar: '🤖' },
    state: { enabled: true, sort_order: 1 },
    engine: { agent_id: 'engine-a', agent: { type: 'acp', source: 'builtin', acp_backend: 'claude' } },
    rules: { content: 'Be brief.', storage_mode: 'user_file' },
    prompts: { recommended: [], recommended_i18n: {} },
    defaults: {
      model: { mode: 'auto' },
      permission: { mode: 'auto' },
      thought_level: { mode: 'auto' },
      skills: { mode: 'fixed', value: ['skill-one'] },
      mcps: { mode: 'fixed', value: ['mcp-a'] },
    },
    capabilities: { default_skill_ids: ['skill-one'], custom_skill_names: [], default_disabled_builtin_skill_ids: [] },
    preferences: {},
  };

  it('creates with its skills and MCPs, edits them, and deletes it', async () => {
    mocks.invoke.get.mockResolvedValue(detail);
    mocks.invoke.create.mockResolvedValue({ id: 'mine' });
    mocks.invoke.update.mockResolvedValue({ id: 'mine' });
    mocks.invoke.remove.mockResolvedValue(undefined);
    const message = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
    const params = {
      localeKey: 'en-US',
      activeAssistant: assistant(),
      setActiveAssistantId: vi.fn(),
      loadAssistants: vi.fn(),
      assistants: [] as AssistantListItem[],
      assistantOrder: [] as string[],
      setAssistantOrder: vi.fn(async () => {}),
      message: message as never,
      defaultEngineId: 'engine-a',
    };
    const { result } = renderHook(() => useAssistantEditor(params));

    // Create
    await act(async () => {
      await result.current.handleCreate();
    });
    act(() => {
      result.current.setEditName('Researcher');
      result.current.setDefaultSkillsMode('fixed');
      result.current.setSelectedSkills(['skill-one']);
      result.current.setDefaultMcpMode('fixed');
      result.current.setSelectedMcpIds(['mcp-a']);
      result.current.setEditContext('Be brief.');
    });
    await act(async () => {
      await result.current.handleSave();
    });
    expect(mocks.invoke.create).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Researcher',
        enabled_skills: ['skill-one'],
        defaults: expect.objectContaining({
          skills: { mode: 'fixed', value: ['skill-one'] },
          mcps: { mode: 'fixed', value: ['mcp-a'] },
        }),
      })
    );

    // Edit
    await act(async () => {
      await result.current.handleEdit(assistant());
    });
    await waitFor(() => expect(result.current.editName).toBe('Researcher'));
    act(() => {
      result.current.setEditName('Researcher 2');
      result.current.setSelectedMcpIds([]);
    });
    await act(async () => {
      await result.current.handleSave();
    });
    expect(mocks.invoke.update).toHaveBeenCalledWith(
      expect.objectContaining({
        id: 'mine',
        name: 'Researcher 2',
        defaults: expect.objectContaining({ mcps: { mode: 'fixed', value: [] } }),
      })
    );

    // Delete
    act(() => result.current.handleDeleteRequest(assistant()));
    await act(async () => {
      await result.current.handleDeleteConfirm();
    });
    expect(mocks.invoke.remove).toHaveBeenCalledWith({ id: 'mine' });
  });
});

describe('a new or edited Agent gets the AionUi rule block right away', () => {
  const build = () => {
    const message = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
    const params = {
      localeKey: 'zh-CN',
      activeAssistant: assistant(),
      setActiveAssistantId: vi.fn(),
      loadAssistants: vi.fn(),
      assistants: [] as AssistantListItem[],
      assistantOrder: [] as string[],
      setAssistantOrder: vi.fn(async () => {}),
      message: message as never,
      defaultEngineId: 'engine-a',
    };
    return { message, ...renderHook(() => useAssistantEditor(params)) };
  };

  it('asks main to add the block after writing the rule of a new Agent', async () => {
    mocks.invoke.create.mockResolvedValue({ id: 'new-agent' });
    const { result } = build();

    await act(async () => {
      await result.current.handleCreate();
    });
    act(() => {
      result.current.setEditName('Writer');
      result.current.setEditContext('Write well.');
    });
    await act(async () => {
      await result.current.handleSave();
    });

    // One write path: main composes the user text with the managed blocks; the editor never writes rules itself.
    expect(mocks.invoke.ensureRule).toHaveBeenCalledWith({
      assistantId: 'new-agent',
      locale: 'zh-CN',
      content: 'Write well.',
    });
    expect(mocks.invoke.writeRule).not.toHaveBeenCalled();
    expect(mocks.invoke.deleteRule).not.toHaveBeenCalled();
  });

  it('also does it for a new Agent without rules and after editing an existing one', async () => {
    mocks.invoke.create.mockResolvedValue({ id: 'bare-new' });
    mocks.invoke.update.mockResolvedValue({ id: 'mine' });
    mocks.invoke.get.mockResolvedValue({
      id: 'mine',
      source: 'user',
      profile: { name: 'Researcher', name_i18n: {}, description: '', description_i18n: {}, avatar: '' },
      state: { enabled: true, sort_order: 1 },
      engine: { agent_id: 'engine-a', agent: { type: 'acp', source: 'builtin', acp_backend: 'claude' } },
      rules: { content: 'old', storage_mode: 'user_file' },
      prompts: { recommended: [], recommended_i18n: {} },
      defaults: {
        model: { mode: 'auto' },
        permission: { mode: 'auto' },
        thought_level: { mode: 'auto' },
        skills: { mode: 'auto', value: [] },
        mcps: { mode: 'auto', value: [] },
      },
      capabilities: { default_skill_ids: [], custom_skill_names: [], default_disabled_builtin_skill_ids: [] },
      preferences: {},
    });
    const { result } = build();

    await act(async () => {
      await result.current.handleCreate();
    });
    act(() => result.current.setEditName('Bare'));
    await act(async () => {
      await result.current.handleSave();
    });
    expect(mocks.invoke.deleteRule).not.toHaveBeenCalled();
    expect(mocks.invoke.ensureRule).toHaveBeenCalledWith({ assistantId: 'bare-new', locale: 'zh-CN', content: '' });

    await act(async () => {
      await result.current.handleEdit(assistant());
    });
    await waitFor(() => expect(result.current.editName).toBe('Researcher'));
    await act(async () => {
      await result.current.handleSave();
    });
    expect(mocks.invoke.ensureRule).toHaveBeenCalledWith({ assistantId: 'mine', locale: 'zh-CN', content: 'old' });
  });

  it('reports the save as failed when main could not write the rule (the user text was not saved)', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.invoke.create.mockResolvedValue({ id: 'new-agent' });
    mocks.invoke.ensureRule.mockResolvedValue({ success: false, msg: 'backend down' });
    const { result, message } = build();

    await act(async () => {
      await result.current.handleCreate();
    });
    act(() => result.current.setEditName('Writer'));
    await act(async () => {
      await result.current.handleSave();
    });

    expect(message.error).toHaveBeenCalled();
    expect(message.success).not.toHaveBeenCalled();
  });
});

describe('the default Agent is protected before its id reaches the settings cache', () => {
  // First run: main created the Agent a moment ago, the renderer cache has no agent.builtinDefaultId yet.
  const defaultAgent = () => assistant({ id: DEFAULT_AGENT_ID, name: 'Agent' });

  it('disables Delete in the card menu', async () => {
    const onDelete = vi.fn();
    render(
      <ConfigProvider>
        <MyAssistantCard
          assistant={defaultAgent()}
          localeKey='en-US'
          onOpenDetail={vi.fn()}
          onDelete={onDelete}
          onToggleEnabled={vi.fn()}
          onStartChat={vi.fn()}
        />
      </ConfigProvider>
    );

    fireEvent.click(screen.getByTestId('btn-assistant-more-aion-default-agent'));
    const label = await screen.findByTestId(`menu-delete-${DEFAULT_AGENT_ID}`);
    expect(label.closest('[role="menuitem"]')?.className).toContain('disabled');
    fireEvent.click(label);
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('disables Delete in the editor', () => {
    render(
      <ConfigProvider>
        <AssistantEditorPage
          editor={
            {
              isCreating: false,
              profile: { name: 'Agent' },
              actions: { save: vi.fn(), requestDelete: vi.fn(), duplicate: vi.fn() },
            } as never
          }
          activeAssistant={defaultAgent()}
          onBack={vi.fn()}
        />
      </ConfigProvider>
    );

    expect(screen.getByTestId('btn-delete-assistant')).toBeDisabled();
  });

  it('refuses the delete request', () => {
    const warning = vi.fn();
    const { result } = renderHook(() =>
      useAssistantEditor({
        localeKey: 'en-US',
        activeAssistant: defaultAgent(),
        setActiveAssistantId: vi.fn(),
        loadAssistants: vi.fn(),
        assistants: [],
        assistantOrder: [],
        setAssistantOrder: vi.fn(async () => {}),
        message: { success: vi.fn(), error: vi.fn(), warning, info: vi.fn() } as never,
      })
    );

    act(() => result.current.handleDeleteRequest(defaultAgent()));
    act(() => result.current.handleDeleteClick());

    expect(warning).toHaveBeenCalledTimes(2);
    expect(result.current.deleteConfirmVisible).toBe(false);
  });
});

describe('useDefaultAgentSync', () => {
  it('stores the id main announces in the settings cache and refreshes the Agent list', () => {
    mocks.config.set('agent.builtinDefaultId', 'x'); // already known: no catch-up call needed
    renderHook(() => useDefaultAgentSync());

    act(() => mocks.ready.current?.({ id: DEFAULT_AGENT_ID }));

    expect(mocks.config.get('agent.builtinDefaultId')).toBe(DEFAULT_AGENT_ID);
    expect(mocks.swrMutate).toHaveBeenCalledWith('assistants.list');
    expect(mocks.invoke.ensureDefaultAgent).not.toHaveBeenCalled();
  });

  it('asks main to create the default Agent when none is known yet, once per engine state', async () => {
    const { rerender } = renderHook(() => useDefaultAgentSync());
    await waitFor(() => expect(mocks.invoke.ensureDefaultAgent).toHaveBeenCalledTimes(1));

    rerender();
    expect(mocks.invoke.ensureDefaultAgent).toHaveBeenCalledTimes(1);

    // An engine gets connected during the session: the engine list now has a usable engine.
    mocks.engines.current = [];
    rerender();
    mocks.engines.current = [{ id: 'engine-a', name: 'Engine Alpha' }];
    rerender();
    await waitFor(() => expect(mocks.invoke.ensureDefaultAgent).toHaveBeenCalledTimes(2));
    rerender();
    expect(mocks.invoke.ensureDefaultAgent).toHaveBeenCalledTimes(2);
  });
});

describe('the editor hides the AionUi managed rule blocks', () => {
  const BLOCK = '<!-- aion-browser-rule:start -->\nUse the pane.\n<!-- aion-browser-rule:end -->';
  const detailWith = (content: string) => ({
    id: 'mine',
    source: 'user',
    profile: { name: 'Researcher', name_i18n: {}, description: '', description_i18n: {}, avatar: '' },
    state: { enabled: true, sort_order: 1 },
    engine: { agent_id: 'engine-a', agent: { type: 'acp', source: 'builtin', acp_backend: 'claude' } },
    rules: { content, storage_mode: 'user_file' },
    prompts: { recommended: [], recommended_i18n: {} },
    defaults: {
      model: { mode: 'auto' },
      permission: { mode: 'auto' },
      thought_level: { mode: 'auto' },
      skills: { mode: 'auto', value: [] },
      mcps: { mode: 'auto', value: [] },
    },
    capabilities: { default_skill_ids: [], custom_skill_names: [], default_disabled_builtin_skill_ids: [] },
    preferences: {},
  });
  const build = (source: 'user' | 'builtin' = 'user') => {
    const message = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
    const active = assistant({ source });
    const hook = renderHook(() =>
      useAssistantEditor({
        localeKey: 'en-US',
        activeAssistant: active,
        setActiveAssistantId: vi.fn(),
        loadAssistants: vi.fn(),
        assistants: [],
        assistantOrder: [],
        setAssistantOrder: vi.fn(async () => {}),
        message: message as never,
      })
    );
    return { ...hook, message, active };
  };

  it('shows only the user text, and saving writes the user text for main to re-add the block', async () => {
    mocks.invoke.get.mockResolvedValue(detailWith(`Be brief.\n\n${BLOCK}\n`));
    mocks.invoke.update.mockResolvedValue({ id: 'mine' });
    const { result, active } = build();

    await act(async () => {
      await result.current.handleEdit(active);
    });
    await waitFor(() => expect(result.current.editContext).toBe('Be brief.'));

    await act(async () => {
      await result.current.handleSave();
    });
    expect(mocks.invoke.writeRule).not.toHaveBeenCalled();
    expect(mocks.invoke.ensureRule).toHaveBeenCalledWith({
      assistantId: 'mine',
      locale: 'en-US',
      content: 'Be brief.',
    });
  });

  it('also hides it in a duplicate', async () => {
    mocks.invoke.get.mockResolvedValue(detailWith(`Be brief.\n\n${BLOCK}\n`));
    const { result, active } = build();

    await act(async () => {
      await result.current.handleDuplicate(active);
    });

    await waitFor(() => expect(result.current.editContext).toBe('Be brief.'));
  });

  it('leaves a rule with broken markers fully visible so the user can fix it', async () => {
    const broken = 'Be brief.\n<!-- aion-browser-rule:start -->\nhalf';
    mocks.invoke.get.mockResolvedValue(detailWith(broken));
    const { result, active } = build();

    await act(async () => {
      await result.current.handleEdit(active);
    });

    await waitFor(() => expect(result.current.editContext).toBe(broken));
  });

  /** The settings page as the hook sees it: the active Agent follows the id the hook sets. */
  const buildLive = () => {
    const message = { success: vi.fn(), error: vi.fn(), warning: vi.fn(), info: vi.fn() };
    const hook = renderHook(() => {
      const [activeId, setActiveId] = React.useState<string | null>(null);
      return useAssistantEditor({
        localeKey: 'en-US',
        activeAssistant: activeId ? assistant({ id: activeId, name: 'Writer' }) : null,
        setActiveAssistantId: setActiveId,
        loadAssistants: vi.fn(async () => {}),
        assistants: [],
        assistantOrder: [],
        setAssistantOrder: vi.fn(async () => {}),
        message: message as never,
      });
    });
    return { ...hook, message };
  };

  it('a retry after a failed rule write updates the new Agent instead of creating a second one', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.invoke.create.mockResolvedValue({ id: 'new-agent' });
    mocks.invoke.update.mockResolvedValue({ id: 'new-agent' });
    mocks.invoke.ensureRule.mockResolvedValueOnce({ success: false, msg: 'Timed out writing the rule' });
    const { result, message } = buildLive();

    await act(async () => {
      await result.current.handleCreate();
    });
    act(() => {
      result.current.setEditName('Writer');
      result.current.setEditContext('Write well.');
    });
    await act(async () => {
      await result.current.handleSave();
    });
    expect(message.error).toHaveBeenCalledWith('Failed');
    expect(result.current.isCreating).toBe(false);

    await act(async () => {
      await result.current.handleSave();
    });
    expect(mocks.invoke.create).toHaveBeenCalledTimes(1);
    expect(mocks.invoke.update).toHaveBeenCalledWith(expect.objectContaining({ id: 'new-agent' }));
    expect(mocks.invoke.ensureRule).toHaveBeenLastCalledWith({
      assistantId: 'new-agent',
      locale: 'en-US',
      content: 'Write well.',
    });
  });

  it('says the instructions are too long, instead of a bare "Failed"', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    mocks.invoke.create.mockResolvedValue({ id: 'new-agent' });
    mocks.invoke.ensureRule.mockResolvedValue({ success: false, data: { tooLong: true }, msg: 'too long' });
    const { result, message } = build();

    await act(async () => {
      await result.current.handleCreate();
    });
    act(() => result.current.setEditName('Writer'));
    await act(async () => {
      await result.current.handleSave();
    });

    expect(message.error).toHaveBeenCalledWith('These instructions are too long');
    expect(message.error).not.toHaveBeenCalledWith('Failed');
    expect(message.success).not.toHaveBeenCalled();
  });

  it('asks the user to fix broken markers, instead of offering a restart that cannot help', async () => {
    mocks.invoke.create.mockResolvedValue({ id: 'new-agent' });
    mocks.invoke.ensureRule.mockResolvedValue({ success: false, data: { unbalanced: true }, msg: 'unbalanced' });
    const { result, message } = build();

    await act(async () => {
      await result.current.handleCreate();
    });
    act(() => {
      result.current.setEditName('Writer');
      result.current.setEditContext('oops <!-- aion-notes:start -->');
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(message.warning).toHaveBeenCalledWith("Fix the Pixebot Browser block markers in this Agent's instructions.");
    expect(message.warning).not.toHaveBeenCalledWith(expect.stringContaining('Restart'));
    expect(message.success).toHaveBeenCalled();
  });

  it('does not touch the rule of a built-in assistant when its engine settings are saved', async () => {
    mocks.invoke.get.mockResolvedValue({ ...detailWith('official rule'), source: 'builtin' });
    mocks.invoke.update.mockResolvedValue({ id: 'mine' });
    const { result, active } = build('builtin');

    await act(async () => {
      await result.current.handleEdit(active);
    });
    await act(async () => {
      await result.current.handleSave();
    });

    expect(mocks.invoke.update).toHaveBeenCalled();
    expect(mocks.invoke.writeRule).not.toHaveBeenCalled();
    expect(mocks.invoke.ensureRule).not.toHaveBeenCalled();
  });
});
