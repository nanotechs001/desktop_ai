/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Picking where a chat continues: an engine shows the model and thinking level it will use (both changeable) and only
 * Proceed switches; the same picker opens from the chat header for a switch at any time. An engine account that is not
 * signed in is shown but cannot be picked.
 */

import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const enConversation = JSON.parse(
  readFileSync(
    path.join(process.cwd(), 'packages/desktop/src/renderer/services/i18n/locales/en-US/conversation.json'),
    'utf8'
  )
) as Record<string, unknown>;

const translate = (key: string, params: Record<string, unknown> = {}): string => {
  const value = key
    .replace(/^conversation\./, '')
    .split('.')
    .reduce<unknown>(
      (node, part) => (node && typeof node === 'object' ? (node as Record<string, unknown>)[part] : undefined),
      enConversation
    );
  if (typeof value !== 'string') return key;
  return value.replace(/\{\{(\w+)\}\}/g, (_match, name: string) => String(params[name] ?? ''));
};

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: translate, i18n: { language: 'en-US' } }),
}));

// The model picker's dropdown and submenus open on hover in Arco; inline them so the test can pick a row directly.
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  const Menu = Object.assign(({ children }: { children?: React.ReactNode }) => <div role='menu'>{children}</div>, {
    Item: ({ children, onClick }: { children?: React.ReactNode; onClick?: () => void }) => (
      <div role='menuitem' onClick={onClick}>
        {children}
      </div>
    ),
    SubMenu: ({ children, title }: { children?: React.ReactNode; title?: React.ReactNode }) => (
      <div role='group'>
        <div>{title}</div>
        {children}
      </div>
    ),
  });
  return {
    ...actual,
    Menu,
    Dropdown: ({ children, droplist }: { children?: React.ReactNode; droplist?: React.ReactNode }) => (
      <div>
        {children}
        <div data-testid='droplist'>{droplist}</div>
      </div>
    ),
  };
});

const mocks = vi.hoisted(() => ({
  conversation: null as unknown,
  engines: [] as unknown[],
  providers: [] as unknown[],
  signedIn: {} as Record<string, boolean>,
  switchAndContinue: vi.fn(),
}));
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: async () => mocks.conversation,
}));
vi.mock('@/renderer/utils/model/agentTypes', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/utils/model/agentTypes')>()),
  fetchManagedAgentsOrThrow: async () => mocks.engines,
  fetchEngineAccountSignedIn: async () => mocks.signedIn,
}));
vi.mock('@/renderer/hooks/agent/useModelProviderList', () => ({
  useModelProviderList: () => ({
    providers: mocks.providers,
    getAvailableModels: (provider: { models: string[] }) => provider.models,
    formatModelLabel: (_provider: unknown, model: string) => model,
  }),
}));
vi.mock('@/renderer/pages/conversation/components/limitSwitch/switchAndContinue', () => ({
  pinnableAssistantId: () => 'bot-1',
  switchAndContinue: mocks.switchAndContinue,
}));

import LimitSwitchActions from '@/renderer/pages/conversation/components/limitSwitch/LimitSwitchActions';
import EngineSwitchButton from '@/renderer/pages/conversation/components/limitSwitch/EngineSwitchButton';

const select = (id: string, category: string, current: string, values: string[]) => ({
  id,
  category,
  type: 'select',
  current_value: current,
  options: values.map((value) => ({ value, name: value[0].toUpperCase() + value.slice(1) })),
});

const engine = (id: string, extra: Record<string, unknown> = {}) => ({
  id,
  name: `Engine ${id}`,
  agent_type: 'acp',
  backend: id,
  enabled: true,
  status: 'online',
  installed: true,
  ...extra,
});

const CODEX = engine('codex', {
  config_options: [
    select('model', 'model', 'gpt-5.5', ['gpt-5.5', 'gpt-5.4']),
    select('reasoning_effort', 'thought_level', 'medium', ['low', 'medium', 'high']),
  ],
});
const AION = engine('aionrs', { agent_type: 'aionrs', name: 'Aion' });
const OPENAI = { id: 'p1', name: 'OpenAI', platform: 'openai', models: ['gpt-4o', 'gpt-4.1'] };

const setUp = (conversationId: string) => {
  mocks.conversation = { id: conversationId, type: 'acp', extra: { agent_id: 'claude' }, assistant: { id: 'bot-1' } };
  mocks.engines = [engine('claude'), CODEX, AION];
  mocks.providers = [OPENAI];
  mocks.signedIn = {};
};

const renderIn = (conversationId: string, node: React.ReactNode) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <MemoryRouter initialEntries={[`/conversation/${conversationId}`]}>
        <Routes>
          <Route path={`/conversation/${conversationId}`} element={node} />
          <Route path='/conversation/:id' element={<div>opened new chat</div>} />
        </Routes>
      </MemoryRouter>
    </SWRConfig>
  );

const proceed = () => screen.getByRole('button', { name: translate('conversation.agentError.switch.proceed') });

describe('LimitSwitchActions picker', () => {
  afterEach(() => {
    cleanup();
    mocks.switchAndContinue.mockReset();
  });

  it('picking an engine shows the model and thinking level it will use and switches only on Proceed', async () => {
    setUp('c-pick');
    mocks.switchAndContinue.mockResolvedValue('c-new');
    renderIn('c-pick', <LimitSwitchActions conversationId='c-pick' />);

    expect(screen.queryByRole('button', { name: translate('conversation.agentError.switch.proceed') })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'Engine codex' }));

    expect(mocks.switchAndContinue).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Gpt-5\.5 · Medium/ })).toBeInTheDocument();

    fireEvent.click(proceed());
    expect(await screen.findByText('opened new chat')).toBeInTheDocument();
    // The shown model is the engine's own default: no model override; the shown thinking level is sent.
    expect(mocks.switchAndContinue).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'c-pick',
        target: { kind: 'engine', engine: CODEX, model: undefined, thoughtLevel: 'medium' },
      })
    );
  });

  it('switches with the model and thinking level the user changed', async () => {
    setUp('c-change');
    mocks.switchAndContinue.mockResolvedValue('c-new');
    renderIn('c-change', <LimitSwitchActions conversationId='c-change' />);
    fireEvent.click(await screen.findByRole('button', { name: 'Engine codex' }));

    const droplist = screen.getByTestId('droplist');
    fireEvent.click(within(droplist).getByRole('menuitem', { name: /Gpt-5\.4/ }));
    fireEvent.click(within(droplist).getByRole('menuitem', { name: /High/ }));
    expect(screen.getByRole('button', { name: /Gpt-5\.4 · High/ })).toBeInTheDocument();

    fireEvent.click(proceed());
    expect(await screen.findByText('opened new chat')).toBeInTheDocument();
    expect(mocks.switchAndContinue).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'engine', engine: CODEX, model: 'gpt-5.4', thoughtLevel: 'high' },
      })
    );
  });

  it("offers each provider, whose model is picked before Proceed (the chat's current one left out)", async () => {
    setUp('c-model');
    mocks.switchAndContinue.mockResolvedValue('c-new');
    renderIn('c-model', <LimitSwitchActions conversationId='c-model' />);
    expect(screen.queryByRole('button', { name: 'Aion' })).toBeNull();
    fireEvent.click(await screen.findByRole('button', { name: 'OpenAI' }));

    // The first model is preselected; another can be picked.
    expect(screen.getByTestId('guid-model-selector')).toHaveTextContent('gpt-4o');
    fireEvent.click(within(screen.getByTestId('droplist')).getByRole('menuitem', { name: /gpt-4\.1/ }));
    expect(screen.getByTestId('guid-model-selector')).toHaveTextContent('gpt-4.1');

    fireEvent.click(proceed());
    expect(await screen.findByText('opened new chat')).toBeInTheDocument();
    expect(mocks.switchAndContinue).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { kind: 'model', engine: AION, provider: OPENAI, model: 'gpt-4.1' },
      })
    );
  });

  it('shows an engine account that is not signed in as such, and does not let it be picked', async () => {
    setUp('c-accounts');
    const account = (id: string, label: string) =>
      engine(id, { backend: 'claude', name: `Claude · ${label}`, agent_source_info: { account_of: 'claude' } });
    mocks.engines = [engine('claude'), account('claude-work', 'Work'), account('claude-home', 'Home')];
    mocks.signedIn = { 'claude-work': false, 'claude-home': true };
    renderIn('c-accounts', <LimitSwitchActions conversationId='c-accounts' />);

    const notSignedIn = translate('conversation.agentError.switch.notSignedIn');
    expect(await screen.findByRole('button', { name: `Claude · Work · ${notSignedIn}` })).toBeDisabled();
    const home = screen.getByRole('button', { name: 'Claude · Home' });
    expect(home).toBeEnabled();
    fireEvent.click(home);
    expect(proceed()).toBeInTheDocument();
  });
});

describe('EngineSwitchButton', () => {
  afterEach(() => {
    cleanup();
    mocks.switchAndContinue.mockReset();
  });

  it('opens the same picker from the chat header and hands off as a switch the user chose', async () => {
    setUp('c-manual');
    mocks.switchAndContinue.mockResolvedValue('c-new');
    renderIn('c-manual', <EngineSwitchButton conversationId='c-manual' />);

    fireEvent.click(screen.getByRole('button', { name: translate('conversation.agentError.switch.headerButton') }));
    expect(await screen.findByText(translate('conversation.agentError.switch.titleManual'))).toBeInTheDocument();
    fireEvent.click(await screen.findByRole('button', { name: 'Engine codex' }));
    fireEvent.click(proceed());

    expect(await screen.findByText('opened new chat')).toBeInTheDocument();
    expect(mocks.switchAndContinue).toHaveBeenCalledWith(
      expect.objectContaining({
        conversationId: 'c-manual',
        labels: expect.objectContaining({ header: translate('conversation.agentError.switch.handoff.headerManual') }),
      })
    );
  });
});
