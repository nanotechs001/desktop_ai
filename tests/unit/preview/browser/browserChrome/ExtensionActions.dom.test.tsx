/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ openBrowserTab: vi.fn() }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => ({ openBrowserTab: mocks.openBrowserTab }),
}));

import ExtensionActions from '@/renderer/pages/conversation/Preview/browser/BrowserChrome/ExtensionActions';

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ExtensionActions', () => {
  it('renders <browser-action-list partition="persist:aionui-browser" alignment="bottom right">', () => {
    const { container } = render(<ExtensionActions partition='persist:aionui-browser' />);

    const list = container.querySelector('browser-action-list');
    expect(list).not.toBeNull();
    expect(list?.getAttribute('partition')).toBe('persist:aionui-browser');
    expect(list?.getAttribute('alignment')).toBe('bottom right');
  });

  // BugHerd sets its "project found" popup per tab (chrome.action.setPopup with a tabId); a list left on the library's
  // last known active tab opened its default "No Project for this URL" popup instead.
  it("binds the action list to its own tab, so an extension's per-tab popup and icon are the ones shown", () => {
    const { container } = render(<ExtensionActions partition='persist:aionui-browser' tabWebContentsId={42} />);
    expect(container.querySelector('browser-action-list')?.getAttribute('tab')).toBe('42');
  });

  it('leaves the tab unset until the tab has a webContents id', () => {
    const { container } = render(<ExtensionActions partition='persist:aionui-browser' tabWebContentsId={null} />);
    expect(container.querySelector('browser-action-list')?.hasAttribute('tab')).toBe(false);
  });

  it('the "Get extensions" button opens https://chromewebstore.google.com/ in a new browser tab', () => {
    render(<ExtensionActions partition='persist:aionui-browser' />);

    fireEvent.click(screen.getByRole('button', { name: 'preview.browserChrome.extensions.get' }));

    expect(mocks.openBrowserTab).toHaveBeenCalledWith('https://chromewebstore.google.com/', undefined);
  });

  it("an Agent tab lists that profile's extensions and opens the Web Store in the same profile", () => {
    const profile = { kind: 'agent', agentId: 'bare:1' } as const;
    const { container } = render(<ExtensionActions partition='persist:aionui-agent-abc' profile={profile} />);

    expect(container.querySelector('browser-action-list')?.getAttribute('partition')).toBe('persist:aionui-agent-abc');
    fireEvent.click(screen.getByRole('button', { name: 'preview.browserChrome.extensions.get' }));
    expect(mocks.openBrowserTab).toHaveBeenCalledWith('https://chromewebstore.google.com/', profile);
  });
});
