/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

// A cold conversation switch used to unmount the whole chat layout (header, panes, the browser slot) behind a bare
// spinner for a frame or more. The route now keeps the last chat on screen, dimmed and inert, until the next loads.

import React from 'react';
import { act, cleanup, render, screen } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TChatConversation } from '@/common/config/storage';

let currentId = 'c1';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-router-dom', () => ({ useParams: () => ({ id: currentId }), useNavigate: () => vi.fn() }));
vi.mock('@/renderer/pages/conversation/components/ChatConversation', () => ({
  default: ({ conversation }: { conversation?: { id: string } }) => (
    <div data-testid='chat' data-conversation={conversation?.id} />
  ),
}));
vi.mock('@/renderer/pages/conversation/Preview', () => ({
  usePreviewContext: () => ({ closePreviewIfScopeChanged: vi.fn() }),
}));
vi.mock('@/renderer/hooks/chat/useAutoTitle', () => ({ useAutoTitle: () => ({ syncTitleFromHistory: vi.fn() }) }));

const pending = new Map<string, (conversation: TChatConversation | null) => void>();
const getConversationOrNull = vi.fn(
  (id: string) => new Promise<TChatConversation | null>((resolve) => pending.set(id, resolve))
);
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: (id: string) => getConversationOrNull(id),
}));
vi.mock('@/common', () => ({ ipcBridge: { conversation: { listChanged: { on: () => () => {} } } } }));

import ChatConversationIndex from '@/renderer/pages/conversation/index';

const conversation = (id: string) => ({ id, name: id, type: 'acp', extra: {} }) as unknown as TChatConversation;

const provider = new Map();
const ui = () => (
  <SWRConfig value={{ provider: () => provider, dedupingInterval: 0 }}>
    <ChatConversationIndex />
  </SWRConfig>
);

const resolve = async (id: string) => {
  await act(async () => {
    pending.get(id)?.(conversation(id));
    await Promise.resolve();
  });
};

beforeEach(() => {
  currentId = 'c1';
  provider.clear();
  pending.clear();
});

afterEach(() => {
  cleanup();
});

describe('conversation route switch', () => {
  it('shows a spinner, not a chat, on the very first open', () => {
    render(ui());
    expect(screen.queryByTestId('chat')).toBeNull();
  });

  it('keeps the last chat mounted, dimmed and busy, until the next one loads', async () => {
    const { rerender } = render(ui());
    await resolve('c1');
    const chat = screen.getByTestId('chat');
    expect(chat).toHaveAttribute('data-conversation', 'c1');

    currentId = 'c2';
    rerender(ui());
    expect(screen.getByTestId('chat')).toBe(chat);
    expect(chat).toHaveAttribute('data-conversation', 'c1');
    expect(chat.parentElement).toHaveAttribute('aria-busy', 'true');
    expect(chat.parentElement?.style.pointerEvents).toBe('none');

    await resolve('c2');
    expect(screen.getByTestId('chat')).toHaveAttribute('data-conversation', 'c2');
    expect(screen.getByTestId('chat').parentElement).not.toHaveAttribute('aria-busy');
  });
});
