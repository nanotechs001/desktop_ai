/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentActionEvent, TabOwnership } from '@/common/types/browser';

const mocks = vi.hoisted(() => ({
  share: vi.fn(
    (_arg: { webContentsId: number; on: boolean }): Promise<{ success: boolean }> => Promise.resolve({ success: true })
  ),
  messageError: vi.fn(),
  getOwnership: vi.fn(),
  ownership: null as ((list: TabOwnership[]) => void) | null,
  action: null as ((event: AgentActionEvent) => void) | null,
}));

// Arco's imperative Message needs a legacy ReactDOM.render, which React 19 lacks in jsdom.
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...actual, Message: { ...actual.Message, error: mocks.messageError } };
});

vi.mock('@/common', () => ({
  ipcBridge: {
    application: { reportBrowserWebContentsId: { invoke: () => Promise.resolve({ success: true }) } },
    browser: {
      getDownloads: { invoke: () => Promise.resolve({ success: true, data: [] }) },
      downloadsChanged: { on: () => () => {} },
      shortcut: { on: () => () => {} },
      closeTabRequested: { on: () => () => {} },
    },
    agentBrowser: {
      share: { invoke: mocks.share },
      getOwnership: { invoke: mocks.getOwnership },
      ownershipChanged: {
        on: (handler: (list: TabOwnership[]) => void) => {
          mocks.ownership = handler;
          return () => {};
        },
      },
      agentAction: {
        on: (handler: (event: AgentActionEvent) => void) => {
          mocks.action = handler;
          return () => {};
        },
      },
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => ({ openBrowserTab: vi.fn() }),
}));

import BrowserViewer from '@/renderer/pages/conversation/Preview/browser/BrowserViewer';
import {
  appendAction,
  MAX_AGENT_ACTIONS,
  MAX_AGENT_LABEL_LENGTH,
} from '@/renderer/pages/conversation/Preview/browser/useAgentBrowser';

const KEY = 'preview.browserChrome.agent';
const WEB_CONTENTS_ID = 7;

const stubs = {
  executeJavaScript: () => Promise.resolve(),
  getWebContentsId: () => WEB_CONTENTS_ID,
  canGoBack: () => false,
  canGoForward: () => false,
  setZoomFactor: () => {},
};

const tab = (patch: Partial<TabOwnership> = {}): TabOwnership => ({
  webContentsId: WEB_CONTENTS_ID,
  owner: 'user',
  sharedWith: null,
  ...patch,
});

const event = (patch: Partial<AgentActionEvent> = {}): AgentActionEvent => ({
  webContentsId: WEB_CONTENTS_ID,
  clientLabel: 'Some Vendor',
  op: 'click',
  label: 'Buy now',
  rect: { x: 1, y: 2, width: 30, height: 20 },
  at: 1,
  ...patch,
});

const mount = async (initial: TabOwnership[]) => {
  mocks.getOwnership.mockResolvedValue({ success: true, data: initial });
  const onAgentOwnedChange = vi.fn();
  const onAgentAction = vi.fn();
  const view = render(
    <BrowserViewer
      url='https://example.com'
      tabId='tab-1'
      onUrlChange={vi.fn()}
      onTitleChange={vi.fn()}
      onFaviconChange={vi.fn()}
      onAgentOwnedChange={onAgentOwnedChange}
      onAgentAction={onAgentAction}
    />
  );
  await act(async () => {
    view.container.querySelector('webview')?.dispatchEvent(new Event('dom-ready'));
  });
  return { ...view, onAgentOwnedChange, onAgentAction };
};

beforeEach(() => {
  Object.assign(HTMLUnknownElement.prototype, stubs);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  mocks.ownership = null;
  mocks.action = null;
  for (const name of Object.keys(stubs)) {
    delete (HTMLUnknownElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

describe('BrowserViewer agent chrome', () => {
  it('Share with agent toggles share({on}) and shows the shared state', async () => {
    await mount([tab()]);

    fireEvent.click(await screen.findByText(`${KEY}.share`));
    expect(mocks.share).toHaveBeenCalledWith({ webContentsId: WEB_CONTENTS_ID, on: true });

    act(() => mocks.ownership?.([tab({ sharedWith: 'all' })]));
    const stop = screen.getByText(`${KEY}.stopSharing`);
    expect(stop.closest('button')?.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(stop);
    expect(mocks.share).toHaveBeenLastCalledWith({ webContentsId: WEB_CONTENTS_ID, on: false });
  });

  it('an agent-owned tab shows the Agent badge instead of the share toggle, and reports it to the tab', async () => {
    const { onAgentOwnedChange } = await mount([tab({ owner: { clientId: 'c1', label: 'Some Vendor' } })]);

    expect(await screen.findByText(`${KEY}.badge`)).toBeTruthy();
    expect(screen.queryByText(`${KEY}.share`)).toBeNull();
    expect(screen.queryByText('Some Vendor')).toBeNull();
    await waitFor(() => expect(onAgentOwnedChange).toHaveBeenCalledWith('tab-1', true, undefined));
  });

  it("reports the chat that owns the tab, again when the bot's new chat takes it over (R18)", async () => {
    const owner = { clientId: 'c1', label: 'Bot', conversationId: 'chat-1' };
    const { onAgentOwnedChange } = await mount([tab({ owner })]);
    await waitFor(() => expect(onAgentOwnedChange).toHaveBeenCalledWith('tab-1', true, 'chat-1'));

    act(() => mocks.ownership?.([tab({ owner: { ...owner, clientId: 'c2', conversationId: 'chat-2' } })]));
    await waitFor(() => expect(onAgentOwnedChange).toHaveBeenLastCalledWith('tab-1', true, 'chat-2'));
    expect(onAgentOwnedChange).toHaveBeenCalledTimes(2);
  });

  it('a user tab never reports agent-owned', async () => {
    const { onAgentOwnedChange } = await mount([tab()]);
    await screen.findByText(`${KEY}.share`);
    expect(onAgentOwnedChange).not.toHaveBeenCalled();
  });

  it('highlights an action for this tab and ignores actions for other tabs', async () => {
    const { container } = await mount([tab({ sharedWith: 'all' })]);

    act(() => mocks.action?.(event({ webContentsId: 99, label: 'Elsewhere' })));
    expect(screen.queryByText('Elsewhere')).toBeNull();
    expect(container.querySelector('[data-testid="agent-highlight"]')).toBeNull();

    act(() => mocks.action?.(event()));
    expect(screen.getByText('Buy now')).toBeTruthy();
    expect(container.querySelector('[data-testid="agent-highlight"]')).not.toBeNull();
  });

  it('tells the layer about each agent action on this tab only, so the pane can follow the agent', async () => {
    const { onAgentAction } = await mount([tab({ sharedWith: 'all' })]);
    expect(onAgentAction).not.toHaveBeenCalled();

    act(() => mocks.action?.(event({ webContentsId: 99 })));
    expect(onAgentAction).not.toHaveBeenCalled();

    act(() => mocks.action?.(event({ op: 'navigate', label: 'https://example.com/next', rect: null })));
    act(() => mocks.action?.(event({ op: 'switch', label: '', rect: null })));
    expect(onAgentAction.mock.calls).toEqual([['tab-1'], ['tab-1']]);
  });

  it("lists this tab's actions in the feed, with the neutral Agent name", async () => {
    await mount([tab({ sharedWith: 'all' })]);
    expect(screen.queryByLabelText(`${KEY}.actions`)).toBeNull();

    act(() => mocks.action?.(event({ label: 'Search box', op: 'type', rect: null })));
    fireEvent.click(screen.getByLabelText(`${KEY}.actions`));
    expect(await screen.findByText('Search box')).toBeTruthy();
    expect(screen.queryByText('Some Vendor')).toBeNull();
  });
});

describe('BrowserViewer agent failures', () => {
  const failures = [
    ['rejects', () => Promise.reject(new Error('ipc down'))],
    ['resolves success: false', () => Promise.resolve({ success: false })],
  ] as const;

  it.each(failures)('tells the user when sharing %s', async (_name, outcome) => {
    mocks.share.mockImplementationOnce(outcome);
    await mount([tab()]);

    fireEvent.click(await screen.findByText(`${KEY}.share`));

    await waitFor(() => expect(mocks.messageError).toHaveBeenCalledWith(`${KEY}.actionFailed`));
  });

  it('does not complain when sharing succeeds', async () => {
    await mount([tab()]);
    fireEvent.click(await screen.findByText(`${KEY}.share`));
    await waitFor(() => expect(mocks.share).toHaveBeenCalled());
    expect(mocks.messageError).not.toHaveBeenCalled();
  });
});

describe('appendAction', () => {
  it('keeps only the last 50 actions and does not mutate its input', () => {
    const first = Array.from({ length: MAX_AGENT_ACTIONS }, (_, i) => event({ at: i }));
    const next = appendAction(first, event({ at: 999 }));

    expect(next).toHaveLength(MAX_AGENT_ACTIONS);
    expect(next[0].at).toBe(1);
    expect(next.at(-1)?.at).toBe(999);
    expect(first).toHaveLength(MAX_AGENT_ACTIONS);
    expect(first[0].at).toBe(0);
  });

  it('cuts an over-long label to the label limit', () => {
    const [stored] = appendAction([], event({ label: 'x'.repeat(MAX_AGENT_LABEL_LENGTH + 50) }));

    expect(stored.label).toHaveLength(MAX_AGENT_LABEL_LENGTH);
  });
});
