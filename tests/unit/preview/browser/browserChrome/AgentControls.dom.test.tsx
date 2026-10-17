/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTabProfile, TabOwnership } from '@/common/types/browser';

vi.mock('@/common', () => ({
  ipcBridge: {
    assistants: {
      list: { invoke: () => Promise.resolve([{ id: 'bare:sales', name: 'Sales', avatar: '🦊', source: 'user' }]) },
    },
    agentBrowser: { share: { invoke: vi.fn() } },
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { name?: string }) => (opts?.name ? `${key} ${opts.name}` : key),
  }),
}));

import AgentControls from '@/renderer/pages/conversation/Preview/browser/BrowserChrome/AgentControls';

const KEY = 'preview.browserChrome.agent';

const userTab = (profile: BrowserTabProfile, sharedWith: 'all' | null = null): TabOwnership => ({
  webContentsId: 3,
  owner: 'user',
  sharedWith,
  paused: false,
  profile,
});

const renderControls = (ownership: TabOwnership) =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <AgentControls webContentsId={3} ownership={ownership} actions={[]} />
    </SWRConfig>
  );

afterEach(cleanup);

describe('AgentControls sharing', () => {
  it("says the tab is shared with that Agent only, for a tab in an Agent's profile", async () => {
    renderControls(userTab({ kind: 'agent', agentId: 'bare:sales' }));
    expect(await screen.findByRole('button', { name: `${KEY}.shareWith Sales` })).toBeTruthy();

    cleanup();
    renderControls(userTab({ kind: 'agent', agentId: 'bare:sales' }, 'all'));
    const stop = await screen.findByRole('button', { name: `${KEY}.stopSharing` });
    expect(stop.getAttribute('title')).toBe(`${KEY}.sharedWith Sales`);
  });

  it('keeps "Share with agent" for a Personal tab', () => {
    renderControls(userTab({ kind: 'personal' }));
    expect(screen.getByRole('button', { name: `${KEY}.share` })).toBeTruthy();
  });
});
