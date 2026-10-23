/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useMemo } from 'react';
import { Button, Empty, Spin, Tag } from '@arco-design/web-react';
import { FileCodeOne } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import useSWR from 'swr';

import { ipcBridge } from '@/common';
import type { ArtifactMeta } from '@/common/types/agent/artifacts';
import { useConversationHistoryContext } from '@/renderer/hooks/context/ConversationHistoryContext';
import { usePreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { isElectronDesktop } from '@/renderer/utils/platform';

type ArtifactList = { artifacts: ArtifactMeta[]; origin?: string };

const loadArtifacts = async (): Promise<ArtifactList> => {
  const [listed, origin] = await Promise.all([ipcBridge.artifacts.list.invoke(), ipcBridge.artifacts.origin.invoke()]);
  if (!listed.success || !listed.data) throw new Error(listed.msg ?? 'Artifacts are unavailable');
  return { artifacts: listed.data, origin: origin.success ? origin.data : undefined };
};

/** Every artifact Pixebot created (pages, documents, diagrams), last updated first; one opens in its chat's browser. */
const ArtifactsPage: React.FC = () => {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const { revealBrowserFor } = usePreviewContext();
  const { conversations } = useConversationHistoryContext();
  // The artifact server and its list live in the desktop app; a desktop-only call is never answered in the WebUI.
  const desktop = isElectronDesktop();
  const { data, error, isLoading, mutate } = useSWR(desktop ? 'artifacts.list' : null, loadArtifacts);
  const chatNames = useMemo(
    () => new Map(conversations.map((conversation) => [conversation.id, conversation.name])),
    [conversations]
  );

  const openArtifact = (artifact: ArtifactMeta) => {
    if (!data?.origin) return;
    revealBrowserFor(artifact.conversationId, `${data.origin}/a/${artifact.id}`);
    void navigate(`/conversation/${artifact.conversationId}`);
  };
  const formatTime = (time: number) =>
    new Date(time).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });

  const renderPlaceholder = () => {
    if (!desktop) return <Empty description={t('conversation.artifacts.desktopOnly')} />;
    if (isLoading) return <Spin />;
    if (error) {
      return (
        <Empty
          description={
            <div className='flex flex-col items-center gap-8px'>
              <span>{t('conversation.artifacts.loadFailed')}</span>
              <Button size='small' onClick={() => void mutate()}>
                {t('conversation.artifacts.retry')}
              </Button>
            </div>
          }
        />
      );
    }
    if (!data || data.artifacts.length === 0) return <Empty description={t('conversation.artifacts.empty')} />;
    return null;
  };
  const placeholder = renderPlaceholder();

  return (
    <div className='w-full h-full min-h-0 box-border bg-1 flex flex-col overflow-hidden'>
      <div className='shrink-0 px-16px pt-14px pb-14px md:px-40px md:pt-32px md:pb-16px'>
        <div className='mx-auto w-full max-w-800px box-border'>
          <h1 className='m-0 text-20px font-semibold text-t-primary'>{t('conversation.artifacts.title')}</h1>
          <p className='m-0 mt-4px text-13px text-t-secondary'>{t('conversation.artifacts.description')}</p>
        </div>
      </div>
      <div className='flex-1 min-h-0 overflow-y-auto px-16px pb-24px md:px-40px'>
        <div className='mx-auto w-full max-w-800px box-border flex flex-col gap-4px'>
          {placeholder ? (
            <div className='flex min-h-220px items-center justify-center rounded-16px border border-dashed border-arco-2 bg-fill-1'>
              {placeholder}
            </div>
          ) : (
            data?.artifacts.map((artifact) => (
              <div
                key={artifact.id}
                data-testid='artifact-row'
                role='button'
                tabIndex={0}
                className='flex cursor-pointer items-center gap-12px rounded-12px px-12px py-8px transition-colors hover:bg-fill-2'
                onClick={() => openArtifact(artifact)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    openArtifact(artifact);
                  }
                }}
              >
                <FileCodeOne theme='outline' size='18' fill='currentColor' className='shrink-0 text-t-secondary' />
                <div className='min-w-0 flex-1'>
                  <div data-name className='truncate text-14px font-[500] text-t-primary'>
                    {artifact.title}
                  </div>
                  <div className='truncate text-12px text-t-tertiary'>{chatNames.get(artifact.conversationId)}</div>
                </div>
                <Tag size='small'>{artifact.kind}</Tag>
                <span className='shrink-0 text-12px text-t-tertiary'>{formatTime(artifact.updatedAt)}</span>
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
};

export default ArtifactsPage;
