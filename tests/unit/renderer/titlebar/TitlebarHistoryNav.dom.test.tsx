import { fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const layoutState = vi.hoisted(() => ({ isMobile: false }));
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
  ipcBridge: { conversation: { get: { invoke: vi.fn().mockResolvedValue(null) } } },
}));
vi.mock('@/renderer/components/layout/Titlebar/HistoryPanel', () => ({
  default: ({ open, onSearchMessages }: { open: boolean; onSearchMessages?: () => void }) =>
    open ? (
      <div data-testid='history-panel'>
        <span role='button' onClick={onSearchMessages}>
          panel-search-messages
        </span>
      </div>
    ) : null,
}));
vi.mock('@renderer/pages/conversation/GroupedHistory/ConversationSearchPopover', () => ({
  // The popover owns Cmd/Ctrl+Shift+F and asks to open through onOpenChange(true); the span stands in for that key.
  default: ({ open, onOpenChange }: { open?: boolean; onOpenChange?: (open: boolean) => void }) => (
    <div data-testid='message-search' data-open={String(Boolean(open))}>
      <span onClick={() => onOpenChange?.(true)}>shortcut-search-messages</span>
    </div>
  ),
}));
vi.mock('@/renderer/components/layout/Titlebar/useChatNavHistory', () => ({ useChatNavHistory: () => nav }));
vi.mock('@/renderer/components/layout/Titlebar/MobileConversationBrand', () => ({ default: () => null }));
vi.mock('@/renderer/components/layout/Titlebar/TitlebarNav', () => ({ default: () => null }));
vi.mock('@/renderer/components/layout/WindowControls', () => ({ default: () => null }));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({ ...layoutState, siderCollapsed: false, setSiderCollapsed: vi.fn() }),
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true, isMacOS: () => true }));

import Titlebar from '@/renderer/components/layout/Titlebar';

describe('Titlebar chat history controls', () => {
  beforeEach(() => {
    layoutState.isMobile = false;
    nav.canBack = true;
    nav.canForward = false;
    nav.back.mockClear();
    nav.forward.mockClear();
  });

  it('shows Search, Back and Forward in that order, without a sidebar toggle outside Settings', () => {
    render(<Titlebar workspaceAvailable={false} />);

    expect(screen.queryByRole('button', { name: 'common.collapse' })).not.toBeInTheDocument();
    const search = screen.getByRole('button', { name: 'conversation.history.searchChats' });
    const back = screen.getByRole('button', { name: 'common.historyBack' });
    const forward = screen.getByRole('button', { name: 'common.forward' });

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

  it('renders the titlebar controls as Arco buttons', () => {
    render(<Titlebar workspaceAvailable={false} />);

    for (const name of ['conversation.history.searchChats', 'common.historyBack', 'common.forward']) {
      expect(screen.getByRole('button', { name })).toHaveClass('arco-btn', 'app-titlebar__button');
    }
  });

  it('keeps one message-search popover mounted for Cmd+Shift+F on desktop', () => {
    render(<Titlebar workspaceAvailable={false} />);

    expect(screen.getByTestId('message-search')).toHaveAttribute('data-open', 'false');
  });

  it('leaves message search to the sidebar on mobile', () => {
    layoutState.isMobile = true;
    render(<Titlebar workspaceAvailable={false} />);

    expect(screen.queryByTestId('message-search')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'conversation.history.searchChats' })).toBeInTheDocument();
  });

  it('closes the history panel and opens message search from the panel entry', () => {
    render(<Titlebar workspaceAvailable={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'conversation.history.searchChats' }));

    fireEvent.click(screen.getByText('panel-search-messages'));

    expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('message-search')).toHaveAttribute('data-open', 'true');
  });

  it('closes the open history panel when Cmd+Shift+F opens message search', () => {
    render(<Titlebar workspaceAvailable={false} />);
    fireEvent.click(screen.getByRole('button', { name: 'conversation.history.searchChats' }));
    expect(screen.getByTestId('history-panel')).toBeInTheDocument();

    fireEvent.click(screen.getByText('shortcut-search-messages'));

    expect(screen.queryByTestId('history-panel')).not.toBeInTheDocument();
    expect(screen.getByTestId('message-search')).toHaveAttribute('data-open', 'true');
  });
});
