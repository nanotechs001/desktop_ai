/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Engine accounts in Settings -> Agent: adding another login of the claude engine, signing it in from a terminal
 * (or the command, when the terminal cannot open), its Not signed in tag, removing it, and each login's own 5-hour and
 * weekly usage.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';

// t() echoes the key, with its params, so text and values are assertable.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
    i18n: { language: 'en' },
  }),
}));

const mocks = vi.hoisted(() => ({
  createAgentAccount: vi.fn(),
  deleteAgentAccount: vi.fn(),
  signInAgentAccount: vi.fn(),
  listAgentAccountStatus: vi.fn(),
  copyText: vi.fn(),
  message: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
  usage: {} as Record<string, unknown>,
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    acpConversation: {
      createAgentAccount: { invoke: mocks.createAgentAccount },
      deleteAgentAccount: { invoke: mocks.deleteAgentAccount },
      signInAgentAccount: { invoke: mocks.signInAgentAccount },
      listAgentAccountStatus: { invoke: mocks.listAgentAccountStatus },
    },
  },
}));
vi.mock('@/renderer/utils/ui/clipboard', () => ({ copyText: mocks.copyText }));
// Arco's global Message renders through a legacy ReactDOM API this React version lacks.
vi.mock('@arco-design/web-react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@arco-design/web-react')>()),
  Message: mocks.message,
}));
vi.mock('@/renderer/pages/conversation/components/limitSwitch/subscriptionUsage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/pages/conversation/components/limitSwitch/subscriptionUsage')>()),
  useAllSubscriptionUsage: () => mocks.usage,
}));

import {
  AddEngineAccountButton,
  canAddEngineAccount,
  EngineAccountActions,
  EngineUsageLine,
} from '@/renderer/pages/settings/AgentSettings/EngineAccounts';
import type { ManagedAgent } from '@/renderer/utils/model/agentTypes';

const NOW_MS = 1_785_000_000_000;

const claude = {
  id: 'claude-main',
  name: 'Claude Code',
  agent_type: 'acp',
  agent_source: 'builtin',
  backend: 'claude',
  enabled: true,
  available: true,
} as ManagedAgent;
const account = {
  ...claude,
  id: 'claude-work',
  name: 'Claude Code · Work',
  agent_source_info: { account_of: 'claude-main', account_dir: '/data/accounts/claude-work' },
} as ManagedAgent;

const reading = (fiveHour: number, week: number) => ({
  windows: { five_hour: { utilization: fiveHour, resets_at: null }, seven_day: { utilization: week, resets_at: null } },
  updated_at: NOW_MS,
});

// A fresh SWR cache per render, so one test's sign-in status never reaches the next.
const renderActions = (agent: ManagedAgent) =>
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <EngineAccountActions agent={agent} onChanged={vi.fn()} />
    </SWRConfig>
  );

describe('engine accounts', () => {
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW_MS);
    mocks.usage = {};
    mocks.listAgentAccountStatus.mockResolvedValue([{ id: 'claude-work', signed_in: true }]);
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
    mocks.createAgentAccount.mockReset();
    mocks.deleteAgentAccount.mockReset();
    mocks.copyText.mockReset();
    mocks.signInAgentAccount.mockReset();
    mocks.listAgentAccountStatus.mockReset();
    Object.values(mocks.message).forEach((fn) => fn.mockReset());
  });

  it('offers accounts only on the builtin claude row, not on an account or another engine', () => {
    expect(canAddEngineAccount(claude)).toBe(true);
    expect(canAddEngineAccount(account)).toBe(false);
    expect(canAddEngineAccount({ ...claude, id: 'codex', backend: 'codex' })).toBe(false);
    expect(canAddEngineAccount({ ...claude, agent_source: 'custom' })).toBe(false);
  });

  it('adds an account with the typed label and refreshes the engine list', async () => {
    mocks.createAgentAccount.mockResolvedValue({ ...account });
    const onChanged = vi.fn();
    render(<AddEngineAccountButton agent={claude} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.agentManagement.accounts.add' }));
    fireEvent.change(await screen.findByPlaceholderText('settings.agentManagement.accounts.labelPlaceholder'), {
      target: { value: '  Work  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.agentManagement.accounts.create' }));

    await waitFor(() => expect(mocks.createAgentAccount).toHaveBeenCalledWith({ id: 'claude-main', label: 'Work' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it('does not add an account without a label', async () => {
    render(<AddEngineAccountButton agent={claude} onChanged={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.agentManagement.accounts.add' }));

    expect(await screen.findByRole('button', { name: 'settings.agentManagement.accounts.create' })).toBeDisabled();
    expect(mocks.createAgentAccount).not.toHaveBeenCalled();
  });

  it('opens a terminal on the account to sign it in, without showing the command', async () => {
    mocks.signInAgentAccount.mockResolvedValue(undefined);
    renderActions(account);

    fireEvent.click(screen.getByRole('button', { name: 'settings.agentManagement.accounts.signIn' }));

    await waitFor(() => expect(mocks.signInAgentAccount).toHaveBeenCalledWith({ id: 'claude-work' }));
    await waitFor(() =>
      expect(mocks.message.info).toHaveBeenCalledWith('settings.agentManagement.accounts.signInOpened')
    );
    expect(screen.queryByText(/CLAUDE_CONFIG_DIR=/)).not.toBeInTheDocument();
  });

  it('shows the command that signs the account in to its own config dir when the terminal cannot open', async () => {
    mocks.signInAgentAccount.mockRejectedValue(new Error('opening a terminal is not supported on this system'));
    mocks.copyText.mockResolvedValue(undefined);
    renderActions(account);

    fireEvent.click(screen.getByRole('button', { name: 'settings.agentManagement.accounts.signIn' }));
    const command = await screen.findByText(/CLAUDE_CONFIG_DIR=.*\/data\/accounts\/claude-work.* claude/);
    expect(mocks.message.error).toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'settings.agentManagement.accounts.copy' }));

    await waitFor(() => expect(mocks.copyText).toHaveBeenCalledWith(command.textContent));
  });

  it('tags an account that is not signed in, and only that one', async () => {
    mocks.listAgentAccountStatus.mockResolvedValue([
      { id: 'claude-work', signed_in: false },
      { id: 'claude-home', signed_in: true },
    ]);
    renderActions(account);
    expect(await screen.findByText('settings.agentManagement.accounts.notSignedIn')).toBeInTheDocument();
    cleanup();

    renderActions({ ...account, id: 'claude-home' });
    await waitFor(() => expect(mocks.listAgentAccountStatus).toHaveBeenCalledTimes(2));
    await new Promise((resolve) => setTimeout(resolve, 0)); // let SWR render the fetched status
    expect(screen.queryByText('settings.agentManagement.accounts.notSignedIn')).not.toBeInTheDocument();
  });

  it('removes an account after confirming', async () => {
    mocks.deleteAgentAccount.mockResolvedValue({ deleted: true });
    const onChanged = vi.fn();
    render(<EngineAccountActions agent={account} onChanged={onChanged} />);

    fireEvent.click(screen.getByRole('button', { name: 'settings.agentManagement.accounts.delete' }));
    fireEvent.click(await screen.findByRole('button', { name: 'settings.agentManagement.accounts.deleteConfirm' }));

    await waitFor(() => expect(mocks.deleteAgentAccount).toHaveBeenCalledWith({ id: 'claude-work' }));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("shows each login's own 5-hour and weekly usage", () => {
    mocks.usage = { 'claude-main': reading(0.4, 0.12), 'claude-work': reading(0.9, 0.5) };
    const { rerender } = render(<EngineUsageLine agent={claude} />);
    expect(screen.getByText(/"fiveHour":40,"week":12/)).toBeInTheDocument();

    rerender(<EngineUsageLine agent={account} />);
    expect(screen.getByText(/"fiveHour":90,"week":50/)).toBeInTheDocument();
  });

  it('shows nothing for an account without its own reading, even when the main login has one', () => {
    // A reading filed by backend is the main login's.
    mocks.usage = { claude: reading(0.4, 0.12) };
    const { container, rerender } = render(<EngineUsageLine agent={account} />);
    expect(container).toBeEmptyDOMElement();

    rerender(<EngineUsageLine agent={claude} />);
    expect(screen.getByText(/"fiveHour":40,"week":12/)).toBeInTheDocument();
  });
});
