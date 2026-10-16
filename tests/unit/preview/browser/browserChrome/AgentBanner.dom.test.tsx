/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resume: vi.fn((_arg: { webContentsId: number }): Promise<{ success: boolean }> => Promise.resolve({ success: true })),
  messageError: vi.fn(),
}));

// Arco's imperative Message needs a legacy ReactDOM.render, which React 19 lacks in jsdom.
vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...actual, Message: { ...actual.Message, error: mocks.messageError } };
});

vi.mock('@/common', () => ({ ipcBridge: { agentBrowser: { resume: { invoke: mocks.resume } } } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import AgentBanner from '@/renderer/pages/conversation/Preview/browser/BrowserChrome/AgentBanner';

const KEY = 'preview.browserChrome.agent';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('AgentBanner', () => {
  it('shows the paused message and Resume calls agentBrowser.resume for this tab', () => {
    render(<AgentBanner webContentsId={7} />);

    expect(screen.getByText(`${KEY}.paused`)).toBeTruthy();
    fireEvent.click(screen.getByText(`${KEY}.resume`));
    expect(mocks.resume).toHaveBeenCalledWith({ webContentsId: 7 });
  });

  it('does not complain when resume succeeds', async () => {
    render(<AgentBanner webContentsId={7} />);
    fireEvent.click(screen.getByText(`${KEY}.resume`));
    await waitFor(() => expect(mocks.resume).toHaveBeenCalled());
    expect(mocks.messageError).not.toHaveBeenCalled();
  });

  it.each([
    ['rejects', () => Promise.reject(new Error('ipc down'))],
    ['resolves success: false', () => Promise.resolve({ success: false })],
  ])('tells the user when resume %s', async (_name, outcome) => {
    mocks.resume.mockImplementationOnce(outcome);
    render(<AgentBanner webContentsId={7} />);

    fireEvent.click(screen.getByText(`${KEY}.resume`));

    await waitFor(() => expect(mocks.messageError).toHaveBeenCalledWith(`${KEY}.actionFailed`));
  });
});
