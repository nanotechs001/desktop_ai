import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const nav = vi.hoisted(() => ({
  canBack: true,
  canForward: false,
  back: vi.fn(),
  forward: vi.fn(),
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
vi.mock('@/common/config/constants', () => ({ TEAM_MODE_ENABLED: false }));
vi.mock('@/renderer/components/layout/Titlebar/HistoryPanel', () => ({
  default: ({ open }: { open: boolean }) => (open ? <div data-testid='history-panel' /> : null),
}));
vi.mock('@/renderer/components/layout/Titlebar/useChatNavHistory', () => ({ useChatNavHistory: () => nav }));
vi.mock('@/renderer/components/layout/Titlebar/MobileConversationBrand', () => ({ default: () => null }));
vi.mock('@/renderer/components/layout/WindowControls', () => ({ default: () => null }));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ isMobile: false, siderCollapsed: false, setSiderCollapsed: vi.fn() }),
}));
vi.mock('@/renderer/hooks/context/FeedbackContext', () => ({
  useFeedback: () => ({ openFeedback: vi.fn() }),
}));
vi.mock('@/renderer/services/feedback/resolveFeedbackModule', () => ({
  resolveFeedbackModule: () => 'conversation-session',
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true, isMacOS: () => true }));

import Titlebar from '@/renderer/components/layout/Titlebar';

describe('Titlebar chat history controls', () => {
  beforeEach(() => {
    nav.canBack = true;
    nav.canForward = false;
    nav.back.mockClear();
    nav.forward.mockClear();
  });

  it('shows sidebar toggle, Search, Back and Forward in that order', () => {
    render(<Titlebar workspaceAvailable={false} />);

    const sidebar = screen.getByRole('button', { name: 'common.collapse' });
    const search = screen.getByRole('button', { name: 'conversation.history.searchChats' });
    const back = screen.getByRole('button', { name: 'common.historyBack' });
    const forward = screen.getByRole('button', { name: 'common.forward' });

    expect(sidebar.nextElementSibling).toBe(search);
    expect(search.nextElementSibling).toBe(back);
    expect(back.nextElementSibling).toBe(forward);
  });

  it('opens the history panel from Search', () => {
    render(<Titlebar workspaceAvailable={false} />);
    expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'conversation.history.searchChats' }));

    expect(screen.getByTestId('history-panel')).toBeInTheDocument();
  });

  it('drives Back and Forward from the chat history and disables them at the ends', () => {
    render(<Titlebar workspaceAvailable={false} />);
    const back = screen.getByRole('button', { name: 'common.historyBack' });
    const forward = screen.getByRole('button', { name: 'common.forward' });

    expect(back).toBeEnabled();
    expect(forward).toBeDisabled();

    fireEvent.click(back);
    expect(nav.back).toHaveBeenCalledTimes(1);
    expect(nav.forward).not.toHaveBeenCalled();
  });
});
