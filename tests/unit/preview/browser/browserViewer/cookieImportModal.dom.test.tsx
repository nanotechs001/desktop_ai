/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SWRConfig } from 'swr';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BrowserTabProfile } from '@/common/types/browser';

const mocks = vi.hoisted(() => ({
  listSources: vi.fn(),
  run: vi.fn(),
  assistants: vi.fn(() => Promise.resolve([{ id: 'bare:632f31d2', name: 'Scout', source: 'user' }])),
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    assistants: { list: { invoke: mocks.assistants } },
    browser: { cookieImport: { listSources: { invoke: mocks.listSources }, run: { invoke: mocks.run } } },
  },
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) => (options ? `${key} ${JSON.stringify(options)}` : key),
    i18n: { language: 'en' },
  }),
}));

import CookieImportModal, {
  CookieImportMenu,
  parseDomains,
} from '@/renderer/pages/conversation/Preview/browser/BrowserProfiles/CookieImportModal';

const K = 'preview.browserChrome.cookieImport';
const SOURCES = [
  { browser: 'chrome', profileDir: 'Default', profileName: 'Person 1' },
  { browser: 'chrome', profileDir: 'Profile 1', profileName: 'Work' },
  { browser: 'brave', profileDir: 'Default', profileName: 'Me' },
];

const renderModal = (target: BrowserTabProfile = { kind: 'personal' }, onClose = vi.fn()) =>
  render(
    <SWRConfig value={{ provider: () => new Map() }}>
      <CookieImportModal visible target={target} onClose={onClose} />
    </SWRConfig>
  );

const chooseOption = async (testId: string, label: string): Promise<void> => {
  fireEvent.click(screen.getByTestId(testId).querySelector('.arco-select-view') as Element);
  const option = await waitFor(() => {
    const found = [...document.querySelectorAll('.arco-select-option')].find((el) => el.textContent === label);
    if (!found) throw new Error(`option ${label} not found`);
    return found;
  });
  fireEvent.click(option);
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('CookieImportModal', () => {
  it('modal lists detected browsers and profiles, runs the import and shows "Imported N cookies from M sites"', async () => {
    mocks.listSources.mockResolvedValue({ success: true, data: SOURCES });
    mocks.run.mockResolvedValue({
      success: true,
      data: { imported: 12, sites: 3, skipped: { expired: 2, undecryptable: 1, rejected: 0 } },
    });
    renderModal({ kind: 'agent', agentId: 'bare:632f31d2' });

    // Every detected browser, once; the first browser's profiles.
    expect(await screen.findByText('Chrome')).toBeInTheDocument();
    expect(screen.getByText('Brave')).toBeInTheDocument();
    expect(await screen.findByText(`${K}.into {"profile":"Scout"}`)).toBeInTheDocument();
    await chooseOption('cookie-import-profile', 'Work');
    fireEvent.change(screen.getByPlaceholderText(`${K}.domainsPlaceholder`), {
      target: { value: 'https://GoHighLevel.com/x, elementor.com' },
    });
    fireEvent.click(screen.getByText(`${K}.import`));

    expect(await screen.findByText(`${K}.result {"cookies":12,"sites":3}`)).toBeInTheDocument();
    expect(screen.getByText(`${K}.skipped {"expired":2,"undecryptable":1,"rejected":0}`)).toBeInTheDocument();
    expect(mocks.run).toHaveBeenCalledWith({
      browser: 'chrome',
      profileDir: 'Profile 1',
      target: { kind: 'agent', agentId: 'bare:632f31d2' },
      domains: ['gohighlevel.com', 'elementor.com'],
    });
  });

  it('switching browser picks that browser’s profile and imports every site when no domains are given', async () => {
    mocks.listSources.mockResolvedValue({ success: true, data: SOURCES });
    mocks.run.mockResolvedValue({
      success: true,
      data: { imported: 1, sites: 1, skipped: { expired: 0, undecryptable: 0, rejected: 0 } },
    });
    renderModal();
    fireEvent.click(await screen.findByText('Brave'));
    expect(
      await screen.findByText(`${K}.into {"profile":"preview.browserChrome.profile.personal"}`)
    ).toBeInTheDocument();
    fireEvent.click(screen.getByText(`${K}.import`));
    await waitFor(() =>
      expect(mocks.run).toHaveBeenCalledWith({
        browser: 'brave',
        profileDir: 'Default',
        target: { kind: 'personal' },
        domains: null,
      })
    );
  });

  it('shows why an import failed, e.g. the Keychain was denied', async () => {
    mocks.listSources.mockResolvedValue({ success: true, data: SOURCES });
    mocks.run.mockResolvedValue({ success: false, msg: 'Access to Chrome Safe Storage was denied' });
    renderModal();
    await screen.findByText('Chrome');
    fireEvent.click(screen.getByText(`${K}.import`));
    expect(
      await screen.findByText(`${K}.failed {"reason":"Access to Chrome Safe Storage was denied"}`)
    ).toBeInTheDocument();
  });

  it('says so when no supported browser is found, and offers no import', async () => {
    mocks.listSources.mockResolvedValue({ success: true, data: [] });
    renderModal();
    expect(await screen.findByText(`${K}.none`)).toBeInTheDocument();
    expect(screen.getByText(`${K}.import`).closest('button')).toBeDisabled();
  });

  it('the pane menu opens the modal for the tab’s profile', async () => {
    mocks.listSources.mockResolvedValue({ success: true, data: SOURCES });
    render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <CookieImportMenu profile={{ kind: 'personal' }} />
      </SWRConfig>
    );
    expect(mocks.listSources).not.toHaveBeenCalled();
    fireEvent.click(screen.getByLabelText(`${K}.more`));
    fireEvent.click(await screen.findByText(`${K}.menu`));
    expect(await screen.findByText('Chrome')).toBeInTheDocument();
    expect(mocks.listSources).toHaveBeenCalledTimes(1);
  });
});

describe('parseDomains', () => {
  it('turns a typed list into host names, or null for every site', () => {
    expect(parseDomains('')).toBeNull();
    expect(parseDomains('  , ')).toBeNull();
    expect(parseDomains('https://Example.com/path *.foo.org\n.bar.net, example.com')).toEqual([
      'example.com',
      'foo.org',
      'bar.net',
    ]);
  });
});
