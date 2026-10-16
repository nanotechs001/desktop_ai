/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Alert, Button } from '@arco-design/web-react';
import { useTranslation } from 'react-i18next';
import { ipcBridge } from '@/common';

const KEY = 'preview.browserChrome.agent';

/** Shown while the user has taken over an agent-driven tab; Resume lets the agent send input again. */
const AgentBanner: React.FC<{ webContentsId: number }> = ({ webContentsId }) => {
  const { t } = useTranslation();

  const resume = (): void => {
    // On failure the tab stays paused and this banner stays up, so the user can simply click again.
    void ipcBridge.agentBrowser.resume.invoke({ webContentsId }).catch((error: unknown) => {
      console.warn('[BrowserViewer] could not resume the agent:', error);
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
