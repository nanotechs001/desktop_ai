/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The sidebar's Artifacts page: every artifact Pixebot created, opened in its chat's browser.
 */

import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { SWRConfig } from 'swr';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { TChatConversation } from '@/common/config/storage';
import type { ArtifactMeta } from '@/common/types/agent/artifacts';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));

const ipc = vi.hoisted(() => ({ list: vi.fn(), origin: vi.fn() }));
vi.mock('@/common', () => ({
  ipcBridge: { artifacts: { list: { invoke: ipc.list }, origin: { invoke: ipc.origin } } },
}));
const platform = vi.hoisted(() => ({ desktop: true }));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => platform.desktop }));
vi.mock('@/renderer/hooks/context/ConversationHistoryContext', () => ({
  useConversationHistoryContext: () => ({ conversations: [{ id: 'c1', name: 'Launch plan' } as TChatConversation] }),
}));
const preview = vi.hoisted(() => ({ revealBrowserFor: vi.fn() }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({ usePreviewContext: () => preview }));

import ArtifactsPage from '@/renderer/pages/artifacts';

const ORIGIN = 'http://127.0.0.1:4000';
const meta = (id: string, title: string, updatedAt: number): ArtifactMeta => ({
  id,
  conversationId: 'c1',
  title,
  kind: 'html',
  createdAt: updatedAt,
  updatedAt,
  latest: 1,
});

const LocationProbe: React.FC = () => <div data-testid='path'>{useLocation().pathname}</div>;

const renderPage = () =>
  render(
    <SWRConfig value={{ provider: () => new Map(), dedupingInterval: 0 }}>
      <MemoryRouter initialEntries={['/artifacts']}>
        <ArtifactsPage />
        <LocationProbe />
      </MemoryRouter>
    </SWRConfig>
  );

describe('ArtifactsPage', () => {
  beforeEach(() => {
    platform.desktop = true;
    ipc.list.mockReset();
    ipc.origin.mockReset();
    ipc.origin.mockResolvedValue({ success: true, data: ORIGIN });
    preview.revealBrowserFor.mockReset();
  });

  it('lists the artifacts in the order the store gives (last updated first), with their chat', async () => {
    ipc.list.mockResolvedValue({ success: true, data: [meta('a2', 'Pricing page', 200), meta('a1', 'Roadmap', 100)] });
    renderPage();

    expect(await screen.findByText('Pricing page')).toBeInTheDocument();
    const titles = screen.getAllByTestId('artifact-row').map((row) => row.querySelector('[data-name]')?.textContent);
    expect(titles).toEqual(['Pricing page', 'Roadmap']);
    expect(screen.getAllByText('Launch plan')).toHaveLength(2);
  });

  it('opens an artifact in its chat, in the browser panel', async () => {
    ipc.list.mockResolvedValue({ success: true, data: [meta('a1', 'Roadmap', 100)] });
    renderPage();

    fireEvent.click(await screen.findByText('Roadmap'));

    expect(preview.revealBrowserFor).toHaveBeenCalledWith('c1', `${ORIGIN}/a/a1`);
    await waitFor(() => expect(screen.getByTestId('path')).toHaveTextContent('/conversation/c1'));
  });

  it('says so when there are none yet', async () => {
    ipc.list.mockResolvedValue({ success: true, data: [] });
    renderPage();

    expect(await screen.findByText('conversation.artifacts.empty')).toBeInTheDocument();
  });

  it('offers a retry when the list cannot be read', async () => {
    ipc.list.mockResolvedValueOnce({ success: false, msg: 'Artifacts are unavailable' });
    renderPage();

    const retry = await screen.findByRole('button', { name: 'conversation.artifacts.retry' });
    ipc.list.mockResolvedValue({ success: true, data: [meta('a1', 'Roadmap', 100)] });
    fireEvent.click(retry);

    expect(await screen.findByText('Roadmap')).toBeInTheDocument();
  });

  it('points the WebUI to the desktop app instead of asking the desktop-only list', () => {
    platform.desktop = false;
    renderPage();

    expect(screen.getByText('conversation.artifacts.desktopOnly')).toBeInTheDocument();
    expect(ipc.list).not.toHaveBeenCalled();
  });
});
