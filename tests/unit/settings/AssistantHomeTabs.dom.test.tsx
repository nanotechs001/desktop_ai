/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ConfigProvider } from '@arco-design/web-react';
import AssistantHomeTabs from '@/renderer/pages/settings/AssistantSettings/home/AssistantHomeTabs';
import type { AssistantListItem } from '@/renderer/pages/settings/AssistantSettings/types';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { defaultValue?: string }) => options?.defaultValue || key,
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@/renderer/utils/model/agentLogo', async () => {
  const actual = await vi.importActual<typeof import('@/renderer/utils/model/agentLogo')>(
    '@/renderer/utils/model/agentLogo'
  );
  return { ...actual, useAgentLogos: () => ({}) };
});

const assistants = [
  { id: 'engine', name: 'Claude Code', sort_order: 1, source: 'generated', enabled: true },
  { id: 'writer', name: 'My Writer', sort_order: 2, source: 'user', enabled: true },
  { id: 'preset', name: 'Cowork', sort_order: 3, source: 'builtin', enabled: true },
] as AssistantListItem[];

const renderTabs = () =>
  render(
    <ConfigProvider>
      <AssistantHomeTabs
        assistants={assistants}
        assistantOrder={[]}
        localeKey='en-US'
        onOpenDetail={vi.fn()}
        onOpenSettings={vi.fn()}
        onDuplicate={vi.fn()}
        onDelete={vi.fn()}
        onCreate={vi.fn()}
        onToggleEnabled={vi.fn()}
        onReorderEnabled={vi.fn()}
        onStartChat={vi.fn()}
      />
    </ConfigProvider>
  );

describe('AssistantHomeTabs', () => {
  it("lists Agents only: an engine's generated entry belongs to Settings -> Engine (N-22)", () => {
    renderTabs();
    // The page opens on My VA Bots; the agents list is under Enabled.
    fireEvent.click(screen.getByText('Enabled'));

    expect(screen.getByTestId('enabled-assistant-row-writer')).toBeInTheDocument();
    expect(screen.getByTestId('enabled-assistant-row-preset')).toBeInTheDocument();
    expect(screen.queryByTestId('enabled-assistant-row-engine')).not.toBeInTheDocument();
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();

    fireEvent.click(screen.getByText('My VA Bots'));
    expect(screen.queryByTestId('group-cli')).not.toBeInTheDocument();
    expect(screen.queryByText('Claude Code')).not.toBeInTheDocument();
  });
});
