/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@arco-design/web-react';
import { Browser } from '@icon-park/react';
import { useOptionalPreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';
import { isElectronDesktop } from '@/renderer/utils/platform';
import { useLiveTabs } from './useLiveTabs';

type WatchBrowserButtonProps = { conversationId: string };

/**
 * WebUI header action: while the conversation has a desktop tab to watch, opens the browser preview, where
 * {@link BrowserLiveView} shows it. The WebUI never opens that preview by itself.
 */
const WatchBrowserButton: React.FC<WatchBrowserButtonProps> = ({ conversationId }) => {
  const { t } = useTranslation();
  const preview = useOptionalPreviewContext();
  const tabs = useLiveTabs(isElectronDesktop() ? null : conversationId);
  if (!preview || !tabs?.length || isElectronDesktop()) return null;

  const open = () => {
    const browserTab = preview.tabs.find((tab) => tab.content_type === 'browser');
    if (!browserTab) {
      preview.openBrowserTab();
      return;
    }
    preview.switchTab(browserTab.id);
    preview.revealBrowserFor(conversationId);
  };

  return (
    <Button size='mini' icon={<Browser theme='outline' size='14' />} onClick={open}>
      {t('preview.browser.watchBrowser')}
    </Button>
  );
};

export default WatchBrowserButton;
