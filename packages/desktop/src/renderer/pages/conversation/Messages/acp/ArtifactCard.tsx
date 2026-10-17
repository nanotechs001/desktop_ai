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
import { copyText } from '@/renderer/utils/ui/clipboard';

const ARTIFACT_PATH = /^\/a\/[A-Za-z0-9_-]{22}(\/v\/[1-9][0-9]*)?$/;
const LOCAL_ORIGIN = /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/;

/**
 * The link to open for a local artifact url (`http://127.0.0.1:<port>/a/<id>[/v/<n>]`), else null. The link is built
 * on `origin`, the artifact server of this launch, so a card from an earlier launch (another port) still opens.
 * An unversioned url gets `/v/<version>` so a card for an old version keeps showing that version.
 */
const toArtifactHref = (url: string, version: number, origin: string | null | undefined): string | null => {
  if (!origin || !LOCAL_ORIGIN.test(origin)) return null;
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
const useArtifactOrigin = (): string | null | undefined =>
  useSWR('artifacts.origin', async () => {
    const reply = await ipcBridge.artifacts.origin.invoke();
    return reply.success && reply.data ? reply.data : null;
  }).data;

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
          {preview && (
            <Button
              size='mini'
              type='primary'
              icon={<Browser theme='outline' size='14' />}
              onClick={() => preview.openBrowserTab(href)}
            >
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
