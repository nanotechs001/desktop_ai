/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  restartConversation: vi.fn(),
  revalidateConfig: vi.fn(),
  messageSuccess: vi.fn(),
  messageError: vi.fn(),
  markRestartStarted: vi.fn(),
  markRestartSucceeded: vi.fn(),
  markRestartFailed: vi.fn(),
  getConversation: vi.fn(),
}));

const idleRuntime = {
  state: 'idle' as const,
  can_send_message: true,
  has_task: true,
  task_status: 'finished' as const,
  is_processing: false,
  pending_confirmations: 0,
  turn_id: null,
};

vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: { restartRuntime: { invoke: mocks.restartConversation } },
  },
}));

vi.mock('@/common/adapter/httpBridge', () => ({
  isBackendHttpError: (error: unknown) =>
    typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string',
}));

vi.mock('@/common/utils', () => ({
  parseError: (error: unknown) => (error instanceof Error ? error.message : ''),
}));

vi.mock('@/renderer/hooks/agent/useAcpConfigOptions', () => ({
  revalidateAcpConfigOptions: mocks.revalidateConfig,
}));

vi.mock('@/renderer/pages/conversation/runtime/useConversationRuntimeView', () => ({
  useConversationRuntimeView: () => ({
    markRestartStarted: mocks.markRestartStarted,
    markRestartSucceeded: mocks.markRestartSucceeded,
    markRestartFailed: mocks.markRestartFailed,
  }),
}));

vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: mocks.getConversation,
}));

vi.mock('@/renderer/styles/colors', () => ({
  iconColors: { secondary: 'secondary' },
}));

vi.mock('@icon-park/react', () => ({
  Refresh: () => <span aria-hidden='true'>refresh</span>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@arco-design/web-react', () => ({
  Button: ({
    disabled,
    icon,
    loading: _loading,
    size: _size,
    type: _type,
    ...props
  }: {
    disabled?: boolean;
    icon?: React.ReactNode;
    loading?: boolean;
    size?: string;
    type?: string;
    [key: string]: unknown;
  }) => (
    <button type='button' disabled={disabled} {...props}>
      {icon}
    </button>
  ),
  Popconfirm: ({ children, onOk }: { children?: React.ReactNode; onOk?: () => void }) => (
    <div>
      {children}
      <button type='button' onClick={onOk}>
        confirm restart
      </button>
    </div>
  ),
  Tooltip: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
  Message: {
    success: mocks.messageSuccess,
    error: mocks.messageError,
  },
}));

import AcpRuntimeRestartButton from '@/renderer/components/agent/AcpRuntimeRestartButton';

describe('AcpRuntimeRestartButton', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.restartConversation.mockResolvedValue({ runtime: idleRuntime });
    mocks.revalidateConfig.mockResolvedValue(undefined);
    mocks.getConversation.mockResolvedValue({ runtime: idleRuntime });
  });

  afterEach(() => {
    cleanup();
  });

  it('restarts a standalone runtime and refreshes its config options', async () => {
    const user = userEvent.setup();
    render(<AcpRuntimeRestartButton conversation_id='conversation-1' />);

    await user.click(screen.getByRole('button', { name: 'confirm restart' }));

    await waitFor(() => {
      expect(mocks.restartConversation).toHaveBeenCalledWith({ conversation_id: 'conversation-1' });
    });
    expect(mocks.markRestartStarted).toHaveBeenCalledTimes(1);
    expect(mocks.markRestartSucceeded).toHaveBeenCalledWith(idleRuntime);
    expect(mocks.revalidateConfig).toHaveBeenCalledWith('conversation-1');
    expect(mocks.messageSuccess).toHaveBeenCalledWith('agent.runtimeRestart.success');
  });

  it('recovers the standalone runtime gate from the backend summary when restart fails', async () => {
    mocks.restartConversation.mockRejectedValueOnce(new Error('restart rejected'));
    const user = userEvent.setup();
    render(<AcpRuntimeRestartButton conversation_id='conversation-failed' />);

    await user.click(screen.getByRole('button', { name: 'confirm restart' }));

    await waitFor(() => {
      expect(mocks.markRestartFailed).toHaveBeenCalledWith(idleRuntime, 'restart rejected');
    });
    expect(mocks.getConversation).toHaveBeenCalledWith('conversation-failed');
    expect(mocks.markRestartSucceeded).not.toHaveBeenCalled();
    expect(mocks.revalidateConfig).not.toHaveBeenCalled();
    expect(mocks.messageError).toHaveBeenCalledWith('agent.runtimeRestart.failed');
  });

  it('does not expose restart confirmation while disabled', () => {
    render(
      <AcpRuntimeRestartButton conversation_id='conversation-4' disabled disabledReason='runtime is processing' />
    );

    expect(screen.getByRole('button', { name: 'agent.runtimeRestart.tooltip' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'confirm restart' })).not.toBeInTheDocument();
  });

  it('disables restart while the runtime is initializing', () => {
    render(<AcpRuntimeRestartButton conversation_id='conversation-5' availability='initializing' />);

    expect(screen.getByRole('button', { name: 'agent.runtimeRestart.tooltip' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'confirm restart' })).not.toBeInTheDocument();
  });

  it('hides restart when no reconnectable runtime exists', () => {
    render(<AcpRuntimeRestartButton conversation_id='conversation-6' availability='unavailable' />);

    expect(screen.queryByRole('button', { name: 'agent.runtimeRestart.tooltip' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'confirm restart' })).not.toBeInTheDocument();
  });
});
