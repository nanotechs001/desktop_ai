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
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/hooks/assistant/useRegularChatsOnly', () => ({ useRegularChatsOnly: () => () => true }));
vi.mock('@renderer/components/layout/Titlebar/HistoryPanel', () => ({
  HistoryPanelBody: () => <div data-testid='sider-chat-list' />,
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
  SiderNavEntry: ({ label }: { label: string }) => <div data-testid={`sider-entry-${label}`} />,
}));
vi.mock('@renderer/components/layout/Sider/SiderFooter', () => ({
  default: () => <div data-testid='sider-footer' />,
}));
vi.mock('@renderer/pages/settings/components/SettingsSider', () => ({ default: () => null }));
import Sider from '@renderer/components/layout/Sider';

describe('Sider', () => {
  it('lists the chats under New chat, VA Bots, Scheduled and Artifacts in the expanded sidebar', async () => {
    render(<Sider collapsed={false} />);

    expect(await screen.findByTestId('sider-footer')).toBeInTheDocument();
    expect(screen.getByTestId('sider-new-chat')).toBeInTheDocument();
    expect(screen.getByTestId('sider-agents')).toBeInTheDocument();
    expect(screen.getByTestId('sider-scheduled')).toBeInTheDocument();
    expect(screen.getByTestId('sider-entry-conversation.artifacts.title')).toBeInTheDocument();
    expect(screen.getByTestId('sider-chat-list')).toBeInTheDocument();
  });

  it('keeps the icon rail to its icons, without the chat list', async () => {
    render(<Sider collapsed />);

    expect(await screen.findByTestId('sider-footer')).toBeInTheDocument();
    // Let any lazily imported list resolve before asserting it is absent.
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(screen.getByTestId('sider-entry-conversation.artifacts.title')).toBeInTheDocument();
    expect(screen.queryByTestId('sider-chat-list')).toBeNull();
  });
});
