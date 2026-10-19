import React from 'react';
/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Unit tests for DeleteAssistantModal component (A8 in N4a).
 * Tests deletion confirmation modal, builtin guard, and cancel behavior.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor, act } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from '@arco-design/web-react';

// `t` echoes the key and its values (`key|count=2`), so the tests can see which line shows and what it was told.
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, options?: Record<string, unknown>) => {
      const values = Object.entries(options ?? {})
        .filter(([name]) => name !== 'defaultValue')
        .map(([name, value]) => `${name}=${String(value)}`);
      return values.length > 0 ? `${k}|${values.join(',')}` : k;
    },
    i18n: { language: 'en' },
  }),
}));

const preview = vi.hoisted(() => ({ fn: vi.fn() }));
vi.mock('@/renderer/hooks/assistant/deleteVaBot', () => ({ previewVaBotDelete: preview.fn }));

const ipc = vi.hoisted(() => ({ clearProfileData: vi.fn() }));
vi.mock('@/common', () => ({ ipcBridge: { browser: { clearProfileData: { invoke: ipc.clearProfileData } } } }));

import DeleteAssistantModal from '@/renderer/pages/settings/AssistantSettings/DeleteAssistantModal';
import BrowserProfileSection from '@/renderer/pages/settings/AssistantSettings/editor/BrowserProfileSection';
import type { AssistantListItem } from '@/renderer/pages/settings/AssistantSettings/types';

const renderWithProviders = (ui: React.ReactElement) => render(<ConfigProvider>{ui}</ConfigProvider>);

describe('DeleteAssistantModal', () => {
  const assistant: AssistantListItem = { id: 'a1', name: 'Test', sort_order: 1, source: 'user', enabled: true };
  const defaultProps = {
    visible: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    activeAssistant: null as AssistantListItem | null,
    deleting: false,
    progress: null as { done: number; total: number } | null,
  };
  const full = { chats: 12, tasks: 3, hasRobot: true, channels: ['Telegram', 'Slack'] };
  const none = { chats: 0, tasks: 0, hasRobot: false, channels: [] as string[] };
  const open = (props: Partial<typeof defaultProps> = {}) =>
    renderWithProviders(<DeleteAssistantModal {...defaultProps} visible activeAssistant={assistant} {...props} />);
  const deleteButton = () => screen.getByRole('button', { name: /common\.delete/ });

  beforeEach(() => {
    vi.clearAllMocks();
    preview.fn.mockResolvedValue(full);
  });

  afterEach(() => {
    cleanup();
  });

  it('does not render when visible=false, and does not count anything', () => {
    const { container } = renderWithProviders(<DeleteAssistantModal {...defaultProps} />);
    expect(container.querySelector('[data-testid="modal-delete-assistant"]')).not.toBeInTheDocument();
    expect(preview.fn).not.toHaveBeenCalled();
  });

  it('names the Agent in the title and keeps its avatar card', async () => {
    open();
    expect(await screen.findByText('agent.deleteBot.title|name=Test')).toBeInTheDocument();
    expect(screen.getByText('Test')).toBeInTheDocument();
  });

  it('counts what it owns when it opens, and cannot be confirmed until the counts are in', async () => {
    let finish: (value: typeof full) => void = () => {};
    preview.fn.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    open();

    expect(preview.fn).toHaveBeenCalledWith('a1');
    expect(screen.getByText('agent.deleteBot.counting')).toBeInTheDocument();
    expect(deleteButton()).toBeDisabled();

    await act(async () => finish(full));
    expect(screen.queryByText('agent.deleteBot.counting')).toBeNull();
    expect(deleteButton()).toBeEnabled();
  });

  it('lists everything that goes with the Agent, with the real counts and one line per bound channel', async () => {
    open();

    expect(await screen.findByText('agent.deleteBot.intro')).toBeInTheDocument();
    expect(screen.getByText('agent.deleteBot.chats|count=12')).toBeInTheDocument();
    expect(screen.getByText('agent.deleteBot.browserProfile')).toBeInTheDocument();
    expect(screen.getByText('agent.deleteBot.notebook')).toBeInTheDocument();
    expect(screen.getByText('agent.deleteBot.tasks|count=3')).toBeInTheDocument();
    expect(screen.getByText('agent.deleteBot.robot')).toBeInTheDocument();
    expect(screen.getByText('agent.deleteBot.channel|platform=Telegram')).toBeInTheDocument();
    expect(screen.getByText('agent.deleteBot.channel|platform=Slack')).toBeInTheDocument();
    expect(screen.getByText('agent.deleteBot.skillsStay')).toBeInTheDocument();
    expect(screen.getByText('agent.deleteBot.irreversible').tagName).toBe('STRONG');
  });

  it('hides the lines for what it does not own, but always shows the profile and the notebook', async () => {
    preview.fn.mockResolvedValue(none);
    open();

    expect(await screen.findByText('agent.deleteBot.browserProfile')).toBeInTheDocument();
    expect(screen.getByText('agent.deleteBot.notebook')).toBeInTheDocument();
    expect(screen.queryByText(/agent\.deleteBot\.chats/)).toBeNull();
    expect(screen.queryByText(/agent\.deleteBot\.tasks/)).toBeNull();
    expect(screen.queryByText('agent.deleteBot.robot')).toBeNull();
    expect(screen.queryByText(/agent\.deleteBot\.channel/)).toBeNull();
  });

  it('no longer asks whether to keep the browser data', async () => {
    open();
    await screen.findByText('agent.deleteBot.intro');
    expect(screen.queryByRole('checkbox')).toBeNull();
  });

  it('refuses to confirm, and says why, when it cannot count what the Agent owns', async () => {
    preview.fn.mockRejectedValue(new Error('down'));
    open();

    expect(await screen.findByText('agent.deleteBot.countFailed')).toBeInTheDocument();
    expect(deleteButton()).toBeDisabled();
    expect(screen.queryByText('agent.deleteBot.intro')).toBeNull();
  });

  it('counts afresh each time it opens', async () => {
    const { rerender } = open();
    await screen.findByText('agent.deleteBot.chats|count=12');
    preview.fn.mockResolvedValue({ ...full, chats: 2 });

    rerender(
      <ConfigProvider>
        <DeleteAssistantModal {...defaultProps} visible={false} activeAssistant={assistant} />
      </ConfigProvider>
    );
    rerender(
      <ConfigProvider>
        <DeleteAssistantModal {...defaultProps} visible activeAssistant={assistant} />
      </ConfigProvider>
    );

    expect(await screen.findByText('agent.deleteBot.chats|count=2')).toBeInTheDocument();
    expect(preview.fn).toHaveBeenCalledTimes(2);
  });

  it('makes Delete a danger button and calls onConfirm when it is clicked', async () => {
    const onConfirm = vi.fn();
    const user = userEvent.setup();
    open({ onConfirm });
    await screen.findByText('agent.deleteBot.intro');

    expect(deleteButton().className).toContain('arco-btn-status-danger');
    await user.click(deleteButton());
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('shows the chat progress while deleting and disables both buttons', async () => {
    open({ deleting: true, progress: { done: 4, total: 12 } });

    expect(await screen.findByText('agent.deleteBot.progress|done=4,total=12')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /common\.cancel/ })).toBeDisabled();
    expect(deleteButton()).toBeDisabled();
  });

  it('shows a plain working line while deleting something other than chats', async () => {
    open({ deleting: true, progress: null });
    expect(await screen.findByText('agent.deleteBot.working')).toBeInTheDocument();
  });

  it('calls onCancel when Cancel is clicked', async () => {
    const onCancel = vi.fn();
    const user = userEvent.setup();
    open({ onCancel });
    await user.click(screen.getByRole('button', { name: /common\.cancel/ }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('renders without an active Agent and counts nothing', () => {
    renderWithProviders(<DeleteAssistantModal {...defaultProps} visible activeAssistant={null} />);
    expect(screen.getByTestId('modal-delete-assistant')).toBeInTheDocument();
    expect(preview.fn).not.toHaveBeenCalled();
  });
});

describe('the Agent editor Browser profile section', () => {
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('"Clear browsing data" asks first, then clears only this Agent\'s profile', async () => {
    ipc.clearProfileData.mockResolvedValue({ success: true });
    const user = userEvent.setup();
    renderWithProviders(<BrowserProfileSection agentId='bare:sales' />);

    await user.click(screen.getByRole('button', { name: 'agent.browserProfile.clear' }));
    expect(ipc.clearProfileData).not.toHaveBeenCalled();
    // The popup is still animating in (pointer-events: none in jsdom), so click it directly.
    fireEvent.click(await screen.findByRole('button', { name: 'agent.browserProfile.clearConfirmOk' }));

    await waitFor(() => expect(ipc.clearProfileData).toHaveBeenCalledWith({ agentId: 'bare:sales' }));
    expect(ipc.clearProfileData).toHaveBeenCalledTimes(1);
  });
});
