/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The conversation route enters its preview scope once per conversation/scope, and tells the
 * context when the scope changed under the same conversation (project_id arrived), so the
 * live tabs follow it.
 */

import { cleanup, render, waitFor } from '@testing-library/react';
import React from 'react';
import { SWRConfig } from 'swr';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { IConversationListChangedEvent } from '@/common/adapter/ipcBridge';
import type { TChatConversation } from '@/common/config/storage';

const enterScope = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (k: string) => k }) }));
vi.mock('react-router-dom', () => ({ useParams: () => ({ id: 'c1' }), useNavigate: () => vi.fn() }));
vi.mock('@/renderer/pages/conversation/components/ChatConversation', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Preview', () => ({
  // A fresh function per render, like the real context whose callback changes with its state.
  usePreviewContext: () => ({ closePreviewIfScopeChanged: (...args: unknown[]) => enterScope(...args) }),
}));
vi.mock('@/renderer/hooks/chat/useAutoTitle', () => ({ useAutoTitle: () => ({ syncTitleFromHistory: vi.fn() }) }));

const getConversationOrNull = vi.fn<(id: string) => Promise<TChatConversation | null>>();
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: (id: string) => getConversationOrNull(id),
}));

let listChangedCb: ((e: IConversationListChangedEvent) => void) | null = null;
vi.mock('@/common', () => ({
  ipcBridge: {
    conversation: {
      listChanged: {
        on: (cb: (e: IConversationListChangedEvent) => void) => {
          listChangedCb = cb;
          return () => {
            listChangedCb = null;
          };
        },
      },
    },
  },
}));

import ChatConversationIndex from '@/renderer/pages/conversation/index';

const conv = (project_id: string | null): TChatConversation =>
  ({ id: 'c1', name: 'x', type: 'acp', extra: { workspace: '/w' }, project_id }) as unknown as TChatConversation;

beforeEach(() => {
  enterScope.mockReset();
  getConversationOrNull.mockReset();
});
afterEach(() => cleanup());

describe('conversation route preview scope entry', () => {
  it('enters the scope with the browser default and carries the live tabs once project_id arrives', async () => {
    getConversationOrNull.mockResolvedValueOnce(conv(null)).mockResolvedValue(conv('p1'));
    render(
      <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
        <ChatConversationIndex />
      </SWRConfig>
    );

    await waitFor(() => expect(enterScope).toHaveBeenCalledTimes(1));
    expect(enterScope).toHaveBeenLastCalledWith('/w', { openBrowserIfEmpty: true, carryFromScope: undefined });

    listChangedCb?.({ conversation_id: 'c1', action: 'updated' } as IConversationListChangedEvent);

    await waitFor(() => expect(enterScope).toHaveBeenCalledTimes(2));
    expect(enterScope).toHaveBeenLastCalledWith('p1', { openBrowserIfEmpty: true, carryFromScope: '/w' });
  });
});
