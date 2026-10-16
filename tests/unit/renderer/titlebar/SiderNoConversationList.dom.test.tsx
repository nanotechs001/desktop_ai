import { act, render, screen } from '@testing-library/react';
import React from 'react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/conversation/abc', search: '', hash: '' }),
  useNavigate: () => vi.fn(),
}));
vi.mock('@renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  usePreviewContext: () => ({ closePreview: vi.fn(), clearPreviewForScope: vi.fn() }),
}));
vi.mock('@renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ logout: vi.fn(), status: 'authenticated' }),
}));
vi.mock('@renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'light', setTheme: vi.fn() }),
}));
vi.mock('@renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false }),
}));
vi.mock('@renderer/utils/ui/siderTooltip', () => ({
  cleanupSiderTooltips: vi.fn(),
  getSiderTooltipProps: () => ({}),
}));
vi.mock('@renderer/components/layout/Sider/SiderNav', () => ({
  SiderToolbar: () => <div data-testid='sider-new-chat' />,
  SiderSearchEntry: () => null,
  SiderScheduledEntry: () => <div data-testid='sider-scheduled' />,
  SiderAssistantEntry: () => <div data-testid='sider-agents' />,
}));
vi.mock('@renderer/components/layout/Sider/SiderFooter', () => ({
  default: () => <div data-testid='sider-footer' />,
}));
vi.mock('@renderer/components/layout/Sider/TeamSiderSection', () => ({ default: () => null }));
vi.mock('@renderer/pages/settings/components/SettingsSider', () => ({ default: () => null }));
vi.mock('@renderer/pages/conversation/GroupedHistory', () => ({
  default: () => <div data-testid='conversation-list' />,
}));

import Sider from '@renderer/components/layout/Sider';

describe('Sider', () => {
  it.each([
    { mode: 'expanded sidebar', collapsed: false },
    { mode: 'icon rail', collapsed: true },
  ])('renders no conversation list in the $mode', async ({ collapsed }) => {
    render(<Sider collapsed={collapsed} />);

    expect(await screen.findByTestId('sider-footer')).toBeInTheDocument();
    // Let any lazily imported list resolve before asserting it is absent.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(screen.getByTestId('sider-new-chat')).toBeInTheDocument();
    expect(screen.getByTestId('sider-agents')).toBeInTheDocument();
    expect(screen.getByTestId('sider-scheduled')).toBeInTheDocument();
    expect(screen.queryByTestId('conversation-list')).not.toBeInTheDocument();
  });
});
