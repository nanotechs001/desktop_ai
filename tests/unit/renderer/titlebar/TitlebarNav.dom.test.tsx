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

  // History, Scheduled and New chat live in the sidebar (its rail on the left); the bell sits right after search.
  it.each([
    { state: 'open', siderCollapsed: false },
    { state: 'an icon rail', siderCollapsed: true },
  ])('shows search, the reminders bell, VA Bots and Settings while the sidebar is $state', ({ siderCollapsed }) => {
    layout.value = { isMobile: false, siderCollapsed };
    renderNav();
    expect(buttonLabels()).toEqual(['search', 'reminders', 'settings.assistants', 'common.settings']);
  });
});
