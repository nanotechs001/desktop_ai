/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ resume: vi.fn(() => Promise.resolve({ success: true })) }));

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
});
