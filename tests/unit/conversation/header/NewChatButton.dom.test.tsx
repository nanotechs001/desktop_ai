/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The conversation header's "+ New chat": a new chat with the same assistant, made over the aioncore HTTP API, so it
 * works in the phone WebUI (where main-process IPC never answers) as well as in the desktop app.
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Message } from '@arco-design/web-react';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

const platform = vi.hoisted(() => ({ electron: false }));
vi.mock('@/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/utils/platform')>()),
  isElectronDesktop: () => platform.electron,
}));

import { adapter } from '@/common/platform/bridge';
import type { TChatConversation } from '@/common/config/storage';
import { ConversationNewChatButton } from '@/renderer/pages/conversation/components/NewChatButton';

const LABEL = 'conversation.welcome.newConversation';

const SOURCE = {
  id: 'c1',
  name: 'Find flights',
  type: 'acp',
  assistant: { id: 'bot-1', source: 'user', name: 'Travel Bot', avatar: '', backend: 'claude' },
  extra: {
    backend: 'claude',
    workspace: '/data/conversations/claude-temp-c1',
    is_temporary_workspace: true,
    acp_session_id: 'sess-1',
    acp_session_updated_at: 5,
    session_mode: 'default',
    session_mcp_servers: [{ id: 'aionui-browser' }],
    cron_job_id: 'job-1',
    pinned: true,
  },
  created_at: 1,
  modified_at: 1,
} as unknown as TChatConversation;

type Call = { method: string; path: string; body: unknown };

/** The MCP catalog's built-in records as they are now; a chat's stored copy may be older. */
const builtin = (id: string, name: string) => ({
  id,
  name,
  builtin: true,
  enabled: true,
  transport: { type: 'stdio', command: 'node', args: [`${name}-fresh.js`] },
});
const CATALOG = [
  builtin('aionui-browser', 'aionui-browser'),
  builtin('aionui-artifacts', 'aionui-artifacts'),
  builtin('aionui-notes', 'aionui-notes'),
];
/** What a new chat gets: every built-in session MCP, fresh from the catalog. */
const FRESH_SESSION_MCPS = CATALOG.map(({ id, name, transport }) => ({ id, name, transport }));

const json = (status: number, payload: unknown) =>
  new Response(JSON.stringify(payload), { status, headers: { 'Content-Type': 'application/json' } });

/** aioncore stand-in: GET returns the source chat, the clone POST answers `cloneStatus`. */
const stubBackend = (cloneStatus = 200) => {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      const path = new URL(url, 'http://host').pathname;
      const method = init?.method ?? 'GET';
      calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
      if (method === 'GET' && path === '/api/conversations/c1') return json(200, { success: true, data: SOURCE });
      if (method === 'GET' && path === '/api/settings/client') {
        return json(200, { success: true, data: { 'mcp.config': CATALOG } });
      }
      if (method === 'GET' && path === '/api/mcp/servers') return json(200, { success: true, data: [] });
      if (method === 'POST' && path === '/api/conversations/clone') {
        return cloneStatus === 200
          ? json(200, { success: true, data: { ...SOURCE, id: 'c2', name: '' } })
          : json(cloneStatus, { success: false, error: 'boom' });
      }
      return json(404, { success: false, code: 'NOT_FOUND' });
    })
  );
  return calls;
};

/** The conversation the clone POST sent. */
const sentConversation = (calls: Call[]) => {
  const clone = calls.find((call) => call.path === '/api/conversations/clone');
  if (!clone) throw new Error('no clone request');
  return (clone.body as { conversation: Record<string, unknown> }).conversation;
};

const Location = () => <div data-testid='location'>{useLocation().pathname}</div>;

const renderButton = () =>
  render(
    <MemoryRouter initialEntries={['/conversation/c1']}>
      <ConversationNewChatButton conversation={SOURCE} />
      <Location />
    </MemoryRouter>
  );

// Every main-process provider call goes out through the bridge adapter; in the WebUI nothing answers it.
const ipcEmit = vi.fn();
beforeEach(() => {
  ipcEmit.mockReset();
  adapter({ emit: ipcEmit, on: () => {} });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete (window as { __backendPort?: number }).__backendPort;
});

describe.each([
  ['WebUI', false],
  ['Electron', true],
])('ConversationNewChatButton (%s)', (_mode, electron) => {
  beforeEach(() => {
    platform.electron = electron;
    if (electron) (window as { __backendPort?: number }).__backendPort = 25808;
  });

  it('has an accessible name', () => {
    stubBackend();
    renderButton();
    expect(screen.getByRole('button', { name: LABEL })).toBeTruthy();
  });

  it('creates a chat with the same assistant over HTTP and opens it, without any IPC', async () => {
    const calls = stubBackend();
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: LABEL }));

    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/conversation/c2'));
    const sent = sentConversation(calls);
    // Same assistant: the backend resolves that bot's rule (with its notes), skills and defaults for the new chat.
    expect(sent.assistant).toMatchObject({ id: 'bot-1' });
    expect(sent.type).toBe('acp');
    expect(sent.name).toBe('');
    const extra = sent.extra as Record<string, unknown>;
    expect(extra.session_mode).toBe('default');
    // The stored session MCP list may be stale: the new chat takes the built-ins fresh from the catalog instead.
    expect(extra).not.toHaveProperty('session_mcp_servers');
    expect(extra.selected_session_mcp_servers).toEqual(FRESH_SESSION_MCPS);
    // Nothing that belongs to the old chat: its backend session, schedule, pin or temporary folder.
    for (const key of ['acp_session_id', 'acp_session_updated_at', 'cron_job_id', 'pinned', 'workspace']) {
      expect(extra).not.toHaveProperty(key);
    }
    expect(ipcEmit).not.toHaveBeenCalled();
  });

  it('shows an error and stays put when the backend refuses', async () => {
    stubBackend(500);
    const error = vi.spyOn(Message, 'error').mockImplementation(() => () => {});
    renderButton();
    fireEvent.click(screen.getByRole('button', { name: LABEL }));

    await waitFor(() => expect(error).toHaveBeenCalled());
    expect(screen.getByTestId('location').textContent).toBe('/conversation/c1');
    expect(ipcEmit).not.toHaveBeenCalled();
  });
});

describe('ConversationNewChatButton bindings', () => {
  it("copies only the assistant's identity and settings, never the old chat's schedule, team, channel or state", async () => {
    platform.electron = false;
    const calls = stubBackend();
    const KEPT = {
      workspace: '/Users/me/project',
      backend: 'codex',
      cli_path: '/usr/local/bin/codex',
      agent_name: 'Travel Bot',
      custom_agent_id: 'custom-1',
      session_mode: 'yolo',
      current_model_id: 'gpt-5',
      sandboxMode: 'workspace-write',
      codexModel: 'gpt-5-codex',
      skills: ['notes'],
    };
    const bound = {
      ...SOURCE,
      source: 'telegram',
      channel_chat_id: 'user:42',
      runtime: { status: 'running' },
      status: 'running',
      extra: {
        ...KEPT,
        session_mcp_servers: [
          { id: 'aionui-browser', name: 'aionui-browser', transport: { type: 'stdio', command: 'stale' } },
        ],
        is_temporary_workspace: false,
        cronJobId: 'job-1',
        cron_job_id: 'job-1',
        teamId: 'team-1',
        fork: { parent: 'c0' },
        acp_session_id: 'sess-1',
        last_token_usage: { total: 5 },
        preset_context: 'old rule text',
      },
    } as unknown as TChatConversation;
    vi.mocked(fetch).mockImplementationOnce(async () => json(200, { success: true, data: bound }));
    render(
      <MemoryRouter>
        <ConversationNewChatButton conversation={bound} />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: LABEL }));

    await waitFor(() => expect(calls.some((call) => call.path === '/api/conversations/clone')).toBe(true));
    const sent = sentConversation(calls);
    for (const key of ['source', 'channel_chat_id', 'runtime', 'status', 'id', 'created_at', 'modified_at']) {
      expect(sent).not.toHaveProperty(key);
    }
    expect(sent).toMatchObject({ type: 'acp', name: '', assistant: { id: 'bot-1' } });
    expect(sent.extra).toEqual({ ...KEPT, selected_session_mcp_servers: FRESH_SESSION_MCPS });
  });
});

describe('ConversationNewChatButton for an Aion CLI chat', () => {
  it('keeps its provider model, which aionrs takes at the top level', async () => {
    platform.electron = false;
    const calls = stubBackend();
    const aionrs = {
      ...SOURCE,
      type: 'aionrs',
      model: { provider_id: 'prov-1', use_model: 'gpt-5' }, // aioncore's shape: the GET maps it to the app's
    } as unknown as TChatConversation;
    vi.mocked(fetch).mockImplementationOnce(async () => json(200, { success: true, data: aionrs }));
    render(
      <MemoryRouter>
        <ConversationNewChatButton conversation={aionrs} />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: LABEL }));

    await waitFor(() => expect(calls.some((call) => call.path === '/api/conversations/clone')).toBe(true));
    expect(sentConversation(calls)).toMatchObject({ type: 'aionrs', model: { provider_id: 'prov-1' } });
  });
});

describe('ConversationNewChatButton with a chosen workspace', () => {
  it('keeps a workspace the user picked', async () => {
    platform.electron = false;
    const calls = stubBackend();
    const picked = {
      ...SOURCE,
      extra: { ...SOURCE.extra, workspace: '/Users/me/project', is_temporary_workspace: false },
    } as TChatConversation;
    vi.mocked(fetch).mockImplementationOnce(async () => json(200, { success: true, data: picked }));
    render(
      <MemoryRouter>
        <ConversationNewChatButton conversation={picked} />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByRole('button', { name: LABEL }));

    await waitFor(() => expect(calls.some((call) => call.path === '/api/conversations/clone')).toBe(true));
    expect((sentConversation(calls).extra as { workspace?: string }).workspace).toBe('/Users/me/project');
  });
});
