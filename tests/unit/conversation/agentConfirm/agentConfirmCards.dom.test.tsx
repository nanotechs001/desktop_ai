/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The chat's copy of the browser's risky-action ask, in the desktop app (main window and robot popup): the chat
 * shows its own asks, answers them over the same IPC as the browser pane, and drops a card answered anywhere.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConfirmRequest } from '@/common/types/browser';

const mocks = vi.hoisted(() => ({
  getConfirmRequests: vi.fn(),
  replyConfirm: vi.fn(() => Promise.resolve({ success: true })),
  handler: null as ((open: ConfirmRequest[]) => void) | null,
  unsubscribe: vi.fn(),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    agentBrowser: {
      getConfirmRequests: { invoke: mocks.getConfirmRequests },
      replyConfirm: { invoke: mocks.replyConfirm },
      confirmRequested: {
        on: (handler: (open: ConfirmRequest[]) => void) => {
          mocks.handler = handler;
          return mocks.unsubscribe;
        },
      },
    },
  },
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { origin?: string }) => (opts?.origin ? `${key} @ ${opts.origin}` : key),
  }),
}));

import AgentConfirmCards from '@/renderer/pages/conversation/components/AgentConfirmCards/AgentConfirmCards';

const KEY = 'preview.browserChrome.confirm';

const request = (id: string, conversationId?: string, patch: Partial<ConfirmRequest> = {}): ConfirmRequest => ({
  id,
  origin: `https://${id}.test`,
  frameOrigin: `https://${id}.test`,
  label: `Publish ${id}`,
  clientLabel: 'aion-browser-claude',
  ...(conversationId ? { conversationId } : {}),
  ...patch,
});

const mount = async (initial: ConfirmRequest[] = []) => {
  mocks.getConfirmRequests.mockResolvedValue({ success: true, data: initial });
  render(<AgentConfirmCards conversationId='conv-1' />);
  await act(async () => {});
};

const push = (open: ConfirmRequest[]) => act(() => mocks.handler?.(open));
const armAllow = () => act(async () => new Promise((resolve) => setTimeout(resolve, 520)));

beforeEach(() => {
  mocks.replyConfirm.mockClear();
});

afterEach(cleanup);

describe('AgentConfirmCards in the desktop app', () => {
  it("shows only this chat's asks, with the title, origin, label and the 2-minute hint", async () => {
    await mount([request('a', 'conv-1'), request('b', 'conv-2'), request('c')]);
    expect(screen.getByText('Publish a')).toBeTruthy();
    expect(screen.queryByText('Publish b')).toBeNull();
    expect(screen.queryByText('Publish c')).toBeNull();
    expect(screen.getByText(`${KEY}.title`)).toBeTruthy();
    expect(screen.getByText(`${KEY}.message @ https://a.test`)).toBeTruthy();
    expect(screen.getByText(`${KEY}.timeoutHint`)).toBeTruthy();
    // A card in the chat never takes the focus from the send box.
    expect(document.activeElement).toBe(document.body);
  });

  it('renders nothing without an ask for this chat', async () => {
    const { container } = render(<AgentConfirmCards conversationId='conv-9' />);
    await push([request('a', 'conv-1')]);
    expect(container.textContent).toBe('');
  });

  it('Allow and Deny answer over IPC, Allow with the always box', async () => {
    await mount([request('a', 'conv-1'), request('b', 'conv-1')]);
    await armAllow();
    const [firstAlways] = screen.getAllByText(`${KEY}.always`);
    fireEvent.click(firstAlways);
    fireEvent.click(screen.getAllByText(`${KEY}.allow`)[0]);
    expect(mocks.replyConfirm).toHaveBeenLastCalledWith({ id: 'a', allow: true, alwaysForSite: true });

    fireEvent.click(screen.getAllByText(`${KEY}.deny`)[1]);
    expect(mocks.replyConfirm).toHaveBeenLastCalledWith({ id: 'b', allow: false, alwaysForSite: false });
  });

  it('keeps Allow off for a moment after the card appears', async () => {
    await mount([request('a', 'conv-1')]);
    fireEvent.click(screen.getByText(`${KEY}.allow`));
    expect(mocks.replyConfirm).not.toHaveBeenCalled();
  });

  it('goes away when the ask is answered anywhere else (the pane, the phone, the timeout)', async () => {
    await mount([request('a', 'conv-1')]);
    await push([]);
    expect(screen.queryByText('Publish a')).toBeNull();
  });

  it("shows the page's label as text, never as markup", async () => {
    await mount([request('a', 'conv-1', { label: '<img src=x onerror=alert(1)>' })]);
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
    expect(document.querySelector('img')).toBeNull();
  });

  it('unsubscribes on unmount', async () => {
    await mount();
    cleanup();
    expect(mocks.unsubscribe).toHaveBeenCalled();
  });
});
