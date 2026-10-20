/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Browser tabs (and the agent's work in them) must outlive the panel: closing it, leaving for
 * /settings or another project's chat only hides a tab's webview, and an agent's tab opens in
 * the agent's own chat, whichever chat is on screen.
 */

import React, { useState } from 'react';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type OpenTabRequest = {
  url: string;
  background: boolean;
  conversationId?: string;
  profile?: { kind: 'personal' } | { kind: 'agent'; agentId: string };
};

const h = vi.hoisted(() => ({
  openTab: null as ((request: OpenTabRequest) => void) | null,
  profileRemoved: null as ((event: { agentId: string }) => void) | null,
  refuseTab: vi.fn(async () => ({ success: true })),
  mounts: new Map<string, number>(),
  /** While set, chat lookups wait for it (to interleave a logout). */
  lookupGate: null as Promise<void> | null,
  unmounted: [] as string[],
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    fileStream: { contentUpdate: { on: () => () => {} } },
    preview: { open: { on: () => () => {} } },
    browser: {
      openTabRequested: {
        on: (handler: (request: OpenTabRequest) => void) => {
          h.openTab = handler;
          return () => {};
        },
      },
      profileRemoved: {
        on: (handler: (event: { agentId: string }) => void) => {
          h.profileRemoved = handler;
          return () => {};
        },
      },
    },
    agentBrowser: { refuseTab: { invoke: h.refuseTab } },
    conversation: { responseStream: { on: () => () => {} } },
  },
}));

const PROJECT_OF: Record<string, string> = { 'chat-a': 'proj-a', 'chat-b': 'proj-b' };
vi.mock('@/renderer/pages/conversation/utils/conversationCache', () => ({
  getConversationOrNull: async (id: string) => {
    if (h.lookupGate) await h.lookupGate;
    return PROJECT_OF[id] ? { id, project_id: PROJECT_OF[id], extra: { workspace: `/ws/${id}` } } : null;
  },
}));
vi.mock('@/renderer/pages/conversation/Preview/browser/firstUseNotice', () => ({
  maybeNotifyFirstAgentBrowserUse: vi.fn(),
}));
vi.mock('@/renderer/pages/conversation/Preview/browser/BrowserChrome/PermissionPrompt', () => ({
  default: () => null,
}));
vi.mock('@/renderer/pages/conversation/Preview/browser/BrowserChrome/ConfirmPrompt', () => ({ default: () => null }));
// Stands in for the webview: counts mounts and unmounts per tab, which is what "the page survives" means.
vi.mock('@/renderer/pages/conversation/Preview/browser/BrowserViewer', async () => {
  const { useEffect } = await import('react');
  const Viewer = ({ tabId, agentOwnedHint }: { tabId: string; agentOwnedHint?: boolean }) => {
    useEffect(() => {
      h.mounts.set(tabId, (h.mounts.get(tabId) ?? 0) + 1);
      return () => {
        h.unmounted.push(tabId);
      };
    }, [tabId]);
    return <div data-testid={`viewer-${tabId}`} data-agent-owned={String(Boolean(agentOwnedHint))} />;
  };
  return { default: Viewer };
});

import BrowserTabLayer, { BrowserSlot } from '@/renderer/pages/conversation/Preview/browser/BrowserTabLayer';
import { MAX_BROWSER_TABS } from '@/renderer/pages/conversation/Preview/browser/constants';
import {
  PreviewProvider,
  usePreviewContext,
  type PreviewContextValue,
} from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { previewScopeStorageKey } from '@/renderer/pages/conversation/Preview/context/previewScope';

let ctx: PreviewContextValue;
let showRoute: (show: boolean) => void;

/** The conversation route's panel, reduced to the slot it gives the browser while a browser tab is on screen. */
const Panel: React.FC = () => {
  ctx = usePreviewContext();
  return ctx.isOpen && ctx.activeTab?.content_type === 'browser' ? <BrowserSlot /> : null;
};

/** The app layout: the browser layer is always there; the conversation route (and its panel) comes and goes. */
const App: React.FC = () => {
  const [route, setRoute] = useState(true);
  showRoute = setRoute;
  return (
    <PreviewProvider>
      {route ? <Panel /> : <ContextProbe />}
      <BrowserTabLayer />
    </PreviewProvider>
  );
};

const ContextProbe: React.FC = () => {
  ctx = usePreviewContext();
  return null;
};

const enterScope = (scope: string) => act(() => ctx.closePreviewIfScopeChanged(scope));
const requestTab = async (url: string, conversationId?: string, profile?: OpenTabRequest['profile']) => {
  await act(async () => {
    h.openTab?.({ url, background: false, conversationId, profile });
  });
};
const tabIdOf = (url: string): string | undefined => ctx.liveBrowserTabs.find((tab) => tab.content === url)?.id;
const shown = (tabId: string): boolean =>
  screen.getByTestId(`viewer-${tabId}`).parentElement?.style.visibility === 'visible';
const storedTabUrls = (scope: string): string[] =>
  (
    JSON.parse(localStorage.getItem(previewScopeStorageKey(scope)) ?? '{"tabs":[]}') as { tabs: { content: string }[] }
  ).tabs.map((tab) => tab.content);

beforeEach(() => {
  localStorage.clear();
  // jsdom lays nothing out; give the panel's slot a real box so the active tab can be shown in it.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const slot = this.hasAttribute('data-browser-slot');
    return { x: 0, y: 0, left: 100, top: 50, width: slot ? 800 : 0, height: slot ? 600 : 0 } as DOMRect;
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  h.refuseTab.mockClear();
  h.lookupGate = null;
  h.mounts.clear();
  h.unmounted.length = 0;
});

describe('agent browser tabs outlive the panel', () => {
  it('closing the panel or navigating to /settings keeps agent webviews mounted (hidden)', async () => {
    render(<App />);
    enterScope('proj-a');
    await requestTab('https://a.test/', 'chat-a');
    const id = tabIdOf('https://a.test/') as string;
    await waitFor(() => expect(shown(id)).toBe(true));

    act(() => ctx.collapsePreview());
    await waitFor(() => expect(shown(id)).toBe(false));

    act(() => ctx.openBrowserTab('https://other.test/'));
    act(() => ctx.closePreview()); // what leaving for /settings does
    act(() => showRoute(false));

    expect(screen.getByTestId(`viewer-${id}`)).toBeInTheDocument();
    expect(shown(id)).toBe(false);
    expect(h.unmounted).toEqual([]);
  });

  it("switching to another project chat keeps the first chat's agent tab alive", async () => {
    render(<App />);
    enterScope('proj-a');
    await requestTab('https://a.test/', 'chat-a');
    const id = tabIdOf('https://a.test/') as string;

    enterScope('proj-b');
    expect(ctx.tabs.map((tab) => tab.id)).not.toContain(id);
    expect(shown(id)).toBe(false);

    enterScope('proj-a');
    expect(ctx.activeTabId).toBe(id);
    await waitFor(() => expect(shown(id)).toBe(true));
    expect(h.mounts.get(id)).toBe(1);
    expect(h.unmounted).toEqual([]);
  });

  it('an agent tab requested by chat A while chat B is on screen lands in A and is not shown in B', async () => {
    render(<App />);
    enterScope('proj-b');
    act(() => ctx.openBrowserTab('https://b.test/'));

    await requestTab('https://a.test/', 'chat-a');

    await waitFor(() => expect(tabIdOf('https://a.test/')).toBeDefined());
    const id = tabIdOf('https://a.test/') as string;
    expect(ctx.tabs.map((tab) => tab.content)).toEqual(['https://b.test/']);
    expect(screen.getByTestId(`viewer-${id}`)).toBeInTheDocument(); // mounted, so the agent can work in it
    expect(shown(id)).toBe(false);
    expect(storedTabUrls('proj-a')).toEqual(['https://a.test/']);

    enterScope('proj-a');
    expect(ctx.isOpen).toBe(true);
    expect(ctx.activeTabId).toBe(id);
    await waitFor(() => expect(shown(id)).toBe(true));
    expect(h.mounts.get(id)).toBe(1);
  });

  it("outside Electron, an agent tab for another chat does not reopen that chat's panel", async () => {
    const w = window as Window & { electronAPI?: unknown };
    const electronApiStub = w.electronAPI;
    delete w.electronAPI;
    try {
      render(<App />);
      enterScope('proj-b');

      await requestTab('https://a.test/', 'chat-a');
      await waitFor(() => expect(storedTabUrls('proj-a')).toEqual(['https://a.test/']));

      enterScope('proj-a');
      expect(ctx.tabs.map((tab) => tab.content)).toEqual(['https://a.test/']);
      expect(ctx.isOpen).toBe(false);
    } finally {
      w.electronAPI = electronApiStub;
    }
  });

  it('marks an agent tab as agent-owned from creation, on screen or in the background, before any ownership event', async () => {
    render(<App />);
    enterScope('proj-a');

    await requestTab('https://own.test/', 'chat-a'); // chat A is on screen
    await requestTab('https://bg.test/', 'chat-b'); // chat B is not
    await requestTab('https://page.test/'); // a page's target=_blank: the user's

    await waitFor(() => expect(tabIdOf('https://bg.test/')).toBeDefined());
    const agentOwned = (url: string) =>
      screen.getByTestId(`viewer-${tabIdOf(url) as string}`).getAttribute('data-agent-owned');
    expect([agentOwned('https://own.test/'), agentOwned('https://bg.test/'), agentOwned('https://page.test/')]).toEqual(
      ['true', 'true', 'false']
    );
  });

  it("drops a deleted Agent's tabs everywhere: on screen, in the background and in stored scopes", async () => {
    const gone = { kind: 'agent', agentId: 'bare:gone' } as const;
    const kept = { kind: 'agent', agentId: 'bare:kept' } as const;
    render(<App />);
    enterScope('proj-c');
    act(() => ctx.openBrowserTab('https://stored-gone.test/', gone));
    act(() => ctx.openBrowserTab('https://stored-kept.test/'));
    enterScope('proj-a');
    await requestTab('https://own-gone.test/', 'chat-a', gone);
    await requestTab('https://own-kept.test/', 'chat-a', kept);
    await requestTab('https://bg-gone.test/', 'chat-b', gone);
    await waitFor(() => expect(tabIdOf('https://bg-gone.test/')).toBeDefined());
    act(() => ctx.switchTab(tabIdOf('https://own-gone.test/') as string));

    await act(async () => h.profileRemoved?.({ agentId: 'bare:gone' }));

    expect(ctx.liveBrowserTabs.map((tab) => tab.content).toSorted()).toEqual([
      'https://own-kept.test/',
      'https://stored-kept.test/',
    ]);
    expect(ctx.activeTab?.content).toBe('https://own-kept.test/');
    expect(storedTabUrls('proj-b')).toEqual([]);
    expect(storedTabUrls('proj-c')).toEqual(['https://stored-kept.test/']);
  });

  it("closes the panel when every tab on screen was the deleted Agent's", async () => {
    const gone = { kind: 'agent', agentId: 'bare:gone' } as const;
    render(<App />);
    enterScope('proj-a');
    await requestTab('https://only-gone.test/', 'chat-a', gone);
    expect(ctx.isOpen).toBe(true);

    await act(async () => h.profileRemoved?.({ agentId: 'bare:gone' }));

    expect(ctx.tabs).toEqual([]);
    expect(ctx.activeTabId).toBeNull();
    expect(ctx.isOpen).toBe(false);
  });

  it('opens a tab without a chat id (older MCP, other engines) in the chat on screen', async () => {
    render(<App />);
    enterScope('proj-b');
    await requestTab('https://legacy.test/');
    expect(ctx.tabs.map((tab) => tab.content)).toEqual(['https://legacy.test/']);
  });

  it('tab cap returns the specific error immediately', async () => {
    render(<App />);
    enterScope('proj-a');
    for (let i = 0; i < MAX_BROWSER_TABS; i += 1) act(() => ctx.openBrowserTab(`https://a.test/${i}`));

    await requestTab('https://full.test/', 'chat-a');
    expect(h.refuseTab).toHaveBeenCalledWith({
      url: 'https://full.test/',
      max: MAX_BROWSER_TABS,
      conversationId: 'chat-a',
    });

    // The same cap holds for chat A while another chat is on screen.
    enterScope('proj-b');
    await requestTab('https://full-too.test/', 'chat-a');
    expect(h.refuseTab).toHaveBeenCalledWith({
      url: 'https://full-too.test/',
      max: MAX_BROWSER_TABS,
      conversationId: 'chat-a',
    });
    expect(storedTabUrls('proj-a')).not.toContain('https://full-too.test/');
  });

  it('keeps at most 20 live webviews, unmounting the least recently used user tab and never an agent tab', async () => {
    render(<App />);
    enterScope('proj-a');
    await requestTab('https://agent.test/', 'chat-a');
    for (let i = 1; i < MAX_BROWSER_TABS; i += 1) act(() => ctx.openBrowserTab(`https://a.test/${i}`));
    const agentTab = tabIdOf('https://agent.test/') as string;
    const oldestUserTab = tabIdOf('https://a.test/1') as string;
    enterScope('proj-b');
    for (let i = 0; i < MAX_BROWSER_TABS; i += 1) act(() => ctx.openBrowserTab(`https://b.test/${i}`));
    enterScope('proj-c');
    expect(h.unmounted).toEqual([]); // 20 live: at the cap, not over it

    act(() => ctx.openBrowserTab('https://c.test/'));

    expect(h.unmounted).toEqual([oldestUserTab]);
    expect(screen.getByTestId(`viewer-${agentTab}`)).toBeInTheDocument();
  });

  it('drops an agent tab request when the user logged out during the chat lookup', async () => {
    render(<App />);
    enterScope('proj-b');
    let release: (() => void) | undefined;
    h.lookupGate = new Promise((resolve) => {
      release = resolve;
    });
    await requestTab('https://a.test/', 'chat-a');

    act(() => ctx.clearPreviewForScope()); // what logout does
    await act(async () => release?.());

    expect(ctx.liveBrowserTabs).toEqual([]);
    expect(storedTabUrls('proj-a')).toEqual([]);
  });

  it("updates and closes another chat's tab in the background, and in its stored scope", async () => {
    render(<App />);
    enterScope('proj-b');
    await requestTab('https://a.test/', 'chat-a');
    await waitFor(() => expect(tabIdOf('https://a.test/')).toBeDefined());
    const id = tabIdOf('https://a.test/') as string;

    act(() => ctx.updateTab(id, { title: 'Inbox', content: 'https://a.test/inbox' }));
    expect(ctx.liveBrowserTabs.find((tab) => tab.id === id)).toMatchObject({
      title: 'Inbox',
      content: 'https://a.test/inbox',
    });
    expect(ctx.tabs).toEqual([]);

    act(() => ctx.closeTab(id));
    expect(ctx.liveBrowserTabs).toEqual([]);
    expect(h.unmounted).toEqual([id]);
    expect(storedTabUrls('proj-a')).toEqual([]);
  });
});
