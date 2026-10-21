/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * A chat opened for the hidden Butler Agent is redirected to /guid instead of rendered.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  conversation: null as null | { id: string; name: string; extra: Record<string, unknown> },
  navigate: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-router-dom', () => ({
  useNavigate: () => state.navigate,
  useParams: () => ({ id: 'c1' }),
}));
vi.mock('@/common', () => ({
  ipcBridge: { conversation: { listChanged: { on: () => () => {} } } },
}));
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: async () => state.conversation,
}));
vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({ closePreviewIfScopeChanged: vi.fn() }),
}));
vi.mock('@/renderer/pages/conversation/Preview/context/previewScope', () => ({
  previewScopeOfConversation: () => null,
}));
vi.mock('@/renderer/pages/conversation/explorer/currentProjectStore', () => ({ setCurrentProject: vi.fn() }));
vi.mock('@/renderer/pages/conversation/explorer/currentConversationStore', () => ({ setCurrentConversation: vi.fn() }));
vi.mock('@/renderer/hooks/chat/useAutoTitle', () => ({ useAutoTitle: () => ({ syncTitleFromHistory: vi.fn() }) }));
vi.mock('@/renderer/pages/conversation/GroupedHistory/hooks/useConversationListSync', () => ({
  getSnapshotConversationProjectId: () => null,
  useConversationListLoaded: () => true,
}));
vi.mock('@/renderer/pages/conversation/components/ChatConversation', () => ({
  default: () => <div data-testid='chat' />,
}));

import ChatConversationIndex from '@/renderer/pages/conversation';

// A fresh SWR cache per render: the page keys its fetch by conversation id.
const renderPage = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <ChatConversationIndex />
    </SWRConfig>
  );

describe('chat opened for a hidden Agent', () => {
  beforeEach(() => {
    state.navigate.mockClear();
  });
  afterEach(cleanup);

  it.each(['assistant_id', 'preset_assistant_id'])('redirects to /guid when extra.%s is the Butler', async (field) => {
    state.conversation = { id: 'c1', name: 'x', extra: { [field]: 'builtin-aionui-assistant' } };
    renderPage();

    await waitFor(() => expect(state.navigate).toHaveBeenCalledWith('/guid', { replace: true }));
    expect(screen.queryByTestId('chat')).not.toBeInTheDocument();
  });

  it('renders any other chat', async () => {
    state.conversation = { id: 'c1', name: 'x', extra: { assistant_id: 'aion-default-agent' } };
    renderPage();

    expect(await screen.findByTestId('chat')).toBeInTheDocument();
    expect(state.navigate).not.toHaveBeenCalledWith('/guid', { replace: true });
  });
});
