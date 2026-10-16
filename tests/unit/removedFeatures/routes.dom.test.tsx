/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Teams and the desktop Pet are removed from this fork: their routes redirect
 * and the Settings sider has no Pet tab.
 */

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Outlet } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ status: 'authenticated', user: { id: 'u1' } }),
}));
vi.mock('@/renderer/hooks/system/useCrossSessionRateLimitNotice', () => ({
  useCrossSessionRateLimitNotice: () => undefined,
}));
vi.mock('@renderer/components/layout/DocumentTitle', () => ({ default: () => null }));
vi.mock('@renderer/components/layout/AppLoader', () => ({ default: () => <div data-testid='loader' /> }));
vi.mock('@renderer/pages/guid', () => ({ default: () => <div data-testid='page-guid' /> }));
vi.mock('@renderer/pages/settings/AgentSettings', () => ({ default: () => <div data-testid='page-agent-settings' /> }));
vi.mock('@/renderer/hooks/system/useExtensionSettingsTabs', () => ({ useExtensionSettingsTabs: () => [] }));
vi.mock('@/renderer/hooks/system/useExtI18n', () => ({
  useExtI18n: () => ({ resolveExtTabName: (tab: { name: string }) => tab.name }),
}));
vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
  resolveExtensionAssetUrl: (url: string) => url,
}));

import PanelRoute from '@renderer/components/layout/Router';
import SettingsSider from '@/renderer/pages/settings/components/SettingsSider';
import { BUILTIN_TAB_IDS } from '@/renderer/pages/settings/components/SettingsSider';

describe('removed routes redirect', () => {
  beforeEach(() => {
    window.location.hash = '';
  });
  afterEach(cleanup);

  it('redirects /team/:id away from the Teams page', async () => {
    window.location.hash = '#/team/abc';
    render(<PanelRoute layout={<Outlet />} />);

    await waitFor(() => expect(window.location.hash).toBe('#/guid'));
    expect(await screen.findByTestId('page-guid')).toBeInTheDocument();
  });

  it('redirects /settings/pet to /settings, which opens the first settings page', async () => {
    window.location.hash = '#/settings/pet';
    render(<PanelRoute layout={<Outlet />} />);

    await waitFor(() => expect(window.location.hash).toBe('#/settings/agent'));
    expect(await screen.findByTestId('page-agent-settings')).toBeInTheDocument();
  });
});

describe('Settings sider', () => {
  afterEach(cleanup);

  it('has no Pet tab id', () => {
    expect(BUILTIN_TAB_IDS).not.toContain('pet');
  });

  it('renders no Pet tab', () => {
    render(
      <MemoryRouter initialEntries={['/settings/system']}>
        <SettingsSider />
      </MemoryRouter>
    );

    expect(screen.getByText('settings.system')).toBeInTheDocument();
    expect(screen.queryByText('pet.desktopPet')).not.toBeInTheDocument();
  });
});
