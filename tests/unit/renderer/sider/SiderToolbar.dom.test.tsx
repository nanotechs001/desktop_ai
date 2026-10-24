/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ setSiderCollapsed: vi.fn(), siderCollapsed: true }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({
  useLayoutContext: () => ({
    isMobile: false,
    siderCollapsed: h.siderCollapsed,
    setSiderCollapsed: h.setSiderCollapsed,
  }),
}));

import SiderToolbar from '@/renderer/components/layout/Sider/SiderNav/SiderToolbar';

afterEach(() => {
  cleanup();
  h.setSiderCollapsed.mockClear();
});

const renderToolbar = (collapsed: boolean) => {
  h.siderCollapsed = collapsed;
  const onNewChat = vi.fn();
  render(<SiderToolbar isMobile={false} collapsed={collapsed} siderTooltipProps={{}} onNewChat={onNewChat} />);
  return onNewChat;
};

describe('the sidebar toolbar', () => {
  it.each([
    { collapsed: true, label: 'common.expandMore' },
    { collapsed: false, label: 'common.collapse' },
  ])(
    'puts the sidebar toggle above New chat (collapsed: $collapsed), and it toggles the sidebar',
    ({ collapsed, label }) => {
      const onNewChat = renderToolbar(collapsed);

      const toggle = screen.getByRole('button', { name: label });
      const newChat = screen.getByLabelText('conversation.welcome.newConversation');
      expect(toggle.compareDocumentPosition(newChat) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

      fireEvent.click(toggle);
      expect(h.setSiderCollapsed).toHaveBeenCalledWith(!collapsed);
      fireEvent.click(newChat);
      expect(onNewChat).toHaveBeenCalledTimes(1);
    }
  );
});
