import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const layout = vi.hoisted(() => ({
  value: {} as Record<string, unknown>,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/conversation/test', search: '', hash: '' }),
  useNavigate: () => vi.fn(),
}));
vi.mock('@/common', () => ({
  ipcBridge: { conversation: { get: { invoke: vi.fn() } } },
}));
vi.mock('@renderer/pages/conversation/GroupedHistory/ConversationSearchPopover', () => ({ default: () => null }));
vi.mock('@/renderer/components/layout/Titlebar/HistoryPanel', () => ({ default: () => null }));
vi.mock('@/renderer/components/layout/Titlebar/MobileConversationBrand', () => ({ default: () => null }));
vi.mock('@/renderer/components/layout/Titlebar/TitlebarNav', () => ({
  default: () => <div data-testid='app-nav' />,
}));
vi.mock('@/renderer/components/layout/WindowControls', () => ({
  default: () => <div data-testid='window-controls' />,
}));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => layout.value,
}));
vi.mock('@/renderer/components/layout/Titlebar/useChatNavHistory', () => ({
  useChatNavHistory: () => ({ canBack: false, canForward: false, back: vi.fn(), forward: vi.fn() }),
}));
vi.mock('@/renderer/utils/platform', () => ({
  isElectronDesktop: () => true,
  isMacOS: () => false,
}));

import Titlebar from '@/renderer/components/layout/Titlebar';

const share = (enabled: boolean, active: boolean) => ({ enabled, active, toggle: vi.fn() });

describe('Titlebar screen-share toggle', () => {
  beforeEach(() => {
    layout.value = { isMobile: false, browserMode: true, screenShare: share(false, false) };
  });

  it('shows the toggle only in browser mode', () => {
    const { rerender } = render(<Titlebar workspaceAvailable />);
    expect(screen.getByRole('button', { name: 'common.screenShareOn' })).toBeInTheDocument();

    layout.value = { ...layout.value, browserMode: false };
    rerender(<Titlebar workspaceAvailable />);
    expect(screen.queryByRole('button', { name: 'common.screenShareOn' })).not.toBeInTheDocument();
  });

  it('hides the app icons and workspace toggle while active, keeping the toggle and window controls', () => {
    layout.value = { ...layout.value, screenShare: share(true, true) };
    render(<Titlebar workspaceAvailable />);

    expect(screen.getByRole('button', { name: 'common.screenShareOff' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByTestId('app-nav')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'common.expandMore' })).not.toBeInTheDocument();
    expect(screen.getByTestId('window-controls')).toBeInTheDocument();
  });

  it('keeps the app icons while off, and the toggle switches the mode', () => {
    const mode = share(false, false);
    layout.value = { ...layout.value, screenShare: mode };
    render(<Titlebar workspaceAvailable />);

    expect(screen.getByTestId('app-nav')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'common.screenShareOn' }));
    expect(mode.toggle).toHaveBeenCalledTimes(1);
  });
});
