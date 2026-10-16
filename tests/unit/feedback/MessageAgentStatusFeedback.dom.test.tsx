/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * MessageAgentStatus renders no FeedbackButton / ButlerDiagnoseButton, even on 'error'
 * status (both are removed from this fork).
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (k: string, opts?: Record<string, unknown>) => {
      if (opts?.agent) return `${k}:${String(opts.agent)}`;
      return k;
    },
    i18n: { language: 'en' },
  }),
}));

import MessageAgentStatus from '@/renderer/pages/conversation/Messages/components/MessageAgentStatus';
import type { IMessageAgentStatus } from '@/common/chat/chatLib';

const buildMessage = (status: IMessageAgentStatus['content']['status']): IMessageAgentStatus =>
  ({
    id: 'm1',
    type: 'agent_status',
    content: {
      backend: 'claude',
      status,
      agent_name: 'Claude',
    },
  }) as IMessageAgentStatus;

describe('MessageAgentStatus — no feedback or butler chips', () => {
  afterEach(() => {
    cleanup();
  });

  it.each(['connected', 'error'] as const)('renders no feedback link or butler chip on %s status', (status) => {
    render(<MessageAgentStatus message={buildMessage(status)} />);
    expect(screen.getByText(`acp.status.${status}`)).toBeInTheDocument();
    expect(screen.queryByText('settings.oneClickFeedback')).not.toBeInTheDocument();
    expect(screen.queryByText('settings.talkToButler.solveWithButler')).not.toBeInTheDocument();
  });

  it('names no engine: the status line says "Agent" whatever the backend is', () => {
    render(
      <MessageAgentStatus
        message={
          {
            id: 'm2',
            type: 'agent_status',
            content: {
              backend: 'codex',
              status: 'connected',
            },
          } as IMessageAgentStatus
        }
      />
    );

    expect(screen.getByText('agent.displayName')).toBeInTheDocument();
    expect(screen.getByText('acp.status.connected')).toBeInTheDocument();
    expect(screen.queryByText(/Codex/)).not.toBeInTheDocument();
  });
});
