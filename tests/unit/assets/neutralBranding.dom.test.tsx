/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * A chat shows its Agent's name and avatar, never the engine's vendor. Vendor names stay in
 * Settings → Engine / Model and in the model chip. Lives under tests/unit/assets because the
 * renderer and conversation test directories are over the directory-size limit.
 */

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMessageText } from '@/common/chat/chatLib';
import type { PresetAssistantInfo } from '@/renderer/hooks/agent/usePresetAssistantInfo';

const VENDOR_NAMES = /Claude|Codex|Gemini|OpenAI|ChatGPT/i;
const BACKENDS = ['claude', 'codex', 'gemini', 'aionrs'] as const;
type Backend = (typeof BACKENDS)[number];

/** What the engine reports as its own name; it must never reach the screen outside the model chip. */
const ENGINE_NAMES: Record<Backend, string> = {
  claude: 'Claude Code',
  codex: 'Codex CLI',
  gemini: 'Gemini CLI',
  aionrs: 'OpenAI Compatible',
};

const mocks = vi.hoisted(() => ({
  presetInfo: { current: null as unknown },
  loading: { current: false },
}));

vi.mock('react-i18next', async () => {
  const [acp, agent, common] = await Promise.all([
    import('@/renderer/services/i18n/locales/en-US/acp.json'),
    import('@/renderer/services/i18n/locales/en-US/agent.json'),
    import('@/renderer/services/i18n/locales/en-US/common.json'),
  ]);
  const modules: Record<string, unknown> = { acp: acp.default, agent: agent.default, common: common.default };
  const t = (key: string, options?: Record<string, unknown>) => {
    const [moduleName, ...path] = key.split('.');
    const found = path.reduce<unknown>(
      (node, segment) => (node as Record<string, unknown> | undefined)?.[segment],
      modules[moduleName]
    );
    const fallback = typeof options?.defaultValue === 'string' ? options.defaultValue : key;
    const text = typeof found === 'string' ? found : fallback;
    return text.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(options?.[name] ?? ''));
  };
  return { useTranslation: () => ({ t, i18n: { language: 'en-US' } }) };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    fs: {
      getFileMetadata: { invoke: vi.fn() },
      getImageBase64: { invoke: vi.fn() },
      readFile: { invoke: vi.fn() },
      getContentMetadata: { invoke: vi.fn() },
      readContent: { invoke: vi.fn() },
    },
    conversation: {
      get: { invoke: vi.fn() },
      fork: { invoke: vi.fn() },
      ensureRuntime: { invoke: vi.fn() },
    },
  },
}));

// The conversation the chat is showing; its extras carry the engine's own name.
vi.mock('swr', () => ({
  __esModule: true,
  default: () => ({
    data: { id: 'conv-1', name: 'Weekly chat', type: 'acp', extra: { backend: 'claude', agent_name: 'Claude Code' } },
  }),
}));

vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));

vi.mock('@/renderer/hooks/agent/usePresetAssistantInfo', () => ({
  usePresetAssistantInfo: () => ({ info: mocks.presetInfo.current, isLoading: mocks.loading.current }),
}));

// Logos the engine would otherwise contribute (monochrome vendor marks served by the backend).
vi.mock('@/renderer/utils/model/agentLogo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/utils/model/agentLogo')>()),
  useAgentLogos: () => ({}),
  resolveAgentLogo: (_logos: unknown, opts: { backend?: string | null }) =>
    opts.backend ? `http://127.0.0.1:1/api/assets/logos/ai-major/${opts.backend}.svg` : null,
}));

vi.mock('@/renderer/hooks/context/FeedbackContext', () => ({ useFeedback: () => ({ openFeedback: vi.fn() }) }));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({ useLayoutContext: () => ({ isMobile: false }) }));
vi.mock('@/renderer/hooks/agent/useAcpConfigOptions', () => ({
  classifyConfigSetError: () => 'failed',
  useAcpConfigOptions: () => ({ mode: undefined, setStatus: { state: 'idle' }, pendingValues: {} }),
}));
vi.mock('@/renderer/hooks/agent/useAcpModelInfo', () => ({
  useAcpModelInfo: () => ({
    model_info: {
      current_model_id: 'claude-sonnet-4',
      current_model_label: 'Claude Sonnet 4',
      available_models: [{ id: 'claude-sonnet-4', label: 'Claude Sonnet 4' }],
    },
    isRuntimeReady: true,
    canSwitch: false,
    isLoading: false,
    isSetting: false,
    selectModel: vi.fn(),
    thoughtLevel: null,
    setStatus: { state: 'idle' },
    setConfigOption: vi.fn(),
    isConfigOptionBlocked: () => false,
  }),
}));

vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({ isOpen: false, openPreview: vi.fn() }),
  PreviewPanel: () => null,
}));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  usePreviewContext: () => ({ openPreview: vi.fn() }),
}));
vi.mock('@/renderer/pages/conversation/components/ChatLayout/MobileWorkspaceOverlay', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/components/ChatLayout/WorkspacePanelHeader', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/components/ChatTitleEditor', () => ({
  default: ({ leading, title }: { leading?: React.ReactNode; title?: string }) => (
    <div>
      {leading}
      <span>{title}</span>
    </div>
  ),
}));
vi.mock('@/renderer/components/layout/FlexFullContainer', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/renderer/hooks/ui/useResizableSplit', () => ({
  useResizableSplit: () => ({ splitRatio: 60, setSplitRatio: vi.fn(), createDragHandle: () => null }),
}));
vi.mock('@/renderer/pages/conversation/hooks/useContainerWidth', () => ({
  useContainerWidth: () => ({ containerRef: { current: null }, containerWidth: 800 }),
}));
vi.mock('@/renderer/pages/conversation/hooks/useLayoutConstraints', () => ({ useLayoutConstraints: () => undefined }));
vi.mock('@/renderer/pages/conversation/hooks/useTitleRename', () => ({
  useTitleRename: () => ({
    editingTitle: false,
    setEditingTitle: vi.fn(),
    titleDraft: '',
    setTitleDraft: vi.fn(),
    renameLoading: false,
    canRenameTitle: false,
    submitTitleRename: vi.fn(),
  }),
}));
vi.mock('@/renderer/pages/conversation/hooks/useWorkspaceCollapse', () => ({
  useWorkspaceCollapse: () => ({ rightSiderCollapsed: true, setRightSiderCollapsed: vi.fn() }),
}));

vi.mock('@/renderer/components/chat/CollapsibleContent', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock('@/renderer/components/Markdown', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/renderer/components/media/FilePreview', () => ({ __esModule: true, default: () => null }));
vi.mock('@/renderer/components/media/HorizontalFileList', () => ({
  __esModule: true,
  default: ({ children }: { children?: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/renderer/components/agent/MarqueePillLabel', () => ({
  default: ({ children }: { children?: React.ReactNode }) => <span>{children}</span>,
}));

import { AgentLogoIcon } from '@/renderer/components/agent/AgentLogoIcon';
import AcpModelSelector from '@/renderer/components/agent/AcpModelSelector';
import AgentModeSelector from '@/renderer/components/agent/AgentModeSelector';
import { RuntimeSelectorModelList } from '@/renderer/components/agent/runtimeSelectorOptions';
import MobileConversationBrand from '@/renderer/components/layout/Titlebar/MobileConversationBrand';
import { ConversationProvider } from '@/renderer/hooks/context/ConversationContext';
import ChatLayout from '@/renderer/pages/conversation/components/ChatLayout';
import MessageAgentStatus from '@/renderer/pages/conversation/Messages/components/MessageAgentStatus';
import MessageText from '@/renderer/pages/conversation/Messages/components/MessageText';
import GoogleModelSelector from '@/renderer/pages/conversation/platforms/gemini/GoogleModelSelector';
import AgentCard from '@/renderer/pages/settings/AgentSettings/AgentCard';
import type { GoogleModelSelection } from '@/renderer/pages/conversation/platforms/gemini/useGoogleModelSelection';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';

/** The identity usePresetAssistantInfo builds for a chat with no Agent record: the engine's own name and logo. */
const engineDerivedInfo = (backend: Backend): PresetAssistantInfo => ({
  name: ENGINE_NAMES[backend],
  logo: `http://127.0.0.1:1/api/assets/logos/ai-major/${backend}.svg`,
  isEmoji: false,
  backend,
});

const teammateMessage = (backend: Backend): IMessageText => ({
  id: 'm1',
  msg_id: 'm1',
  conversation_id: 'conv-1',
  type: 'text',
  position: 'left',
  createdAt: Date.now(),
  content: {
    content: 'Done.',
    teammateMessage: true,
    senderName: 'Writer',
    senderConversationId: 'writer-conv',
    senderAgentType: backend,
  },
});

/** Text a user can read or hear: visible text plus alt, title, aria-label and logo URLs (not test ids). */
const userFacingText = (container: HTMLElement): string =>
  [
    container.textContent ?? '',
    ...Array.from(container.querySelectorAll('[alt],[title],[aria-label],[src],[placeholder]')).flatMap((element) =>
      ['alt', 'title', 'aria-label', 'src', 'placeholder'].map((name) => element.getAttribute(name) ?? '')
    ),
  ].join('\n');

const renderChat = (backend: Backend) =>
  render(
    <ConversationProvider value={{ conversation_id: 'conv-1', workspace: '/workspace', type: 'acp' }}>
      <MessageAgentStatus
        message={{
          id: 's1',
          conversation_id: 'conv-1',
          type: 'agent_status',
          content: { backend, status: 'connected', agent_name: ENGINE_NAMES[backend] },
        }}
      />
      <MobileConversationBrand conversation_id='conv-1' fallbackTitle='Chat' />
      <AgentLogoIcon />
      <AgentModeSelector backend={backend} compact showLogoInCompact />
      <ChatLayout
        sider={<div />}
        workspaceEnabled={false}
        title='Weekly chat'
        backend={backend}
        presetAssistant={mocks.presetInfo.current as PresetAssistantInfo}
      >
        <MessageText message={teammateMessage(backend)} />
      </ChatLayout>
    </ConversationProvider>
  );

describe('neutral Agent branding', () => {
  beforeEach(() => {
    // ThemedLogo probes each logo URL before it draws the image.
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve({ ok: true, text: () => Promise.resolve('<svg></svg>') }))
    );
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    mocks.presetInfo.current = null;
    mocks.loading.current = false;
  });

  it.each(BACKENDS)('a %s chat renders no vendor name outside the model chip', async (backend) => {
    mocks.presetInfo.current = engineDerivedInfo(backend);

    const { container } = renderChat(backend);
    await act(async () => {
      await Promise.resolve();
    });

    expect(userFacingText(container)).not.toMatch(VENDOR_NAMES);
    expect(screen.getAllByText('Agent').length).toBeGreaterThan(0);
  });

  it("shows the chat's Agent name and avatar when it has one", () => {
    mocks.presetInfo.current = {
      ...engineDerivedInfo('claude'),
      name: 'Research Agent',
      logo: '🔬',
      isEmoji: true,
      assistantId: 'a1',
    };

    render(<MobileConversationBrand conversation_id='conv-1' fallbackTitle='Chat' />);

    expect(screen.getByText('🔬')).toBeInTheDocument();
  });

  it('send box placeholder is "Message the agent…"', async () => {
    const { useTranslation } = await import('react-i18next');
    const { t } = useTranslation();

    // The legacy call sites still pass the engine's name; it must not be interpolated.
    expect(t('acp.sendbox.placeholder', { backend: 'Claude Code' })).toBe('Message the agent…');
  });

  it('status line reads "Agent connected"', () => {
    render(
      <MessageAgentStatus
        message={{
          id: 's1',
          conversation_id: 'conv-1',
          type: 'agent_status',
          content: { backend: 'codex', status: 'connected', agent_name: 'Codex' },
        }}
      />
    );

    expect(screen.getByText('Agent connected')).toBeInTheDocument();
  });

  it("model chip still shows the agent's model names", () => {
    render(<AcpModelSelector conversation_id='conv-1' backend='claude' />);

    expect(screen.getByText('Claude Sonnet 4')).toBeInTheDocument();
  });

  it('model lists keep model names but drop vendor group labels', () => {
    render(
      <RuntimeSelectorModelList
        groups={[{ key: 'anthropic', title: 'Anthropic', models: [{ id: 'm1', label: 'Claude Sonnet 4' }] }]}
        onSelect={vi.fn()}
      />
    );

    expect(screen.getByText('Claude Sonnet 4')).toBeInTheDocument();
    expect(screen.queryByText('Anthropic')).not.toBeInTheDocument();
  });

  it('settings agent list still shows vendor names', () => {
    const engine = { id: 'claude', name: 'Claude Code', backend: 'claude', agent_type: 'claude' } as ManagedAgent;

    render(
      <AgentCard type='official' agent={engine} boundAssistants={[]} onTestConnection={vi.fn()} onConfigure={vi.fn()} />
    );

    expect(screen.getByText('Claude Code')).toBeInTheDocument();
  });
  describe('while the Agent is loading or named', () => {
    const named = { name: 'Research Agent', logo: '🔬', isEmoji: true, backend: 'claude', assistantId: 'research' };

    it('shows no vendor and no leading mark in the header while the Agent loads', () => {
      mocks.presetInfo.current = null;
      mocks.loading.current = true;

      const { container } = render(
        <ChatLayout sider={<div />} workspaceEnabled={false} title='Weekly chat'>
          <div />
        </ChatLayout>
      );

      expect(userFacingText(container)).not.toMatch(VENDOR_NAMES);
      expect(container.querySelector('.i-icon-robot')).toBeNull();
    });

    it('shows the robot for the sender while the Agent loads', () => {
      mocks.presetInfo.current = null;
      mocks.loading.current = true;

      const { container } = render(<MessageText message={teammateMessage('claude')} />);

      expect(container.querySelector('.i-icon-robot')).not.toBeNull();
      expect(userFacingText(container)).not.toMatch(VENDOR_NAMES);
    });

    it("shows the named Agent's avatar in the header and for the sender", () => {
      mocks.presetInfo.current = named;

      const header = render(
        <ChatLayout
          sider={<div />}
          workspaceEnabled={false}
          title='Weekly chat'
          backend='claude'
          presetAssistant={named as PresetAssistantInfo}
        >
          <div />
        </ChatLayout>
      );
      expect(header.getByText('🔬')).toBeInTheDocument();
      header.unmount();

      const sender = render(<MessageText message={teammateMessage('claude')} />);
      expect(sender.getByText('🔬')).toBeInTheDocument();
    });

    it("names the chat's Agent on the status line", () => {
      mocks.presetInfo.current = named;

      render(
        <ConversationProvider value={{ conversation_id: 'conv-1', workspace: '/workspace', type: 'acp' }}>
          <MessageAgentStatus
            message={{
              id: 's1',
              conversation_id: 'conv-1',
              type: 'agent_status',
              content: { backend: 'claude', status: 'connected', agent_name: 'Claude Code' },
            }}
          />
        </ConversationProvider>
      );

      expect(screen.getByText('Research Agent')).toBeInTheDocument();
      expect(screen.getByText('Agent connected')).toBeInTheDocument();
      expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
    });
  });

  describe('GoogleModelSelector provider titles', () => {
    const selection = {
      providers: [{ id: 'p1', name: 'Anthropic' }],
      getAvailableModels: () => ['claude-sonnet-4'],
      handleSelectModel: vi.fn(),
      formatModelLabel: (_provider: unknown, name?: string) => name ?? '',
      getDisplayModelName: (name?: string) => name ?? '',
    } as unknown as GoogleModelSelection;

    it('lists models without the provider name in chat', () => {
      render(<GoogleModelSelector selection={selection} />);
      fireEvent.click(screen.getByTestId('chat-model-selector'));

      expect(screen.getByText('claude-sonnet-4')).toBeInTheDocument();
      expect(screen.queryByText('Anthropic')).not.toBeInTheDocument();
    });

    it('keeps provider titles where the provider is chosen in Settings', () => {
      render(<GoogleModelSelector selection={selection} showProviderTitles variant='settings' />);
      fireEvent.click(screen.getByRole('button'));

      expect(screen.getByText('Anthropic')).toBeInTheDocument();
    });
  });
});
