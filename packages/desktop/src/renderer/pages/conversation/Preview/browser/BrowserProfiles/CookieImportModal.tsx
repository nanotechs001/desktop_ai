/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Alert, Button, Dropdown, Input, Menu, Modal, Radio, Select, Spin } from '@arco-design/web-react';
import { More } from '@icon-park/react';
import React, { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type {
  BrowserTabProfile,
  CookieImportErrorCode,
  CookieImportResult,
  CookieImportSource,
  CookieSourceBrowser,
} from '@/common/types/browser';
import { HOST_NAME_RE } from '@/common/utils/urlValidation';
import { iconColors } from '@/renderer/styles/colors';
import { profilePresentation } from './ProfileBadge';
import { useProfileAgents } from './useBrowserProfiles';

const K = 'preview.browserChrome.cookieImport';

/** Product names, the same in every language. */
const BROWSER_LABELS: Record<CookieSourceBrowser, string> = {
  chrome: 'Chrome',
  brave: 'Brave',
  edge: 'Edge',
  arc: 'Arc',
  vivaldi: 'Vivaldi',
};

/** One typed site as an ASCII host name: no scheme, port, path or leading `*.`/`.`, IDN punycode-encoded. */
const toHostName = (entry: string): string | null => {
  const bare = entry.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '').replace(/^(\*?\.)+/, '');
  try {
    // The URL parser lowercases, drops port and path, and IDN-encodes the host.
    const host = new URL(`http://${bare}`).hostname.replace(/\.$/, '');
    return HOST_NAME_RE.test(host) ? host : null;
  } catch {
    return null;
  }
};

/**
 * The host names in a typed site list ("https://GoHighLevel.com:443/x, *.elementor.com, bücher.de"), and the
 * entries that are not host names. `domains` is null when the list names none, meaning every site.
 */
export function parseDomains(text: string): { domains: string[] | null; invalid: string[] } {
  const entries = text.split(/[\s,]+/).filter((entry) => entry !== '');
  const hosts = entries.map(toHostName);
  const domains = [...new Set(hosts.filter((host): host is string => host !== null))];
  const invalid = entries.filter((_, index) => hosts[index] === null);
  return { domains: domains.length === 0 ? null : domains, invalid };
}

type Outcome =
  | { kind: 'done'; result: CookieImportResult }
  | { kind: 'failed'; code: CookieImportErrorCode | 'unknown'; browser: CookieSourceBrowser };

type CookieImportModalProps = {
  visible: boolean;
  /** The browser profile the cookies go into. */
  target: BrowserTabProfile;
  onClose: () => void;
};

/**
 * Imports cookies from a Chromium browser on this Mac into `target`: pick the browser, then its profile, then
 * optionally some sites. macOS asks for the browser's Safe Storage key; the result is counts only.
 */
const CookieImportModal: React.FC<CookieImportModalProps> = ({ visible, target, onClose }) => {
  const { t } = useTranslation();
  const agents = useProfileAgents(target.kind === 'agent');
  /** null while looking; 'failed' when main could not look. */
  const [sources, setSources] = useState<CookieImportSource[] | 'failed' | null>(null);
  const [browser, setBrowser] = useState<CookieSourceBrowser | null>(null);
  const [profileDir, setProfileDir] = useState<string | null>(null);
  const [sitesText, setSitesText] = useState('');
  const [invalidSites, setInvalidSites] = useState<string[]>([]);
  const [running, setRunning] = useState(false);
  const [outcome, setOutcome] = useState<Outcome | null>(null);

  useEffect(() => {
    if (!visible) return;
    let live = true;
    setSources(null);
    setOutcome(null);
    ipcBridge.browser.cookieImport.listSources
      .invoke()
      .then((reply) => {
        if (!reply.success) throw new Error('main could not look for browsers');
        return reply.data ?? [];
      })
      .catch((error: unknown): 'failed' => {
        console.warn('[CookieImport] could not list the browsers:', error);
        return 'failed';
      })
      .then((found) => {
        if (!live) return;
        setSources(found);
        const first = found === 'failed' ? undefined : found[0];
        setBrowser(first?.browser ?? null);
        setProfileDir(first?.profileDir ?? null);
      });
    return () => {
      live = false;
    };
  }, [visible]);

  const found = Array.isArray(sources) ? sources : [];
  const browsers = [...new Set(found.map((source) => source.browser))];
  const profiles = found.filter((source) => source.browser === browser);

  const chooseBrowser = (next: CookieSourceBrowser): void => {
    setBrowser(next);
    setProfileDir(found.find((source) => source.browser === next)?.profileDir ?? null);
  };

  const handleImport = async (): Promise<void> => {
    if (browser === null || profileDir === null) return;
    const { domains, invalid } = parseDomains(sitesText);
    setInvalidSites(invalid);
    setOutcome(null);
    if (invalid.length > 0) return;
    setRunning(true);
    const reply = await ipcBridge.browser.cookieImport.run
      .invoke({ browser, profileDir, target, domains })
      .catch((error: unknown): { success: false; data?: undefined } => {
        console.warn('[CookieImport] the import request failed:', error);
        return { success: false };
      });
    setRunning(false);
    const data = reply.success ? reply.data : undefined;
    if (data?.ok === true) setOutcome({ kind: 'done', result: data });
    else if (data?.ok === false) setOutcome({ kind: 'failed', code: data.code, browser: data.browser });
    else setOutcome({ kind: 'failed', code: 'unknown', browser });
  };

  const intoName = profilePresentation(target, agents, t).name;

  return (
    <Modal
      visible={visible}
      title={t(`${K}.title`)}
      okText={t(`${K}.import`)}
      cancelText={t('common.close')}
      okButtonProps={{ disabled: profileDir === null, loading: running }}
      onOk={() => void handleImport()}
      onCancel={onClose}
      unmountOnExit
    >
      <div className='flex flex-col gap-12px'>
        <div className='text-12px text-t-secondary'>{t(`${K}.into`, { profile: intoName })}</div>
        {sources === null && <Spin />}
        {sources === 'failed' && <Alert type='error' content={t(`${K}.errors.list_failed`)} />}
        {Array.isArray(sources) && sources.length === 0 && <Alert type='info' content={t(`${K}.none`)} />}
        {browsers.length > 0 && (
          <>
            <div className='flex flex-col gap-4px'>
              <span className='text-13px text-t-primary'>{t(`${K}.browser`)}</span>
              <Radio.Group type='button' value={browser ?? undefined} onChange={chooseBrowser}>
                {browsers.map((id) => (
                  <Radio key={id} value={id}>
                    {BROWSER_LABELS[id]}
                  </Radio>
                ))}
              </Radio.Group>
            </div>
            <div className='flex flex-col gap-4px'>
              <span className='text-13px text-t-primary'>{t(`${K}.profile`)}</span>
              <Select
                data-testid='cookie-import-profile'
                value={profileDir ?? undefined}
                onChange={(value: string) => setProfileDir(value)}
              >
                {profiles.map((source) => (
                  <Select.Option key={source.profileDir} value={source.profileDir}>
                    {source.profileName}
                  </Select.Option>
                ))}
              </Select>
            </div>
            <div className='flex flex-col gap-4px'>
              <span className='text-13px text-t-primary'>{t(`${K}.sites`)}</span>
              <Input
                value={sitesText}
                onChange={(value) => {
                  setSitesText(value);
                  setInvalidSites([]);
                }}
                status={invalidSites.length > 0 ? 'error' : undefined}
                placeholder={t(`${K}.domainsPlaceholder`)}
              />
              {invalidSites.length > 0 && (
                <span className='text-12px text-danger'>
                  {t(`${K}.invalidSites`, { sites: invalidSites.join(', ') })}
                </span>
              )}
            </div>
            <div className='text-12px text-t-tertiary'>{t(`${K}.keychainHint`)}</div>
          </>
        )}
        {outcome?.kind === 'done' && (
          <Alert
            type='success'
            content={
              <div className='flex flex-col gap-2px'>
                <span>
                  {t(`${K}.result`, {
                    count: outcome.result.imported,
                    sitesText: t(`${K}.sitesCount`, { count: outcome.result.sites }),
                  })}
                </span>
                <span className='text-12px text-t-secondary'>{t(`${K}.skipped`, outcome.result.skipped)}</span>
              </div>
            }
          />
        )}
        {outcome?.kind === 'failed' && (
          <Alert
            type='error'
            content={t(`${K}.errors.${outcome.code}`, { browser: BROWSER_LABELS[outcome.browser] })}
          />
        )}
      </div>
    </Modal>
  );
};

/** The browser pane's menu for a tab: "Import from browser…" into that tab's profile. */
export const CookieImportMenu: React.FC<{ profile: BrowserTabProfile }> = ({ profile }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const label = t(`${K}.more`);
  return (
    <>
      <Dropdown
        trigger='click'
        position='br'
        droplist={
          <Menu onClickMenuItem={() => setOpen(true)}>
            <Menu.Item key='import'>{t(`${K}.menu`)}</Menu.Item>
          </Menu>
        }
      >
        <Button
          type='text'
          size='mini'
          aria-label={label}
          title={label}
          icon={<More theme='outline' size='16' fill={iconColors.secondary} />}
        />
      </Dropdown>
      <CookieImportModal visible={open} target={profile} onClose={() => setOpen(false)} />
    </>
  );
};

export default CookieImportModal;
