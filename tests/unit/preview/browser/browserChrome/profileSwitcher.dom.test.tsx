/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Assistant } from '@/common/types/agent/assistantTypes';
import type { BrowserTabProfile } from '@/common/types/browser';

const AGENT_PARTITION = 'persist:aionui-agent-0123456789abcdef0123456789abcdef';

const mocks = vi.hoisted(() => ({
  assistants: vi.fn(),
  profilePartition: vi.fn(),
  refuseTab: vi.fn(() => Promise.resolve({ success: true })),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    assistants: { list: { invoke: mocks.assistants } },
    application: { reportBrowserWebContentsId: { invoke: () => Promise.resolve({ success: true }) } },
    browser: {
      profilePartition: { invoke: mocks.profilePartition },
      getDownloads: { invoke: () => Promise.resolve({ success: true, data: [] }) },
      downloadsChanged: { on: () => () => {} },
      shortcut: { on: () => () => {} },
      closeTabRequested: { on: () => () => {} },
    },
    agentBrowser: {
      refuseTab: { invoke: mocks.refuseTab },
      getOwnership: { invoke: () => Promise.resolve({ success: true, data: [] }) },
      ownershipChanged: { on: () => () => {} },
      agentAction: { on: () => () => {} },
    },
  },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => ({ openBrowserTab: vi.fn() }),
}));

import ProfileSwitcher from '@/renderer/pages/conversation/Preview/browser/BrowserProfiles/ProfileSwitcher';
import PreviewTabs from '@/renderer/pages/conversation/Preview/components/PreviewPanel/PreviewTabs';
import BrowserViewer from '@/renderer/pages/conversation/Preview/browser/BrowserViewer';
import { profilePresentation } from '@/renderer/pages/conversation/Preview/browser/BrowserProfiles/ProfileBadge';

const AGENTS = [
  { id: 'bare:sales', name: 'Sales', avatar: '🦊', source: 'user', enabled: true },
  { id: 'aion-default-agent', name: 'Agent', avatar: '🤖', source: 'user', enabled: true },
  { id: 'builtin-writer', name: 'Writer', avatar: '✍️', source: 'builtin', enabled: true },
];

/** Each render gets its own SWR cache, so one test's Agent list never leaks into the next. */
const renderFresh = (ui: React.ReactElement) =>
  render(<SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>{ui}</SWRConfig>);

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('the new-tab profile switcher', () => {
  it('the new-tab menu opens a tab in a chosen Agent profile and the tab shows its avatar', async () => {
    mocks.assistants.mockResolvedValue(AGENTS);
    const onOpen = vi.fn<(profile: BrowserTabProfile) => void>();
    renderFresh(<ProfileSwitcher onOpen={onOpen} />);

    fireEvent.click(screen.getByRole('button', { name: 'preview.browserChrome.profile.newTabIn' }));
    const sales = await screen.findByText('Sales');
    // Built-in Agents have no profile of their own; Personal is always offered.
    expect(screen.queryByText('Writer')).toBeNull();
    expect(screen.getByText('preview.browserChrome.profile.personal')).toBeTruthy();
    fireEvent.click(sales);
    expect(onOpen).toHaveBeenCalledWith({ kind: 'agent', agentId: 'bare:sales' });

    fireEvent.click(screen.getByRole('button', { name: 'preview.browserChrome.profile.newTabIn' }));
    fireEvent.click(await screen.findByText('preview.browserChrome.profile.personal'));
    expect(onOpen).toHaveBeenLastCalledWith({ kind: 'personal' });

    cleanup();
    renderFresh(
      <PreviewTabs
        tabs={[
          { id: 't1', title: 'Sales tab', profile: { kind: 'agent', agentId: 'bare:sales' } },
          { id: 't2', title: 'My tab', profile: { kind: 'personal' } },
          { id: 't3', title: 'Notes' },
        ]}
        activeTabId='t1'
        tabFadeState={{ left: false, right: false }}
        tabsContainerRef={React.createRef<HTMLDivElement>()}
        onSwitchTab={vi.fn()}
        onCloseTab={vi.fn()}
        onContextMenu={vi.fn()}
      />
    );
    const badges = screen.getAllByTestId('browser-profile-badge');
    // A file tab (no profile) shows none; the Agent tab its avatar; the Personal tab the Personal icon.
    expect(badges).toHaveLength(2);
    await waitFor(() => expect(badges[0].textContent).toBe('🦊'));
    expect(badges[0].getAttribute('aria-label')).toBe('Sales');
    expect(badges[1].getAttribute('aria-label')).toBe('preview.browserChrome.profile.personal');
  });
});

describe("the new-tab profile switcher and engines' own entries", () => {
  it("never offers an engine's own generated entry as a profile", async () => {
    mocks.assistants.mockResolvedValue([
      ...AGENTS,
      { id: 'bare:2d23ff1c', name: 'Claude Code', avatar: '/logos/claude.svg', source: 'generated', enabled: true },
    ]);
    renderFresh(<ProfileSwitcher onOpen={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: 'preview.browserChrome.profile.newTabIn' }));
    await screen.findByText('Sales');
    // Personal, Sales and the default Agent: no fourth row for the engine entry.
    expect(screen.getAllByRole('menuitem')).toHaveLength(3);
  });
});

describe('a browser tab in an Agent profile', () => {
  const renderViewer = (profile?: BrowserTabProfile, agentOwnedHint = false) =>
    renderFresh(
      <BrowserViewer
        url='https://example.com/'
        tabId='tab-1'
        profile={profile}
        agentOwnedHint={agentOwnedHint}
        onUrlChange={vi.fn()}
        onTitleChange={vi.fn()}
        onFaviconChange={vi.fn()}
        active
      />
    );

  it("mounts its webview only on the partition main set up for that Agent, and the nav bar shows the Agent's avatar", async () => {
    mocks.assistants.mockResolvedValue(AGENTS);
    let answer: (reply: { success: boolean; data?: string }) => void = () => {};
    mocks.profilePartition.mockReturnValue(new Promise((resolve) => (answer = resolve)));
    const { container } = renderViewer({ kind: 'agent', agentId: 'bare:sales' });

    expect(mocks.profilePartition).toHaveBeenCalledWith({ kind: 'agent', agentId: 'bare:sales' });
    // The partition can't change once the webview attaches, so nothing mounts before main answers.
    expect(container.querySelector('webview')).toBeNull();
    answer({ success: true, data: AGENT_PARTITION });

    await waitFor(() => expect(container.querySelector('webview')?.getAttribute('partition')).toBe(AGENT_PARTITION));
    expect(container.querySelector('browser-action-list')?.getAttribute('partition')).toBe(AGENT_PARTITION);
    await waitFor(() => expect(screen.getByTestId('browser-profile-badge').textContent).toBe('🦊'));
  });

  it('shows why an Agent profile could not open, with Retry; Retry asks main again and then mounts the webview', async () => {
    mocks.assistants.mockResolvedValue(AGENTS);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.profilePartition.mockResolvedValueOnce({ success: false, msg: 'Not a browser profile partition' });
    const { container } = renderViewer({ kind: 'agent', agentId: 'bare:retry' });

    expect(await screen.findByText('preview.browserChrome.profile.unavailable')).toBeTruthy();
    expect(screen.getByText('Not a browser profile partition')).toBeTruthy();
    expect(container.querySelector('webview')).toBeNull();
    // A user's own tab never refuses an agent request.
    expect(mocks.refuseTab).not.toHaveBeenCalled();

    mocks.profilePartition.mockResolvedValueOnce({ success: true, data: AGENT_PARTITION });
    fireEvent.click(screen.getByRole('button', { name: 'preview.browserChrome.profile.retry' }));

    await waitFor(() => expect(container.querySelector('webview')?.getAttribute('partition')).toBe(AGENT_PARTITION));
    expect(screen.queryByText('preview.browserChrome.profile.unavailable')).toBeNull();
    expect(mocks.profilePartition).toHaveBeenCalledTimes(2);
  });

  it("refuses the agent's waiting tab request at once when its Agent profile can't be set up", async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    mocks.profilePartition.mockRejectedValueOnce(new Error('ipc down'));
    renderViewer({ kind: 'agent', agentId: 'bare:refuse' }, true);

    await waitFor(() =>
      expect(mocks.refuseTab).toHaveBeenCalledWith({
        url: 'https://example.com/',
        profile: { kind: 'agent', agentId: 'bare:refuse' },
      })
    );
  });

  it('keeps a Personal tab on the Personal partition without asking main', () => {
    const { container } = renderViewer();

    expect(container.querySelector('webview')?.getAttribute('partition')).toBe('persist:aionui-browser');
    expect(mocks.profilePartition).not.toHaveBeenCalled();
    expect(screen.getByTestId('browser-profile-badge').getAttribute('aria-label')).toBe(
      'preview.browserChrome.profile.personal'
    );
  });
});

describe('profilePresentation', () => {
  it("names a profile of an engine's own generated entry 'Agent', never the vendor", () => {
    const bare = { id: 'bare:2d23ff1c', name: 'Claude Code', avatar: '/logos/claude.svg', source: 'generated' };
    const t = ((key: string) => (key === 'agent.displayName' ? 'Agent' : key)) as Parameters<
      typeof profilePresentation
    >[2];

    const shown = profilePresentation({ kind: 'agent', agentId: bare.id }, [bare] as unknown as Assistant[], t);

    expect(shown.name).toBe('Agent');
  });
});
