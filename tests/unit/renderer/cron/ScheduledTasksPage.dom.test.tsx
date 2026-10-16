/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The scheduled-tasks "New task" menu keeps its own "Create via chat" item (it hands off to the
 * home page, not to the removed Butler).
 */

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const navigateMock = vi.hoisted(() => vi.fn());

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => navigateMock }));
vi.mock('@renderer/hooks/context/LayoutContext', () => ({ useLayoutContext: () => ({ isMobile: false }) }));
vi.mock('@renderer/pages/cron/useCronJobs', () => ({
  useAllCronJobs: () => ({ jobs: [], loading: false, pauseJob: vi.fn(), resumeJob: vi.fn() }),
}));
vi.mock('@renderer/pages/conversation/hooks/useConversationAssistants', () => ({
  useConversationAssistants: () => ({ presetAssistants: [] }),
}));
vi.mock('@/common/adapter/ipcBridge', () => ({
  systemSettings: { setKeepAwake: { invoke: vi.fn() } },
}));
vi.mock('@/common/config/configService', () => ({ configService: { get: () => false, setLocal: vi.fn() } }));
vi.mock('@/renderer/pages/cron/ScheduledTasksPage/CreateTaskDialog', () => ({
  default: ({ visible }: { visible: boolean }) => (visible ? <div data-testid='create-task-dialog' /> : null),
}));
vi.mock('@/renderer/hooks/context/ThemeContext', () => ({
  useThemeContext: () => ({ theme: 'light', fontScale: 1 }),
}));
vi.mock('@/renderer/components/agent/ThemedLogo', () => ({ default: () => null }));

import ScheduledTasksPage from '@/renderer/pages/cron/ScheduledTasksPage';

const openNewTaskMenu = () => fireEvent.click(screen.getByText('cron.page.newTask'));

describe('ScheduledTasksPage new-task menu', () => {
  beforeEach(() => {
    navigateMock.mockClear();
  });
  afterEach(cleanup);

  it('"Create via chat" goes to /guid with the default cron prompt prefilled', async () => {
    render(<ScheduledTasksPage />);

    openNewTaskMenu();
    fireEvent.click(await screen.findByText('cron.page.createViaChat'));

    expect(navigateMock).toHaveBeenCalledWith('/guid', { state: { prefillPrompt: 'cron.status.defaultPrompt' } });
  });

  it('"Create manually" opens the dialog and does not navigate', async () => {
    render(<ScheduledTasksPage />);

    openNewTaskMenu();
    fireEvent.click(await screen.findByText('cron.page.createManually'));

    expect(await screen.findByTestId('create-task-dialog')).toBeInTheDocument();
    expect(navigateMock).not.toHaveBeenCalled();
  });
});
