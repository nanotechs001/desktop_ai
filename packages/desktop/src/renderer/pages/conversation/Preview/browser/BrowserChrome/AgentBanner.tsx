/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Alert, Button, Message } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';

const KEY = 'preview.browserChrome.agent';

/** Shown while the user has taken over an agent-driven tab; Resume lets the agent send input again. */
const AgentBanner: React.FC<{ webContentsId: number }> = ({ webContentsId }) => {
  const { t } = useTranslation();

  const resume = (): void => {
    // Main resolves { success: false } rather than rejecting, so both outcomes end in the same message.
    void ipcBridge.agentBrowser.resume
      .invoke({ webContentsId })
      .then((res) => res.success)
      .catch(() => false)
      .then((ok) => {
        if (!ok) Message.error(t(`${KEY}.actionFailed`));
      });
  };

  return (
    <Alert
      type='warning'
      className='shadow-md'
      content={t(`${KEY}.paused`)}
      action={
        <Button size='mini' type='primary' onClick={resume}>
          {t(`${KEY}.resume`)}
        </Button>
      }
    />
  );
};

export default AgentBanner;
