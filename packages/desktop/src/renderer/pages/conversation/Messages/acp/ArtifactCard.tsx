/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, Message, Tag } from '@arco-design/web-react';
import { Browser, Copy } from '@icon-park/react';
import React, { useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import useSWR from 'swr';
import { ipcBridge } from '@/common';
import { useOptionalPreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { copyText } from '@/renderer/utils/ui/clipboard';

const ARTIFACT_PATH = /^\/a\/[A-Za-z0-9_-]{22}(\/v\/[1-9][0-9]*)?$/;
const LOCAL_ORIGIN = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/;

/**
 * The link to open for a local artifact url (`http://127.0.0.1:<port>/a/<id>[/v/<n>]`), else null. The link is built
 * on `origin`, the artifact server of this launch (or, in the WebUI, its artifact-view route), so a card from an
 * earlier launch (another port) still opens.
 * An unversioned url gets `/v/<version>` so a card for an old version keeps showing that version.
 */
/** The WebUI reaches artifacts through web-host's gated route on its own origin (no IPC in a plain browser). */
const webuiArtifactOrigin = (): string => `${window.location.origin}/api/artifact-view`;

const toArtifactHref = (url: string, version: number, origin: string | null | undefined): string | null => {
  const usable = isElectronDesktop() ? LOCAL_ORIGIN.test(origin ?? '') : origin === webuiArtifactOrigin();
  if (!origin || !usable) return null;
  try {
    const parsed = new URL(url);
    const local = parsed.protocol === 'http:' && parsed.hostname === '127.0.0.1' && parsed.port !== '';
    if (!local || parsed.username || parsed.password || !ARTIFACT_PATH.test(parsed.pathname)) return null;
    return parsed.pathname.includes('/v/') ? `${origin}${parsed.pathname}` : `${origin}${parsed.pathname}/v/${version}`;
  } catch {
    return null;
  }
};

/** This launch's artifact server origin, null while artifacts are unavailable. Shared by every card. */
const useArtifactOrigin = (): string | null | undefined => {
  const desktop = isElectronDesktop();
  const { data } = useSWR(desktop ? 'artifacts.origin' : null, async () => {
    const reply = await ipcBridge.artifacts.origin.invoke();
    return reply.success && reply.data ? reply.data : null;
  });
  return desktop ? data : webuiArtifactOrigin();
};

export type ArtifactCardProps = { title?: string; kind?: string; version: number; url: string };

/**
 * Chat card for an artifact an agent created or updated. Open and Copy link appear only for a local artifact
 * link, so text from a tool result can never turn into a button for another address.
 */
const ArtifactCard: React.FC<ArtifactCardProps> = ({ title, kind, version, url }) => {
  const { t } = useTranslation();
  const preview = useOptionalPreviewContext();
  const [messageApi, messageContext] = Message.useMessage();
  const href = toArtifactHref(url, version, useArtifactOrigin());
  const desktop = isElectronDesktop();
  // The WebUI has no <webview>: the phone's browser opens the page in a new tab.
  const handleOpen = useCallback(() => {
    if (!href) return;
    if (desktop) preview?.openBrowserTab(href);
    else window.open(href, '_blank', 'noopener');
  }, [desktop, href, preview]);

  const handleCopy = useCallback(async () => {
    if (!href) return;
    try {
      await copyText(href);
      messageApi.success(t('messages.artifactCard.copied'));
    } catch (error) {
      console.error('[ArtifactCard] Failed to copy the link:', error);
      messageApi.error(t('messages.artifactCard.copyFailed'));
    }
  }, [href, messageApi, t]);

  return (
    <div className='flex flex-col gap-8px rounded-8px border bg-1 p-12px max-w-420px'>
      {messageContext}
      <div className='flex items-center gap-8px min-w-0'>
        <span className='font-medium text-14px text-t-primary truncate'>
          {title || t('messages.artifactCard.title')}
        </span>
        {kind && <Tag size='small'>{kind}</Tag>}
        <span className='text-12px text-t-secondary' aria-hidden>
          ·
        </span>
        <span className='text-12px text-t-secondary'>{`v${version}`}</span>
      </div>
      {href && (
        <div className='flex gap-8px'>
          {(preview || !desktop) && (
            <Button size='mini' type='primary' icon={<Browser theme='outline' size='14' />} onClick={handleOpen}>
              {t('messages.artifactCard.open')}
            </Button>
          )}
          <Button size='mini' icon={<Copy theme='outline' size='14' />} onClick={() => void handleCopy()}>
            {t('messages.artifactCard.copyLink')}
          </Button>
        </div>
      )}
    </div>
  );
};

export default ArtifactCard;
