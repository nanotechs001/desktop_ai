/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Verifies MessageTips copy rendering and the agent error locale copy.
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const enConversation = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales/en-US/conversation.json'),
    'utf8'
  )
);

const i18nConfig = JSON.parse(
  readFileSync(path.join(process.cwd(), 'packages/desktop/src/common/config/i18n-config.json'), 'utf8')
) as { supportedLanguages: string[] };

const supportedLocaleNames = i18nConfig.supportedLanguages;

const resolveConversationKey = (key: string): unknown => {
  if (!key.startsWith('conversation.')) return undefined;

  return key
    .replace(/^conversation\./, '')
    .split('.')
    .reduce<unknown>((current, part) => {
      if (!current || typeof current !== 'object') return undefined;
      return (current as Record<string, unknown>)[part];
    }, enConversation);
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => {
      const value = resolveConversationKey(key);
      return typeof value === 'string' ? value : (options?.defaultValue ?? key);
    },
    i18n: { language: 'en' },
  }),
}));

// CollapsibleContent uses ResizeObserver and runtime theme context — stub it
// so tests don't have to pull in the entire theme provider tree.
vi.mock('@renderer/components/chat/CollapsibleContent', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// MarkdownView pulls in a heavy markdown pipeline — replace with a passthrough.
vi.mock('@renderer/components/Markdown', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

// The switch section's data sources and action, so a test controls exactly what it offers.
const switchMocks = vi.hoisted(() => ({
  conversation: null as unknown,
  engines: [] as unknown[],
  providers: [] as unknown[],
  switchAndContinue: vi.fn(),
}));
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: async () => switchMocks.conversation,
}));
vi.mock('@/renderer/utils/model/agentTypes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/utils/model/agentTypes')>()),
  fetchManagedAgentsOrThrow: async () => switchMocks.engines,
}));
vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  useModelProviderList: () => ({
    providers: switchMocks.providers,
    getAvailableModels: (provider: { models?: string[] }) => provider.models ?? [],
    formatModelLabel: (_provider: unknown, model?: string) => model ?? '',
  }),
}));
vi.mock('@/renderer/pages/conversation/components/limitSwitch/switchAndContinue', () => ({
  pinnableAssistantId: () => 'bot-1',
  switchAndContinue: switchMocks.switchAndContinue,
}));

import MessageTips from '@/renderer/pages/conversation/Messages/components/MessageTips';
import type { AgentStreamErrorInfo, IMessageTips } from '@/common/chat/chatLib';

const requiredAgentErrorCodes = [
  'AIONUI_CONVERSATION_BUSY',
  'USER_AGENT_HANDSHAKE_FAILED',
  'USER_AGENT_HANDSHAKE_TIMEOUT',
  'USER_AGENT_ACP_INIT_FAILED',
  'USER_AGENT_PROTOCOL_PARSE_ERROR',
  'USER_AGENT_INVALID_REQUEST',
  'USER_AGENT_RESOURCE_NOT_FOUND',
  'USER_AGENT_PROTOCOL_ERROR',
  'USER_AGENT_PROTOCOL_MISMATCH',
  'USER_AGENT_NO_PREVIOUS_SESSION',
  'USER_AGENT_COMMAND_NOT_FOUND',
  'USER_AGENT_MISSING_ENV',
  'USER_LLM_PROVIDER_AWS_SSO_EXPIRED',
  'USER_LLM_PROVIDER_PERMISSION_DENIED',
  'USER_LLM_PROVIDER_BILLING_REQUIRED',
  'USER_LLM_PROVIDER_UNSUPPORTED_MODEL',
  'USER_LLM_PROVIDER_ENDPOINT_NOT_FOUND',
  'USER_LLM_PROVIDER_INVALID_REQUEST',
  'USER_LLM_PROVIDER_INVALID_TOOL_SCHEMA',
  'USER_LLM_PROVIDER_CONTEXT_TOO_LARGE',
  'USER_LLM_PROVIDER_EMPTY_RESPONSE',
  'USER_LLM_PROVIDER_USAGE_LIMITED',
] as const;

const requiredAgentTipCodes = [
  'ACP_EMPTY_TURN',
  'ACP_EMPTY_TURN_MAX_TOKENS',
  'ACP_EMPTY_TURN_MAX_TURN_REQUESTS',
  'ACP_EMPTY_TURN_REFUSAL',
] as const;

const buildTips = (
  type: IMessageTips['content']['type'],
  content = 'boom',
  error?: AgentStreamErrorInfo,
  extra?: Pick<IMessageTips['content'], 'code' | 'params'>
): IMessageTips =>
  ({
    id: 'tip-1',
    type: 'tips',
    content: { type, content, ...(error ? { error } : {}), ...extra },
  }) as IMessageTips;

describe('MessageTips', () => {
  afterEach(() => {
    cleanup();
  });

  it('renders HTML-like error text as literal text', () => {
    const { container } = render(<MessageTips message={buildTips('error', '<strong>boom</strong>')} />);

    expect(container.querySelector('strong')).not.toBeInTheDocument();
    expect(screen.getByText('<strong>boom</strong>')).toBeInTheDocument();
  });

  it('renders localized info tips as plain text without icon', () => {
    const { container } = render(
      <MessageTips
        message={buildTips('info', '', undefined, {
          code: 'ACP_EMPTY_TURN',
          params: { provider: 'OpenCode' },
        })}
      />
    );

    expect(screen.getByText('This request produced no visible reply.')).toBeInTheDocument();
    expect(container.querySelector('svg')).not.toBeInTheDocument();
  });

  it('renders the same localized copy for command empty turns', () => {
    render(
      <MessageTips
        message={buildTips('info', '', undefined, {
          code: 'ACP_EMPTY_TURN',
        })}
      />
    );

    expect(screen.getByText('This request produced no visible reply.')).toBeInTheDocument();
  });

  it('renders localized warning tips from code-only payloads', () => {
    render(
      <MessageTips
        message={buildTips('warning', '', undefined, {
          code: 'ACP_EMPTY_TURN_MAX_TOKENS',
        })}
      />
    );

    expect(
      screen.getByText("This request hit the model's output token limit before any visible reply was produced.")
    ).toBeInTheDocument();
  });

  it('renders classified provider errors with friendly copy', () => {
    render(
      <MessageTips
        message={buildTips('error', 'raw provider 401', {
          message: 'raw provider 401',
          code: 'USER_LLM_PROVIDER_AUTH_FAILED',
          ownership: 'user_llm_provider',
          detail: 'Provider returned 401.',
          retryable: false,
          feedback_recommended: false,
        })}
      />
    );

    expect(screen.getByText('Model provider authentication failed')).toBeInTheDocument();
    expect(screen.getByText(/rejected the API key or account credentials/)).toBeInTheDocument();
    expect(screen.getByText('Model provider')).toBeInTheDocument();
    expect(screen.getByText('Needs configuration')).toBeInTheDocument();
  });

  it('renders AWS SSO provider auth code as localized user guidance', () => {
    render(
      <MessageTips
        message={buildTips('error', 'The model provider rejected the request', {
          message: 'The model provider rejected the request',
          code: 'USER_LLM_PROVIDER_AWS_SSO_EXPIRED',
          ownership: 'user_llm_provider',
          retryable: false,
          feedback_recommended: false,
          resolution: {
            kind: 'check_provider_credentials',
            target: 'provider_settings',
          },
        })}
      />
    );

    expect(
      screen.getByText(
        "Your AWS SSO session has expired. Run 'aws sso login' for the matching profile, then send the message again."
      )
    ).toBeInTheDocument();
  });

  it('renders structured error resolution guidance', () => {
    render(
      <MessageTips
        message={buildTips('error', 'raw provider billing error', {
          message: 'raw provider billing error',
          code: 'USER_LLM_PROVIDER_BILLING_REQUIRED',
          ownership: 'user_llm_provider',
          detail: 'Provider billing limit exceeded.',
          retryable: false,
          feedback_recommended: false,
          resolution: {
            kind: 'check_provider_billing',
            target: 'provider_settings',
          },
        })}
      />
    );

    expect(screen.getByText('Suggestion: Check the model provider balance, credits, or quota.')).toBeInTheDocument();
  });

  it('renders billing-required provider errors from i18n instead of backend fallback text', () => {
    render(
      <MessageTips
        message={buildTips('error', 'backend billing required fallback', {
          message: 'backend billing required fallback',
          code: 'USER_LLM_PROVIDER_BILLING_REQUIRED',
          ownership: 'user_llm_provider',
          detail: 'Provider billing check failed.',
          retryable: false,
          feedback_recommended: false,
        })}
      />
    );

    expect(screen.getByText('Model provider billing is required')).toBeInTheDocument();
    expect(screen.getByText(/needs active billing, credits, or quota/)).toBeInTheDocument();
    expect(screen.queryByText('backend billing required fallback')).not.toBeInTheDocument();
  });

  it('keeps generic startup failures on the existing startup copy', () => {
    render(
      <MessageTips
        message={buildTips('error', 'backend startup fallback', {
          message: 'Agent process exited before initialize handshake completed',
          code: 'USER_AGENT_STARTUP_FAILED',
          ownership: 'user_agent',
          detail: 'Agent process exited before initialize handshake completed (exit code 1)',
          retryable: true,
          feedback_recommended: false,
          resolution: {
            kind: 'check_agent_installation',
            target: 'agent_settings',
          },
        })}
      />
    );

    expect(screen.getByText('The selected agent failed to start')).toBeInTheDocument();
  });

  it('renders ACP protocol errors with agent attribution and technical details only', () => {
    render(
      <MessageTips
        message={buildTips('error', 'backend protocol fallback', {
          message: 'Agent protocol parse error',
          code: 'USER_AGENT_PROTOCOL_PARSE_ERROR',
          ownership: 'user_agent',
          detail: 'Agent protocol parse error: Parse error',
          retryable: false,
          feedback_recommended: false,
        })}
      />
    );

    expect(screen.getByText('Agent')).toBeInTheDocument();
    expect(screen.getByText('Agent reported a protocol parse error')).toBeInTheDocument();
    expect(screen.getByText(/reported that an ACP\/JSON-RPC message could not be parsed/)).toBeInTheDocument();
    expect(screen.queryByText(/Suggestion:/)).not.toBeInTheDocument();
    expect(screen.getByText(/USER_AGENT_PROTOCOL_PARSE_ERROR/)).toBeInTheDocument();
    expect(screen.queryByText('backend protocol fallback')).not.toBeInTheDocument();
  });

  it('expands classified error technical details by default', () => {
    render(
      <MessageTips
        message={buildTips('error', 'raw provider 401', {
          message: 'raw provider 401',
          code: 'USER_LLM_PROVIDER_AUTH_FAILED',
          ownership: 'user_llm_provider',
          detail: 'Provider returned 401.',
          retryable: false,
          feedback_recommended: false,
        })}
      />
    );

    const detailsToggle = screen.getByRole('button', { name: /common.technical_details/ });
    expect(detailsToggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(/Provider returned 401/)).toBeInTheDocument();
  });
});

const engine = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Engine ${id}`,
  agent_type: 'acp',
  enabled: true,
  status: 'online',
  installed: true,
  ...extra,
});

describe('MessageTips switch and continue', () => {
  const usageLimited = (kind: 'switch_engine' | 'retry') =>
    ({
      ...buildTips('error', 'limit', {
        message: 'The plan usage limit was reached',
        code: 'USER_LLM_PROVIDER_USAGE_LIMITED',
        ownership: 'user_llm_provider',
        retryable: false,
        resolution: { kind },
      }),
      conversation_id: 'c1',
    }) as IMessageTips;
  const renderTips = (message: IMessageTips) =>
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <MemoryRouter initialEntries={['/conversation/c1']}>
          <Routes>
            <Route path='/conversation/c1' element={<MessageTips message={message} />} />
            <Route path='/conversation/:id' element={<div>opened new chat</div>} />
          </Routes>
        </MemoryRouter>
      </SWRConfig>
    );

  afterEach(() => {
    cleanup();
    switchMocks.switchAndContinue.mockReset();
  });

  it('offers only other connected engines and configured provider models', async () => {
    switchMocks.conversation = { id: 'c1', type: 'acp', extra: { agent_id: 'claude' }, assistant: { id: 'bot-1' } };
    switchMocks.engines = [
      engine('claude'),
      engine('codex'),
      engine('missing', { status: 'missing', installed: false }),
      engine('disabled', { enabled: false }),
      engine('aionrs', { agent_type: 'aionrs' }),
    ];
    switchMocks.providers = [{ id: 'openrouter', name: 'OpenRouter', platform: 'custom', models: ['m1'] }];

    renderTips(usageLimited('switch_engine'));

    expect(await screen.findByText('Switch and continue:')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Engine codex' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /OpenRouter/ })).toBeInTheDocument();
    for (const hidden of ['Engine claude', 'Engine missing', 'Engine disabled', 'Engine aionrs']) {
      expect(screen.queryByRole('button', { name: hidden })).not.toBeInTheDocument();
    }
  });

  it('switches and opens the new chat on click', async () => {
    switchMocks.conversation = { id: 'c1', type: 'acp', extra: { agent_id: 'claude' }, assistant: { id: 'bot-1' } };
    switchMocks.engines = [engine('claude'), engine('codex')];
    switchMocks.providers = [];
    switchMocks.switchAndContinue.mockResolvedValue('c2');

    renderTips(usageLimited('switch_engine'));
    fireEvent.click(await screen.findByRole('button', { name: 'Engine codex' }));

    expect(await screen.findByText('opened new chat')).toBeInTheDocument();
    expect(switchMocks.switchAndContinue).toHaveBeenCalledWith(
      expect.objectContaining({ conversationId: 'c1', target: { kind: 'engine', engine: switchMocks.engines[1] } })
    );
  });

  it('points to Settings when there is nothing to switch to', async () => {
    switchMocks.conversation = { id: 'c1', type: 'acp', extra: { agent_id: 'claude' } };
    switchMocks.engines = [engine('claude')];
    switchMocks.providers = [];

    renderTips(usageLimited('switch_engine'));

    expect(await screen.findByText('Add an engine in Settings')).toBeInTheDocument();
    expect(screen.queryByText('Switch and continue:')).not.toBeInTheDocument();
  });

  it('shows no switch section for other resolutions', async () => {
    switchMocks.conversation = { id: 'c1', type: 'acp', extra: { agent_id: 'claude' } };
    switchMocks.engines = [engine('claude'), engine('codex')];

    renderTips(usageLimited('retry'));

    expect(await screen.findByText('Plan usage limit reached')).toBeInTheDocument();
    expect(screen.queryByText('Switch and continue:')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Engine codex' })).not.toBeInTheDocument();
  });
});

describe('agent error locale copy', () => {
  it('defines empty-turn info tip copy in every locale', () => {
    const localeDir = path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales');

    for (const localeName of supportedLocaleNames) {
      const locale = JSON.parse(readFileSync(path.join(localeDir, localeName, 'conversation.json'), 'utf8'));

      for (const code of requiredAgentTipCodes) {
        expect(locale.agentTip.codes[code]?.body, `${localeName} ${code} body`).toEqual(expect.any(String));
        expect(locale.agentTip.codes[code]?.body.trim(), `${localeName} ${code} body`).not.toBe('');
      }
    }
  });

  it('defines title and body copy for newly classified agent error codes in every locale', () => {
    const localeDir = path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales');

    for (const localeName of supportedLocaleNames) {
      const locale = JSON.parse(readFileSync(path.join(localeDir, localeName, 'conversation.json'), 'utf8'));

      expect(locale.agentError.resolutionPrefix, `${localeName} resolution prefix`).toEqual(expect.any(String));
      expect(locale.agentError.resolutionPrefix.trim(), `${localeName} resolution prefix`).not.toBe('');

      for (const code of requiredAgentErrorCodes) {
        expect(locale.agentError.codes[code]?.title, `${localeName} ${code} title`).toEqual(expect.any(String));
        expect(locale.agentError.codes[code]?.title.trim(), `${localeName} ${code} title`).not.toBe('');
        expect(locale.agentError.codes[code]?.body, `${localeName} ${code} body`).toEqual(expect.any(String));
        expect(locale.agentError.codes[code]?.body.trim(), `${localeName} ${code} body`).not.toBe('');
      }
    }
  });

  it('keeps agent error copy localized outside English and Chinese locales', () => {
    const localeDir = path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales');
    const localeNames = supportedLocaleNames.filter((localeName) => !['en-US', 'zh-CN', 'zh-TW'].includes(localeName));

    for (const localeName of localeNames) {
      const locale = JSON.parse(readFileSync(path.join(localeDir, localeName, 'conversation.json'), 'utf8'));
      const agentError = locale.agentError;

      expect(agentError.fallbackTitle, localeName).not.toBe('The agent could not reply');
      expect(agentError.errorCode, localeName).not.toBe('Error code');
      expect(agentError.resolutionPrefix, localeName).not.toBe('Suggestion: ');
      expect(agentError.codes.USER_AGENT_ACP_INIT_FAILED.title, localeName).not.toBe(
        'Agent protocol initialization failed'
      );
      expect(agentError.codes.USER_LLM_PROVIDER_BILLING_REQUIRED.title, localeName).not.toBe(
        'Model provider billing is required'
      );
    }
  });

  it('does not label app-side errors as direct AionUi ownership', () => {
    const localeDir = path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales');

    for (const localeName of supportedLocaleNames) {
      const locale = JSON.parse(readFileSync(path.join(localeDir, localeName, 'conversation.json'), 'utf8'));
      const agentError = locale.agentError;

      expect(agentError.ownership.aionui, localeName).not.toMatch(/AionUi/);

      for (const [code, copy] of Object.entries<Record<string, string>>(agentError.codes)) {
        if (!code.startsWith('AIONUI_')) continue;

        expect(copy.title, `${localeName} ${code} title`).not.toMatch(/AionUi/);
        expect(copy.body, `${localeName} ${code} body`).not.toMatch(/AionUi/);
      }
    }
  });

  it('does not describe ACP protocol fallback errors as app recognition bugs', () => {
    const localeDir = path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales');

    for (const localeName of supportedLocaleNames) {
      const locale = JSON.parse(readFileSync(path.join(localeDir, localeName, 'conversation.json'), 'utf8'));
      const body = locale.agentError.codes.USER_AGENT_PROTOCOL_ERROR.body;

      expect(body, `${localeName} USER_AGENT_PROTOCOL_ERROR body`).not.toMatch(/app does not recognize/i);
      expect(body, `${localeName} USER_AGENT_PROTOCOL_ERROR body`).not.toMatch(/应用暂未识别/);
      expect(body, `${localeName} USER_AGENT_PROTOCOL_ERROR body`).not.toMatch(/應用暫未識別/);
    }
  });

  it('does not add speculative remediation to ACP protocol error copy', () => {
    const localeDir = path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales');
    const protocolCodes = [
      'USER_AGENT_SESSION_NOT_FOUND',
      'USER_AGENT_UNSUPPORTED_METHOD',
      'USER_AGENT_INVALID_PARAMS',
      'USER_AGENT_ACP_INIT_FAILED',
      'USER_AGENT_PROTOCOL_PARSE_ERROR',
      'USER_AGENT_INVALID_REQUEST',
      'USER_AGENT_RESOURCE_NOT_FOUND',
      'USER_AGENT_PROTOCOL_ERROR',
      'USER_AGENT_PROTOCOL_MISMATCH',
    ];
    const speculativeFragments = [
      /update/i,
      /switch/i,
      /reconnect/i,
      /feedback/i,
      /technical detail/i,
      /升级/,
      /切换/,
      /重新连接/,
      /重连/,
      /反馈/,
      /技术详情/,
      /技術詳情/,
      /回饋/,
    ];

    for (const localeName of ['en-US', 'zh-CN', 'zh-TW']) {
      const locale = JSON.parse(readFileSync(path.join(localeDir, localeName, 'conversation.json'), 'utf8'));

      for (const code of protocolCodes) {
        const copy = locale.agentError.codes[code];
        const text = `${copy.title}\n${copy.body}`;

        for (const fragment of speculativeFragments) {
          expect(text, `${localeName} ${code}`).not.toMatch(fragment);
        }
      }
    }
  });
});
