/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Button, Popover, Tag } from '@arco-design/web-react';
import { History, Robot } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { AgentActionEvent, TabOwnership } from '@/common/types/browser';

const KEY = 'preview.browserChrome.agent';

const toggleShare = (webContentsId: number, on: boolean): void => {
  // A failed toggle leaves ownership unchanged, so the button simply keeps showing the real state.
  void ipcBridge.agentBrowser.share.invoke({ webContentsId, on }).catch((error: unknown) => {
    console.warn('[BrowserViewer] could not change sharing:', error);
  });
};

const ActionFeed: React.FC<{ actions: AgentActionEvent[] }> = ({ actions }) => {
  const { t } = useTranslation();
  return (
    <div className='flex max-h-320px w-300px flex-col gap-4px overflow-y-auto'>
      {/* Newest first. The agent is always shown by its neutral name, never by the client's own label. */}
      {actions.toReversed().map((action) => (
        <div key={`${action.at}-${action.op}-${action.label}`} className='flex items-baseline gap-6px text-12px'>
          <span className='flex-shrink-0 text-t-secondary'>{t(`${KEY}.badge`)}</span>
          <span className='flex-shrink-0 text-t-primary'>{action.op}</span>
          <span className='truncate text-t-secondary' title={action.label}>
            {action.label}
          </span>
        </div>
      ))}
    </div>
  );
};

export type AgentControlsProps = {
  webContentsId: number;
  ownership: TabOwnership | null;
  actions: AgentActionEvent[];
};

/** Nav bar controls: the Agent badge on agent-owned tabs, "Share with agent" on the user's, and the action feed. */
const AgentControls: React.FC<AgentControlsProps> = ({ webContentsId, ownership, actions }) => {
  const { t } = useTranslation();
  if (!ownership) return null;

  const shared = ownership.sharedWith === 'all';
  return (
    <>
      {ownership.owner === 'user' ? (
        <Button
          size='mini'
          type={shared ? 'primary' : 'secondary'}
          aria-pressed={shared}
          icon={<Robot theme='outline' size='14' />}
          onClick={() => toggleShare(webContentsId, !shared)}
        >
          {t(`${KEY}.${shared ? 'stopSharing' : 'share'}`)}
        </Button>
      ) : (
        <Tag icon={<Robot theme='outline' size='14' />}>{t(`${KEY}.badge`)}</Tag>
      )}
      {actions.length > 0 && (
        <Popover trigger='click' position='br' content={<ActionFeed actions={actions} />}>
          <Button
            type='text'
            size='mini'
            aria-label={t(`${KEY}.actions`)}
            icon={<History theme='outline' size='16' />}
          />
        </Popover>
      )}
    </>
  );
};

export default AgentControls;
