/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { ipcBridge } from '@/common';
import { Button, Message, Popconfirm } from '@arco-design/web-react';
import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { SectionCard } from './editorSectionPrimitives';

type BrowserProfileSectionProps = {
  agentId: string;
};

/** The Agent's own browser profile in its editor: what it is, and clearing its cookies, sign-ins and site data. */
const BrowserProfileSection: React.FC<BrowserProfileSectionProps> = ({ agentId }) => {
  const { t } = useTranslation();
  const [messageApi, messageContext] = Message.useMessage();
  const [clearing, setClearing] = useState(false);

  const handleClear = async () => {
    setClearing(true);
    const reply = await ipcBridge.browser.clearProfileData.invoke({ agentId }).catch((): null => null);
    setClearing(false);
    if (reply?.success) {
      messageApi.success(t('agent.browserProfile.cleared', { defaultValue: 'Browsing data cleared.' }));
    } else {
      messageApi.error(t('agent.browserProfile.clearFailed', { defaultValue: "Couldn't clear the browsing data." }));
    }
  };

  return (
    <SectionCard
      title={t('agent.browserProfile.title', { defaultValue: 'Browser profile' })}
      testId='assistant-card-browser-profile'
    >
      {messageContext}
      <div className='mb-8px text-12px leading-18px text-t-tertiary'>
        {t('agent.browserProfile.hint', {
          defaultValue:
            "This Agent's own cookies, sign-ins, site data and extensions in the browser pane, separate from yours.",
        })}
      </div>
      <Popconfirm
        title={t('agent.browserProfile.clearConfirm', {
          defaultValue: "Clear this Agent's cookies, sign-ins and site data? Open tabs update after a reload.",
        })}
        okText={t('agent.browserProfile.clearConfirmOk', { defaultValue: 'Clear' })}
        cancelText={t('common.cancel', { defaultValue: 'Cancel' })}
        okButtonProps={{ status: 'danger' }}
        onOk={() => void handleClear()}
      >
        <Button type='outline' size='small' status='danger' className='!rounded-full' loading={clearing}>
          {t('agent.browserProfile.clear', { defaultValue: 'Clear browsing data' })}
        </Button>
      </Popconfirm>
    </SectionCard>
  );
};

export default BrowserProfileSection;
