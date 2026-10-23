/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The desktop titlebar navigation: New chat first, then the leading controls (search, back, forward), VA Bots,
 * history, scheduled tasks and settings.
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useLocation: () => ({ pathname: '/guid' }), useNavigate: () => vi.fn() }));
vi.mock('@/renderer/hooks/config/useConfig', () => ({ useConfig: () => [undefined] }));
vi.mock('@renderer/pages/conversation/Preview', () => ({ usePreviewContext: () => ({ closePreview: vi.fn() }) }));
vi.mock('@/renderer/components/layout/Titlebar/HistoryPanel', () => ({ default: () => null }));
const layout = vi.hoisted(() => ({
  value: null as null | { isMobile: boolean; siderCollapsed: boolean },
}));
vi.mock('@/renderer/hooks/context/LayoutContext', () => ({ useLayoutContext: () => layout.value }));
vi.mock('@/renderer/components/layout/Titlebar/RobotListButton', () => ({
  default: ({ label }: { label: string }) => <button type='button' aria-label={label} />,
}));
vi.mock('@/renderer/components/layout/Titlebar/RemindersButton', () => ({
  default: () => <button type='button' aria-label='reminders' />,
}));

import TitlebarNav from '@/renderer/components/layout/Titlebar/TitlebarNav';

afterEach(cleanup);

const buttonLabels = () =>
  Array.from(screen.getByTestId('bar').querySelectorAll('[aria-label]'))
    .filter((node) => node.tagName === 'BUTTON')
    .map((node) => node.getAttribute('aria-label'));

const renderNav = () =>
  render(
    <div data-testid='bar'>
      <TitlebarNav buttonClassName='nav' iconSize={18} leading={<button type='button' aria-label='search' />} />
    </div>
  );

describe('TitlebarNav', () => {
  afterEach(() => {
    layout.value = null;
  });

  it('leaves New chat, history and scheduled to the open sidebar', () => {
    layout.value = { isMobile: false, siderCollapsed: false };
    renderNav();
    expect(buttonLabels()).toEqual(['search', 'settings.assistants', 'common.settings', 'reminders']);
  });

  it('brings them back while the sidebar is an icon rail', () => {
    layout.value = { isMobile: false, siderCollapsed: true };
    renderNav();
    expect(buttonLabels()).toContain('conversation.history.chatHistory');
    expect(buttonLabels()).toContain('conversation.welcome.newConversation');
  });

  it('puts New chat first, the leading controls next, VA Bots before history, and the reminders bell last', () => {
    render(
      <div data-testid='bar'>
        <TitlebarNav buttonClassName='nav' iconSize={18} leading={<button type='button' aria-label='search' />} />
      </div>
    );

    const labels = Array.from(screen.getByTestId('bar').querySelectorAll('[aria-label]'))
      .filter((node) => node.tagName === 'BUTTON')
      .map((node) => node.getAttribute('aria-label'));
    expect(labels).toEqual([
      'conversation.welcome.newConversation',
      'search',
      'settings.assistants',
      'conversation.history.chatHistory',
      'cron.scheduledTasks',
      'common.settings',
      'reminders',
    ]);
  });
});
