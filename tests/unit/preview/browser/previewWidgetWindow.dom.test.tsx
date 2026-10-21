/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Every renderer window (the main window and each floating robot) mounts a PreviewProvider, and main's
 * `openTabRequested` reaches all of them. Only the main window may own browser tab state: a robot window that
 * recorded the agent's tab wrote a copy of it to the shared `preview-ui:<scope>` storage, so the main window
 * restored one extra tab per robot for every open.
 */

import React from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type OpenTabRequest = { url: string; background: boolean; conversationId?: string };

const h = vi.hoisted(() => ({
  openTab: [] as ((request: OpenTabRequest) => void)[],
  profileRemoved: [] as ((event: { agentId: string }) => void)[],
  refuseTab: vi.fn(async () => ({ success: true })),
  subscribe:
    <T,>(list: ((event: T) => void)[]) =>
    (handler: (event: T) => void) => {
      list.push(handler);
      return () => {
        list.splice(list.indexOf(handler), 1);
      };
    },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    fileStream: { contentUpdate: { on: () => () => {} } },
    preview: { open: { on: () => () => {} } },
    browser: {
      openTabRequested: { on: h.subscribe(h.openTab) },
      profileRemoved: { on: h.subscribe(h.profileRemoved) },
    },
    agentBrowser: { refuseTab: { invoke: h.refuseTab } },
    conversation: { responseStream: { on: () => () => {} } },
  },
}));

const PROJECT_OF: Record<string, string> = { 'chat-a': 'proj-a', 'chat-b': 'proj-b' };
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: async (id: string) =>
    PROJECT_OF[id] ? { id, project_id: PROJECT_OF[id], extra: { workspace: `/ws/${id}` } } : null,
}));
vi.mock('@/renderer/pages/conversation/Preview/browser/firstUseNotice', () => ({
  maybeNotifyFirstAgentBrowserUse: vi.fn(),
}));
vi.mock('@/renderer/pages/conversation/Preview/browser/BrowserChrome/PermissionPrompt', () => ({
  default: () => null,
}));
vi.mock('@/renderer/pages/conversation/Preview/browser/BrowserChrome/ConfirmPrompt', () => ({ default: () => null }));
vi.mock('@/renderer/pages/conversation/Preview/browser/BrowserViewer', () => ({
  default: ({ tabId }: { tabId: string }) => <div data-testid={`viewer-${tabId}`} />,
}));

import BrowserTabLayer, { BrowserSlot } from '@/renderer/pages/conversation/Preview/browser/BrowserTabLayer';
import {
  PreviewProvider,
  usePreviewContext,
  type PreviewContextValue,
} from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { previewScopeStorageKey } from '@/renderer/pages/conversation/Preview/context/previewScope';

const URL_A = 'https://a.test/';
let main: PreviewContextValue;

const MainPanel: React.FC = () => {
  main = usePreviewContext();
  return main.isOpen && main.activeTab?.content_type === 'browser' ? <BrowserSlot /> : null;
};

/** The main window and two robot windows, as separate providers sharing one origin's storage. */
const Windows: React.FC = () => (
  <>
    <PreviewProvider>
      <MainPanel />
      <BrowserTabLayer />
    </PreviewProvider>
    <PreviewProvider readOnly />
    <PreviewProvider readOnly />
  </>
);

const enterScope = (scope: string) => act(() => main.closePreviewIfScopeChanged(scope));
const requestTab = async (url: string, conversationId: string) => {
  await act(async () => {
    for (const handler of h.openTab) handler({ url, background: false, conversationId });
  });
};
const storedUrls = (scope: string): string[] =>
  (
    JSON.parse(localStorage.getItem(previewScopeStorageKey(scope)) ?? '{"tabs":[]}') as { tabs: { content: string }[] }
  ).tabs.map((tab) => tab.content);
const tabsOf = (url: string) => main.tabs.filter((tab) => tab.content === url);

beforeEach(() => {
  localStorage.clear();
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const slot = this.hasAttribute('data-browser-slot');
    return { x: 0, y: 0, left: 100, top: 50, width: slot ? 800 : 0, height: slot ? 600 : 0 } as DOMRect;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  h.refuseTab.mockClear();
});

describe('only the main window owns browser tab state', () => {
  it('a robot window neither subscribes to browser tab events nor writes preview state', async () => {
    render(
      <>
        <PreviewProvider readOnly />
        <PreviewProvider readOnly />
      </>
    );
    expect(h.openTab).toHaveLength(0);
    expect(h.profileRemoved).toHaveLength(0);
    expect(localStorage.length).toBe(0);
  });

  it('one agent open for the chat on screen gives one tab, and it is the active one', async () => {
    render(<Windows />);
    enterScope('proj-a');
    act(() => main.openBrowserTab('https://user.test/'));

    await requestTab(URL_A, 'chat-a');

    await waitFor(() => expect(tabsOf(URL_A)).toHaveLength(1));
    expect(main.activeTabId).toBe(tabsOf(URL_A)[0].id);
    await waitFor(() => expect(storedUrls('proj-a')).toEqual(['https://user.test/', URL_A]));
    expect(h.refuseTab).not.toHaveBeenCalled();
  });

  it('one agent open for a chat off screen gives one tab there, active when the chat comes on screen', async () => {
    render(<Windows />);
    enterScope('proj-b');

    await requestTab(URL_A, 'chat-a');
    await waitFor(() => expect(storedUrls('proj-a')).toEqual([URL_A]));
    const live = main.liveBrowserTabs.find((tab) => tab.content === URL_A)?.id;

    enterScope('proj-a');
    expect(tabsOf(URL_A)).toHaveLength(1);
    expect(main.activeTabId).toBe(live);
    expect(screen.getByTestId(`viewer-${live}`)).toBeInTheDocument();
    expect(screen.getAllByTestId(/^viewer-/)).toHaveLength(1);
  });

  it('on load, drops the copies robot windows stored for one open and keeps the user tabs', async () => {
    const at = Date.now() - 60_000;
    const tab = (id: string, url: string) => ({
      id,
      content: url,
      originalContent: url,
      content_type: 'browser',
      title: url,
      isDirty: false,
    });
    const user = tab(`browser-${at - 9000}-user`, 'https://user.test/');
    const copies = [0, 4, 7].map((offset) => tab(`browser-${at + offset}-c${offset}`, URL_A));
    localStorage.setItem(
      previewScopeStorageKey('proj-a'),
      JSON.stringify({ isOpen: true, tabs: [user, ...copies], activeTabId: copies[2].id })
    );
    render(<Windows />);

    enterScope('proj-a');

    expect(main.tabs.map((t) => t.id)).toEqual([user.id, copies[2].id]);
    expect(main.activeTabId).toBe(copies[2].id);
    await waitFor(() => expect(storedUrls('proj-a')).toEqual(['https://user.test/', URL_A]));
  });
});
