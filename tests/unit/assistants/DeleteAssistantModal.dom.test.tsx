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
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ConfigProvider } from '@arco-design/web-react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

const ipc = vi.hoisted(() => ({ clearProfileData: vi.fn() }));
vi.mock('@/common', () => ({ ipcBridge: { browser: { clearProfileData: { invoke: ipc.clearProfileData } } } }));

import DeleteAssistantModal from '@/renderer/pages/settings/AssistantSettings/DeleteAssistantModal';
import BrowserProfileSection from '@/renderer/pages/settings/AssistantSettings/editor/BrowserProfileSection';
import type { AssistantListItem } from '@/renderer/pages/settings/AssistantSettings/types';

const renderWithProviders = (ui: React.ReactElement) => render(<ConfigProvider>{ui}</ConfigProvider>);

describe('DeleteAssistantModal', () => {
  const defaultProps = {
    visible: false,
    onConfirm: vi.fn(),
    onCancel: vi.fn(),
    activeAssistant: null as AssistantListItem | null,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    cleanup();
  });

  it('does not render when visible=false (props branch)', () => {
    const { container } = renderWithProviders(<DeleteAssistantModal {...defaultProps} />);
    expect(container.querySelector('[data-testid="modal-delete-assistant"]')).not.toBeInTheDocument();
  });

  it('renders modal when visible=true (smoke)', () => {
    const assistant: AssistantListItem = { id: 'a1', name: 'Test', sort_order: 1, source: 'user', enabled: true };
    renderWithProviders(<DeleteAssistantModal {...defaultProps} visible={true} activeAssistant={assistant} />);
    expect(screen.getByTestId('modal-delete-assistant')).toBeInTheDocument();
  });

  it('displays assistant name in confirmation (props branch)', () => {
    const assistant: AssistantListItem = {
      id: 'a1',
      name: 'UserAssistant',
      sort_order: 1,
      source: 'user',
      enabled: true,
    };
    renderWithProviders(<DeleteAssistantModal {...defaultProps} visible={true} activeAssistant={assistant} />);
    expect(screen.getByText('UserAssistant')).toBeInTheDocument();
  });

  it('calls onConfirm when OK button is clicked (callback spy)', async () => {
    const onConfirmSpy = vi.fn();
    const assistant: AssistantListItem = { id: 'a1', name: 'Test', sort_order: 1, source: 'user', enabled: true };
    const user = userEvent.setup();
    renderWithProviders(
      <DeleteAssistantModal {...defaultProps} visible={true} activeAssistant={assistant} onConfirm={onConfirmSpy} />
    );

    const okButton = screen.getByRole('button', { name: /delete/i });
    await user.click(okButton);

    expect(onConfirmSpy).toHaveBeenCalledTimes(1);
  });

  it('asks whether to delete the browser data too: on by default, and the answer goes to onConfirm', async () => {
    const onConfirmSpy = vi.fn();
    const assistant: AssistantListItem = { id: 'a1', name: 'Test', sort_order: 1, source: 'user', enabled: true };
    const user = userEvent.setup();
    renderWithProviders(
      <DeleteAssistantModal {...defaultProps} visible={true} activeAssistant={assistant} onConfirm={onConfirmSpy} />
    );

    const choice = screen.getByRole('checkbox', { name: 'agent.browserProfile.deleteWithAgent' });
    expect(choice).toBeChecked();
    await user.click(screen.getByRole('button', { name: /delete/i }));
    expect(onConfirmSpy).toHaveBeenLastCalledWith(true);

    await user.click(choice);
    await user.click(screen.getByRole('button', { name: /delete/i }));
    expect(onConfirmSpy).toHaveBeenLastCalledWith(false);
  });

  it('says the browser data stays on disk when the user keeps it', async () => {
    const assistant: AssistantListItem = { id: 'a1', name: 'Test', sort_order: 1, source: 'user', enabled: true };
    const user = userEvent.setup();
    renderWithProviders(<DeleteAssistantModal {...defaultProps} visible={true} activeAssistant={assistant} />);

    expect(screen.queryByText('agent.browserProfile.keptOnDisk')).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'agent.browserProfile.deleteWithAgent' }));
    expect(screen.getByText('agent.browserProfile.keptOnDisk')).toBeInTheDocument();
  });

  it('calls onCancel when Cancel button is clicked (callback spy)', async () => {
    const onCancelSpy = vi.fn();
    const assistant: AssistantListItem = { id: 'a1', name: 'Test', sort_order: 1, source: 'user', enabled: true };
    const user = userEvent.setup();
    renderWithProviders(
      <DeleteAssistantModal {...defaultProps} visible={true} activeAssistant={assistant} onCancel={onCancelSpy} />
    );

    const cancelButton = screen.getByRole('button', { name: /cancel/i });
    await user.click(cancelButton);

    expect(onCancelSpy).toHaveBeenCalledTimes(1);
  });

  it('renders without activeAssistant (props branch)', () => {
    renderWithProviders(<DeleteAssistantModal {...defaultProps} visible={true} activeAssistant={null} />);
    expect(screen.getByTestId('modal-delete-assistant')).toBeInTheDocument();
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
