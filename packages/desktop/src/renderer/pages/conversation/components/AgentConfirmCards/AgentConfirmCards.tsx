/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Card } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { isElectronDesktop } from '@/renderer/utils/platform';
import ConfirmBody, { CONFIRM_KEY } from './ConfirmBody';
import { replyOverIpc, useIpcConfirms, usePolledConfirms } from './useAgentConfirms';

/**
 * The browser's risky-action asks for this chat, drawn in the chat (main window, robot popup, phone) next to the
 * browser pane's own prompt. The first answer anywhere wins; a card goes away once its ask is settled anywhere.
 * The desktop listens over IPC; the WebUI has no IPC, so it polls web-host and answers with a POST.
 */
const AgentConfirmCards: React.FC<{ conversationId: string }> = ({ conversationId }) => {
  const { t } = useTranslation();
  const desktop = isElectronDesktop();
  const all = useIpcConfirms(desktop);
  const polled = usePolledConfirms(desktop ? null : conversationId);
  const asks = desktop ? all.filter((ask) => ask.conversationId === conversationId) : polled.asks;
  const answer = desktop ? replyOverIpc : polled.answer;

  if (asks.length === 0) return null;
  return (
    <div className='flex flex-col gap-8px py-8px'>
      {asks.map((ask) => (
        <Card key={ask.id} size='small' title={t(`${CONFIRM_KEY}.title`)} role='group'>
          <ConfirmBody request={ask} onAnswer={(allow, always) => answer(ask.id, allow, always)} />
          <div className='mt-8px text-12px text-t-secondary'>{t(`${CONFIRM_KEY}.timeoutHint`)}</div>
        </Card>
      ))}
    </div>
  );
};

export default AgentConfirmCards;
