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
  CookieImportResult,
  CookieImportSource,
  CookieSourceBrowser,
} from '@/common/types/browser';
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

/**
 * The host names in a typed site list ("https://GoHighLevel.com/x, *.elementor.com"), lowercased and without
 * scheme, path or leading `*.`/`.`; null when it names none, meaning every site.
 */
export function parseDomains(text: string): string[] | null {
  const domains = text
    .split(/[\s,]+/)
    .map((entry) =>
      entry
        .toLowerCase()
        .replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
        .replace(/[/?#].*$/, '')
        .replace(/^(\*?\.)+/, '')
    )
    .filter((domain) => domain !== '');
  return domains.length === 0 ? null : [...new Set(domains)];
}

type Outcome = { kind: 'done'; result: CookieImportResult } | { kind: 'failed'; reason: string };

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
  const [sources, setSources] = useState<CookieImportSource[] | null>(null);
  const [browser, setBrowser] = useState<CookieSourceBrowser | null>(null);
  const [profileDir, setProfileDir] = useState<string | null>(null);
  const [sitesText, setSitesText] = useState('');
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
        if (!reply.success) throw new Error(reply.msg ?? 'no sources');
        return reply.data ?? [];
      })
      .catch((error: unknown): CookieImportSource[] => {
        console.warn('[CookieImport] could not list the browsers:', error);
        return [];
      })
      .then((found) => {
        if (!live) return;
        setSources(found);
        setBrowser(found[0]?.browser ?? null);
        setProfileDir(found[0]?.profileDir ?? null);
      });
    return () => {
      live = false;
    };
  }, [visible]);

  const browsers = [...new Set((sources ?? []).map((source) => source.browser))];
  const profiles = (sources ?? []).filter((source) => source.browser === browser);

  const chooseBrowser = (next: CookieSourceBrowser): void => {
    setBrowser(next);
    setProfileDir((sources ?? []).find((source) => source.browser === next)?.profileDir ?? null);
  };

  const handleImport = async (): Promise<void> => {
    if (browser === null || profileDir === null) return;
    setRunning(true);
    setOutcome(null);
    const reply = await ipcBridge.browser.cookieImport.run
      .invoke({ browser, profileDir, target, domains: parseDomains(sitesText) })
      .catch((error: unknown) => ({ success: false, msg: error instanceof Error ? error.message : String(error) }));
    setRunning(false);
    if (reply.success && 'data' in reply && reply.data) setOutcome({ kind: 'done', result: reply.data });
    else setOutcome({ kind: 'failed', reason: reply.msg ?? t('common.error') });
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
        {sources?.length === 0 && <Alert type='info' content={t(`${K}.none`)} />}
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
              <Input value={sitesText} onChange={setSitesText} placeholder={t(`${K}.domainsPlaceholder`)} />
            </div>
            <div className='text-12px text-t-tertiary'>{t(`${K}.keychainHint`)}</div>
          </>
        )}
        {outcome?.kind === 'done' && (
          <Alert
            type='success'
            content={
              <div className='flex flex-col gap-2px'>
                <span>{t(`${K}.result`, { cookies: outcome.result.imported, sites: outcome.result.sites })}</span>
                <span className='text-12px text-t-secondary'>{t(`${K}.skipped`, outcome.result.skipped)}</span>
              </div>
            }
          />
        )}
        {outcome?.kind === 'failed' && <Alert type='error' content={t(`${K}.failed`, { reason: outcome.reason })} />}
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
