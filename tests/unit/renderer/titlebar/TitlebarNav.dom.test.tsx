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
vi.mock('@/renderer/components/layout/Titlebar/RobotListButton', () => ({
  default: ({ label }: { label: string }) => <button type='button' aria-label={label} />,
}));

import TitlebarNav from '@/renderer/components/layout/Titlebar/TitlebarNav';

afterEach(cleanup);

describe('TitlebarNav', () => {
  it('puts New chat first, the leading controls next, then VA Bots before history', () => {
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
    ]);
  });
});
