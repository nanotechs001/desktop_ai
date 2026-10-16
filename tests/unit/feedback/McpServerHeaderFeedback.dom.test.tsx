/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Verifies McpServerHeader renders no FeedbackButton, even when the server status is
 * 'error' (the feedback flow is removed from this fork).
 */

import React from 'react';
import { describe, it, expect, vi, afterEach } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ConfigProvider } from '@arco-design/web-react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

import McpServerHeader from '@/renderer/pages/settings/ToolsSettings/McpServerHeader';
import type { IMcpServer } from '@/common/config/storage';

const buildServer = (last_test_status: IMcpServer['last_test_status']): IMcpServer =>
  ({
    id: 's1',
    name: 'my-server',
    enabled: true,
    transport: { type: 'http', url: 'http://example' },
    last_test_status,
    created_at: 0,
    updated_at: 0,
    original_json: '',
  }) as IMcpServer;

const commonProps = {
  isTestingConnection: false,
  onTestConnection: vi.fn(),
  onEditServer: vi.fn(),
  onDeleteServer: vi.fn(),
};

const renderHeader = (last_test_status: IMcpServer['last_test_status']) =>
  render(
    <ConfigProvider>
      <McpServerHeader server={buildServer(last_test_status)} {...commonProps} />
    </ConfigProvider>
  );

describe('McpServerHeader — no FeedbackButton', () => {
  afterEach(() => {
    cleanup();
  });

  it.each(['connected', 'testing', 'error'] as const)('renders no feedback link on %s status', (status) => {
    renderHeader(status);
    expect(screen.getByText('my-server')).toBeInTheDocument();
    expect(screen.queryByText('settings.oneClickFeedback')).not.toBeInTheDocument();
  });
});
