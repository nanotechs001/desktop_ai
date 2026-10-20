/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The chat's risky-action card on the phone (WebUI): no IPC there, so it polls web-host every 3 s while the chat is
 * mounted and visible, and answers with a POST.
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ipc = vi.hoisted(() => ({ on: vi.fn(), invoke: vi.fn() }));
vi.mock('@/common', () => ({
  ipcBridge: {
    agentBrowser: {
      getConfirmRequests: { invoke: ipc.invoke },
      replyConfirm: { invoke: ipc.invoke },
      confirmRequested: { on: ipc.on },
    },
  },
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => false }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import AgentConfirmCards from '@/renderer/pages/conversation/components/AgentConfirmCards/AgentConfirmCards';

const KEY = 'preview.browserChrome.confirm';
const ID = '0b8f3c1e-6a3d-4c2b-9f4e-1d2c3b4a5f60';
const ASK = { id: ID, origin: 'https://shop.test', frameOrigin: 'https://shop.test', label: 'Pay now' };

let listed: unknown[] = [];
const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
  if (init?.method === 'POST') {
    listed = [];
    return new Response(null, { status: 204 });
  }
  return new Response(JSON.stringify({ confirms: listed }), { status: 200 });
});
const gets = () => fetchMock.mock.calls.filter(([, init]) => init?.method !== 'POST');

const tick = (ms: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });

beforeEach(() => {
  listed = [ASK, { id: 'bad', origin: 1 }];
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('AgentConfirmCards in the WebUI', () => {
  it("lists this chat's asks at once and again every 3 s, never over IPC", async () => {
    render(<AgentConfirmCards conversationId='conv-1' />);
    await tick(0);
    expect(gets()[0][0]).toBe('/api/browser-view/confirms?conversation=conv-1');
    expect(screen.getByText('Pay now')).toBeTruthy();
    // A malformed entry is dropped, not drawn.
    expect(screen.getAllByText(`${KEY}.deny`)).toHaveLength(1);

    listed = [];
    await tick(3000);
    expect(gets()).toHaveLength(2);
    expect(screen.queryByText('Pay now')).toBeNull();
    expect(ipc.on).not.toHaveBeenCalled();
    expect(ipc.invoke).not.toHaveBeenCalled();
  });

  it('answers with a POST of {allow, always} and drops the card', async () => {
    render(<AgentConfirmCards conversationId='conv-1' />);
    await tick(0);
    await tick(600); // past the Allow delay
    fireEvent.click(screen.getByText(`${KEY}.always`));
    fireEvent.click(screen.getByText(`${KEY}.allow`));
    await tick(0);

    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(post?.[0]).toBe(`/api/browser-view/confirms/${ID}`);
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ allow: true, always: true });
    expect(post?.[1]?.credentials).toBe('include');
    expect(screen.queryByText('Pay now')).toBeNull();
  });

  it('draws a "Leave site?" ask from web-host as one, and Leave posts allow true', async () => {
    listed = [{ ...ASK, kind: 'leave', frameOrigin: null, label: '' }];
    render(<AgentConfirmCards conversationId='conv-1' />);
    await tick(0);
    expect(screen.getByText('preview.browserChrome.leave.title')).toBeTruthy();
    await tick(600);
    fireEvent.click(screen.getByText('preview.browserChrome.leave.leave'));
    await tick(0);
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ allow: true, always: false });
  });

  it('passes a script ask through from web-host: its kind, the code and its length', async () => {
    listed = [{ ...ASK, kind: 'script', label: '</> document.title', codeLength: 14 }];
    render(<AgentConfirmCards conversationId='conv-1' />);
    await tick(0);
    expect(screen.getByText(`${KEY}.scriptMessage`)).toBeTruthy();
    expect(document.querySelector('pre')?.textContent).toBe('document.title');
    expect(screen.getByText(`${KEY}.scriptLength`)).toBeTruthy();
  });

  it('Deny posts allow false without always', async () => {
    render(<AgentConfirmCards conversationId='conv-1' />);
    await tick(0);
    fireEvent.click(screen.getByText(`${KEY}.always`));
    fireEvent.click(screen.getByText(`${KEY}.deny`));
    await tick(0);
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST');
    expect(JSON.parse(String(post?.[1]?.body))).toEqual({ allow: false, always: false });
  });

  it('stops polling once unmounted', async () => {
    render(<AgentConfirmCards conversationId='conv-1' />);
    await tick(0);
    cleanup();
    const before = gets().length;
    await tick(9000);
    expect(gets()).toHaveLength(before);
  });

  it('skips polls while the page is hidden', async () => {
    render(<AgentConfirmCards conversationId='conv-1' />);
    await tick(0);
    const hidden = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('hidden');
    await tick(6000);
    expect(gets()).toHaveLength(1);
    hidden.mockRestore();
  });
});
