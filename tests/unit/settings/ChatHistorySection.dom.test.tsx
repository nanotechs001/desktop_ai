/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Settings > System > Chat history: clears every chat with the main agent at once (Pixebots keep theirs).
 */

// The app loads this in main.tsx; Modal.confirm cannot render under React 19 without it.
import '@arco-design/web-react/lib/_util/react-19-adapter';
import { Message, Modal } from '@arco-design/web-react';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TChatConversation } from '@/common/config/storage';

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const arco = await importOriginal<typeof import('@arco-design/web-react')>();
  return {
    ...arco,
    Message: { ...arco.Message, success: vi.fn(), error: vi.fn(), warning: vi.fn(), loading: vi.fn() },
  };
});
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) => (params ? `${key} ${JSON.stringify(params)}` : key),
  }),
}));
const ipc = vi.hoisted(() => ({ remove: vi.fn() }));
vi.mock('@/common', () => ({ ipcBridge: { conversation: { remove: { invoke: ipc.remove } } } }));
vi.mock('@/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/utils/platform')>()),
  isElectronDesktop: () => false,
}));
const chats = vi.hoisted(() => ({ value: [] as TChatConversation[] }));
vi.mock('@/renderer/hooks/context/ConversationHistoryContext', () => ({
  useConversationHistoryContext: () => ({ conversations: chats.value }),
}));
// A Pixebot's chat is not one of the main agent's.
vi.mock('@/renderer/hooks/assistant/useRegularChatsOnly', () => ({
  useRegularChatsOnly: () => (conversation: TChatConversation) => !conversation.id.startsWith('bot'),
}));

import ChatHistorySection from '@/renderer/components/settings/SettingsModal/contents/SystemModalContent/ChatHistorySection';

const chat = (id: string) => ({ id, name: id, modified_at: 1, created_at: 1 }) as TChatConversation;

const renderSection = () =>
  render(
    <MemoryRouter>
      <ChatHistorySection />
    </MemoryRouter>
  );

const clearButton = () => screen.getByRole('button', { name: 'conversation.history.clearHistory' });
const confirm = async () =>
  fireEvent.click(
    (await screen.findAllByRole('button', { name: 'conversation.history.confirmDelete' })).at(-1) as HTMLElement
  );

describe('ChatHistorySection', () => {
  beforeEach(() => {
    ipc.remove.mockReset();
    vi.mocked(Message.success).mockClear();
    vi.mocked(Message.warning).mockClear();
  });
  afterEach(() => {
    Modal.destroyAll();
  });

  it("deletes every main-agent chat after a confirm that says how many, and keeps the Pixebots' chats", async () => {
    chats.value = [chat('a'), chat('b'), chat('bot-1')];
    ipc.remove.mockResolvedValue(true);
    renderSection();

    fireEvent.click(clearButton());
    expect(await screen.findByText('conversation.history.clearHistoryConfirm {"count":2}')).toBeInTheDocument();
    await confirm();

    await waitFor(() => expect(ipc.remove).toHaveBeenCalledTimes(2));
    expect(ipc.remove.mock.calls.map(([{ id }]) => id).sort()).toEqual(['a', 'b']);
    await waitFor(() =>
      expect(Message.success).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'conversation.history.batchDeleteSuccess {"count":2}' })
      )
    );
  });

  it('says how many could not be deleted', async () => {
    chats.value = [chat('a'), chat('b'), chat('c')];
    ipc.remove.mockImplementation(async (params: { id: string }) => params.id !== 'b');
    renderSection();

    fireEvent.click(clearButton());
    await confirm();

    await waitFor(() =>
      expect(Message.warning).toHaveBeenCalledWith(
        expect.objectContaining({ content: 'conversation.history.clearHistoryPartial {"removed":2,"failed":1}' })
      )
    );
  });

  it('has nothing to clear when the main agent has no chats', () => {
    chats.value = [chat('bot-1')];
    renderSection();

    expect(clearButton()).toBeDisabled();
  });
});
