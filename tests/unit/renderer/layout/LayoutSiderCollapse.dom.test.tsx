/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, render } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (k: string) => k, i18n: { language: 'en' } }),
}));

const shortcutMocks = vi.hoisted(() => ({
  params: undefined as undefined | { toggleSider: () => void },
}));
// On desktop the sider exists only in Settings (chat routes navigate from the titlebar).
const route = vi.hoisted(() => ({ pathname: '/settings/about' }));
vi.mock('react-router-dom', () => ({
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: route.pathname, search: '', hash: '' }),
  useNavigationType: () => 'POP',
  Outlet: () => null,
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    application: { openDevTools: { invoke: () => Promise.resolve() }, logStream: { on: () => () => {} } },
    task: { stopAll: { invoke: () => Promise.resolve({ success: false }) } },
  },
}));
vi.mock('@/common/config/constants', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/common/config/constants')>()),
  TEAM_MODE_ENABLED: false,
}));
vi.mock('@/renderer/components/layout/PwaPullToRefresh', () => ({ default: () => null }));
vi.mock('@/renderer/components/layout/Titlebar', () => ({ default: () => null }));
vi.mock('@/renderer/components/settings/UpdateModal', () => ({ default: () => null }));
vi.mock('@renderer/hooks/agent/useDefaultEngine', () => ({
  useEngineDriftSync: () => {},
  useDefaultAgentSync: () => {},
}));
vi.mock('@renderer/hooks/system/useDeepLink', () => ({ useDeepLink: () => {} }));
vi.mock('@renderer/hooks/system/notification/useNotificationClick', () => ({ useNotificationClick: () => {} }));
vi.mock('@renderer/hooks/system/notification/useBrowserNotification', () => ({ useBrowserNotification: () => {} }));
vi.mock('@renderer/utils/ui/siderTooltip', () => ({ cleanupSiderTooltips: () => {} }));
vi.mock('@renderer/hooks/ui/useConversationShortcuts', () => ({
  useConversationShortcuts: (params: { toggleSider: () => void }) => {
    shortcutMocks.params = params;
  },
}));
vi.mock('@renderer/utils/platform', () => ({ isElectronDesktop: () => true }));
vi.mock('@renderer/pages/agentWidget/useAgentWidgetSync', () => ({ useAgentWidgetSync: () => {} }));
vi.mock('@renderer/pages/conversation/Preview/browser/BrowserTabLayer', () => ({ default: () => null }));
vi.mock('@renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  usePreviewContext: () => ({ closePreview: () => {} }),
}));

import Layout from '@renderer/components/layout/Layout';

const STORAGE_KEY = 'sider-collapsed';
const ICON_ONLY_WIDTH = '56px';

const setViewportWidth = (width: number) => {
  Object.defineProperty(window, 'innerWidth', { configurable: true, writable: true, value: width });
};

const renderLayout = () => {
  const view = render(<Layout sider={<div>sider</div>} />);
  const sider = view.container.querySelector('.layout-sider') as HTMLElement;
  return { ...view, sider };
};

describe('Layout sider icon-only mode', () => {
  beforeEach(() => {
    Object.defineProperty(window, 'matchMedia', {
      writable: true,
      value: (query: string) => ({
        matches: false,
        media: query,
        addEventListener: () => {},
        removeEventListener: () => {},
      }),
    });
    localStorage.clear();
    setViewportWidth(1280);
  });

  afterEach(() => {
    localStorage.clear();
    shortcutMocks.params = undefined;
    route.pathname = '/settings/about';
  });

  it('renders no left sider on desktop chat routes (navigation lives in the titlebar)', () => {
    route.pathname = '/guid';
    const { sider } = renderLayout();
    expect(sider).toBeNull();
  });

  it('starts collapsed to icon-only width on desktop with no stored value', () => {
    const { sider } = renderLayout();

    expect(sider.classList.contains('collapsed')).toBe(true);
    expect(sider.style.width).toBe(ICON_ONLY_WIDTH);
  });

  it('starts expanded on desktop when a stored 0 says so', () => {
    localStorage.setItem(STORAGE_KEY, '0');
    const { sider } = renderLayout();

    expect(sider.classList.contains('collapsed')).toBe(false);
    expect(sider.style.width).toBe('260px');
  });

  it('persists the toggle', () => {
    const { sider } = renderLayout();

    act(() => shortcutMocks.params?.toggleSider());
    expect(sider.classList.contains('collapsed')).toBe(false);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('0');

    act(() => shortcutMocks.params?.toggleSider());
    expect(sider.style.width).toBe(ICON_ONLY_WIDTH);
    expect(localStorage.getItem(STORAGE_KEY)).toBe('1');
  });

  it('keeps the mobile sidebar hidden at width 0 and leaves the stored preference alone', () => {
    setViewportWidth(500);
    localStorage.setItem(STORAGE_KEY, '0');
    const { sider } = renderLayout();

    expect(sider.classList.contains('collapsed')).toBe(true);
    expect(sider.style.width).toBe('0px');
    expect(localStorage.getItem(STORAGE_KEY)).toBe('0');
  });

  it('falls back to collapsed when storage throws', () => {
    const getItem = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('denied');
    });
    const { sider } = renderLayout();
    getItem.mockRestore();

    expect(sider.style.width).toBe(ICON_ONLY_WIDTH);
  });
});
