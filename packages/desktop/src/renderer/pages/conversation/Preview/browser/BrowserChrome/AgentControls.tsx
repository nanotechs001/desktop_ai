/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Button, Message, Popover, Tag } from '@arco-design/web-react';
import { History, Robot } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';
import type { AgentActionEvent, TabOwnership } from '@/common/types/browser';
import { profilePresentation } from '../BrowserProfiles/ProfileBadge';
import { useProfileAgents } from '../BrowserProfiles/useBrowserProfiles';

const KEY = 'preview.browserChrome.agent';

const toggleShare = (webContentsId: number, on: boolean, onFailed: () => void): void => {
  // Main resolves { success: false } rather than rejecting, so both outcomes end in the same message.
  void ipcBridge.agentBrowser.share
    .invoke({ webContentsId, on })
    .then((res) => res.success)
    .catch(() => false)
    .then((ok) => {
      if (!ok) onFailed();
    });
};

const ActionFeed: React.FC<{ actions: AgentActionEvent[] }> = ({ actions }) => {
  const { t } = useTranslation();
  return (
    <div className='flex max-h-320px w-300px flex-col gap-4px overflow-y-auto'>
      {/* Newest first. The agent is always shown by its neutral name, never by the client's own label. */}
      {actions.toReversed().map((action, index) => (
        // Rows are stateless text and the list only grows at one end, so the position is a stable enough key.
        <div key={index} className='flex items-baseline gap-6px text-12px'>
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
  const profile = ownership?.profile;
  const agents = useProfileAgents(profile?.kind === 'agent');
  if (!ownership) return null;

  const shared = ownership.sharedWith === 'all';
  // Sharing a tab in an Agent's profile reaches only that Agent (ruling N-16), so the button names it.
  const agentName = profile?.kind === 'agent' ? profilePresentation(profile, agents, t).name : null;
  const shareLabel = agentName ? t(`${KEY}.shareWith`, { name: agentName }) : t(`${KEY}.share`);
  return (
    <>
      {ownership.owner === 'user' ? (
        <Button
          size='mini'
          type={shared ? 'primary' : 'secondary'}
          aria-pressed={shared}
          title={shared && agentName ? t(`${KEY}.sharedWith`, { name: agentName }) : undefined}
          icon={<Robot theme='outline' size='14' />}
          onClick={() => toggleShare(webContentsId, !shared, () => Message.error(t(`${KEY}.actionFailed`)))}
        >
          {shared ? t(`${KEY}.stopSharing`) : shareLabel}
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
