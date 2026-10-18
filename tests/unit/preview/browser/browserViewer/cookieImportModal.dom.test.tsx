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
/** The mocked `t`: the key, then its options as JSON. */
const tr = (key: string, options?: Record<string, unknown>): string =>
  options ? `${key} ${JSON.stringify(options)}` : key;
const platform = vi.hoisted(() => ({ mac: true }));
vi.mock('@/renderer/utils/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/renderer/utils/platform')>()),
  isMacOS: () => platform.mac,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: tr, i18n: { language: 'en' } }) }));

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
      data: { ok: true, imported: 12, sites: 3, skipped: { expired: 2, undecryptable: 1, rejected: 0 } },
    });
    renderModal({ kind: 'agent', agentId: 'bare:632f31d2' });

    // Every detected browser, once; the first browser's profiles.
    expect(await screen.findByText('Chrome')).toBeInTheDocument();
    expect(screen.getByText('Brave')).toBeInTheDocument();
    expect(await screen.findByText(`${K}.into {"profile":"Scout"}`)).toBeInTheDocument();
    await chooseOption('cookie-import-profile', 'Work');
    fireEvent.change(screen.getByPlaceholderText(`${K}.domainsPlaceholder`), {
      target: { value: 'https://GoHighLevel.com:8443/x, elementor.com bücher.de' },
    });
    fireEvent.click(screen.getByText(`${K}.import`));

    // i18next plurals: `count` picks result_one/_other, and the site count is its own plural.
    const sitesText = tr(`${K}.sitesCount`, { count: 3 });
    expect(await screen.findByText(tr(`${K}.result`, { count: 12, sitesText }))).toBeInTheDocument();
    expect(screen.getByText(`${K}.skipped {"expired":2,"undecryptable":1,"rejected":0}`)).toBeInTheDocument();
    expect(mocks.run).toHaveBeenCalledWith({
      browser: 'chrome',
      profileDir: 'Profile 1',
      target: { kind: 'agent', agentId: 'bare:632f31d2' },
      domains: ['gohighlevel.com', 'elementor.com', 'xn--bcher-kva.de'],
    });
  });

  it('marks sites that are not host names on the field and does not import', async () => {
    mocks.listSources.mockResolvedValue({ success: true, data: SOURCES });
    renderModal();
    await screen.findByText('Chrome');
    fireEvent.change(screen.getByPlaceholderText(`${K}.domainsPlaceholder`), {
      target: { value: 'example.com, not_valid!, ok.org' },
    });
    fireEvent.click(screen.getByText(`${K}.import`));
    expect(await screen.findByText(tr(`${K}.invalidSites`, { sites: 'not_valid!' }))).toBeInTheDocument();
    expect(mocks.run).not.toHaveBeenCalled();
  });

  it('clears an earlier result when the next import stops on invalid sites', async () => {
    mocks.listSources.mockResolvedValue({ success: true, data: SOURCES });
    mocks.run.mockResolvedValue({ success: true, data: { ok: false, code: 'busy', browser: 'chrome' } });
    renderModal();
    await screen.findByText('Chrome');
    fireEvent.click(screen.getByText(`${K}.import`));
    const earlier = tr(`${K}.errors.busy`, { browser: 'Chrome' });
    expect(await screen.findByText(earlier)).toBeInTheDocument();
    fireEvent.change(screen.getByPlaceholderText(`${K}.domainsPlaceholder`), { target: { value: 'not_valid!' } });
    fireEvent.click(screen.getByText(`${K}.import`));
    expect(await screen.findByText(tr(`${K}.invalidSites`, { sites: 'not_valid!' }))).toBeInTheDocument();
    expect(screen.queryByText(earlier)).toBeNull();
    expect(mocks.run).toHaveBeenCalledTimes(1);
  });

  it('switching browser picks that browser’s profile and imports every site when no domains are given', async () => {
    mocks.listSources.mockResolvedValue({ success: true, data: SOURCES });
    mocks.run.mockResolvedValue({
      success: true,
      data: { ok: true, imported: 1, sites: 1, skipped: { expired: 0, undecryptable: 0, rejected: 0 } },
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

  it('words each failure code in the renderer, naming the browser', async () => {
    mocks.listSources.mockResolvedValue({ success: true, data: SOURCES });
    renderModal();
    await screen.findByText('Chrome');
    for (const code of [
      'keychain_denied',
      'keychain_missing',
      'keychain_timeout',
      'source_not_found',
      'read_failed',
      'busy',
    ]) {
      mocks.run.mockResolvedValueOnce({ success: true, data: { ok: false, code, browser: 'chrome' } });
      fireEvent.click(screen.getByText(`${K}.import`));
      expect(await screen.findByText(tr(`${K}.errors.${code}`, { browser: 'Chrome' }))).toBeInTheDocument();
    }
    // A refused request (or a broken bridge) never shows main's text.
    mocks.run.mockResolvedValueOnce({ success: false, msg: 'Invalid arguments' });
    fireEvent.click(screen.getByText(`${K}.import`));
    expect(await screen.findByText(tr(`${K}.errors.unknown`, { browser: 'Chrome' }))).toBeInTheDocument();
    expect(screen.queryByText(/Invalid arguments/)).toBeNull();
  });

  it('shows that looking for browsers failed, rather than that none was found', async () => {
    mocks.listSources.mockResolvedValue({ success: false });
    renderModal();
    expect(await screen.findByText(`${K}.errors.list_failed`)).toBeInTheDocument();
    expect(screen.queryByText(`${K}.none`)).toBeNull();
    expect(screen.getByText(`${K}.import`).closest('button')).toBeDisabled();
  });

  it('says so when no supported browser is found, and offers no import', async () => {
    mocks.listSources.mockResolvedValue({ success: true, data: [] });
    renderModal();
    expect(await screen.findByText(`${K}.none`)).toBeInTheDocument();
    expect(screen.getByText(`${K}.import`).closest('button')).toBeDisabled();
  });

  it('the pane menu opens the modal for the tab’s profile', async () => {
    platform.mac = true;
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

  it('is not offered off macOS (the import reads the macOS Keychain)', () => {
    platform.mac = false;
    const { container } = render(
      <SWRConfig value={{ provider: () => new Map() }}>
        <CookieImportMenu profile={{ kind: 'personal' }} />
      </SWRConfig>
    );
    expect(container).toBeEmptyDOMElement();
    expect(screen.queryByLabelText(`${K}.more`)).toBeNull();
    platform.mac = true;
  });
});

describe('parseDomains', () => {
  it('turns a typed list into host names, or null for every site', () => {
    expect(parseDomains('')).toEqual({ domains: null, invalid: [] });
    expect(parseDomains('  , ')).toEqual({ domains: null, invalid: [] });
    expect(parseDomains('https://Example.com/path *.foo.org\n.bar.net, example.com, localhost:3000')).toEqual({
      domains: ['example.com', 'foo.org', 'bar.net', 'localhost'],
      invalid: [],
    });
  });

  it('IDN-encodes names, drops ports, and lists the entries that are not host names', () => {
    expect(parseDomains('Bücher.de:8080 münchen.de, a_b.com, http://, -bad-.com')).toEqual({
      domains: ['xn--bcher-kva.de', 'xn--mnchen-3ya.de'],
      invalid: ['a_b.com', 'http://', '-bad-.com'],
    });
  });
});
