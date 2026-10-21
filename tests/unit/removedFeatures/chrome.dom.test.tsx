/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * Butler and Feedback are removed from this fork: the titlebar has no
 * feedback button, and the startup-failure
 * dialog explains the error without a "send diagnostics" button.
 */

import { cleanup, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/conversation/test', search: '', hash: '' }),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: { conversation: { get: { invoke: vi.fn().mockResolvedValue(null) } } },
}));
vi.mock('@/renderer/components/layout/Titlebar/HistoryPanel', () => ({ default: () => null }));
vi.mock('@renderer/pages/conversation/GroupedHistory/ConversationSearchPopover', () => ({ default: () => null }));
vi.mock('@/renderer/components/layout/Titlebar/useChatNavHistory', () => ({
  useChatNavHistory: () => ({ canBack: false, canForward: false, back: vi.fn(), forward: vi.fn() }),
}));
vi.mock('@/renderer/components/layout/Titlebar/MobileConversationBrand', () => ({ default: () => null }));
vi.mock('@/renderer/components/layout/Titlebar/TitlebarNav', () => ({
  default: ({ leading }: { leading?: React.ReactNode }) => <>{leading}</>,
}));
vi.mock('@/renderer/components/layout/WindowControls', () => ({ default: () => null }));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false, siderCollapsed: false, setSiderCollapsed: vi.fn() }),
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true, isMacOS: () => true }));

// Sider
vi.mock('@renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  usePreviewContext: () => ({ closePreview: vi.fn(), clearPreviewForScope: vi.fn() }),
}));
vi.mock('@renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ logout: vi.fn(), status: 'authenticated' }),
}));
vi.mock('@renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'light', setTheme: vi.fn() }),
}));
vi.mock('@renderer/utils/ui/siderTooltip', () => ({
  cleanupSiderTooltips: vi.fn(),
  getSiderTooltipProps: () => ({}),
}));
vi.mock('@renderer/components/layout/Sider/SiderNav', () => ({
  SiderToolbar: () => <div data-testid='sider-new-chat' />,
  SiderSearchEntry: () => null,
  SiderScheduledEntry: () => null,
  SiderAssistantEntry: () => null,
}));
vi.mock('@renderer/components/layout/Sider/SiderFooter', () => ({ default: () => <div data-testid='sider-footer' /> }));
vi.mock('@renderer/pages/settings/components/SettingsSider', () => ({ default: () => null }));

import Titlebar from '@/renderer/components/layout/Titlebar';
import { InstallationIntegrityFooter } from '@/renderer/components/layout/InstallationIntegrityDialog';

afterEach(cleanup);

describe('Feedback and Butler', () => {
  it('adds no feedback button to the titlebar', () => {
    render(<Titlebar workspaceAvailable />);

    expect(screen.queryByRole('button', { name: 'conversation.welcome.quickActionFeedback' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'conversation.history.searchChats' })).toBeInTheDocument();
  });
});

describe('startup failure dialog', () => {
  it.each(['backend_exited', 'port_report_timeout', 'startup_failed', 'incomplete_installation'] as const)(
    'shows no diagnostics button for %s',
    (diagnosticsKind) => {
      render(<InstallationIntegrityFooter diagnosticsKind={diagnosticsKind} />);

      expect(screen.queryByTestId('installation-integrity-report')).not.toBeInTheDocument();
      expect(screen.queryByText(/sendDiagnostics/)).not.toBeInTheDocument();
    }
  );
});
