/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '@arco-design/web-react';
import React from 'react';
import { useTranslation } from 'react-i18next';
import WebviewHost from '@/renderer/components/media/WebviewHost';
import { isElectronDesktop, openExternalUrl } from '@/renderer/utils/platform';

interface URLViewerProps {
  /** URL to display */
  url: string;
  /** Optional title for the page */
  title?: string;
}

/**
 * URL 预览组件 - 用于在应用内预览网页（对话框预览面板）
 * URL Preview component - for previewing web pages within the app (conversation preview panel)
 *
 * Delegates to the shared WebviewHost with navigation bar enabled.
 */
const URLViewer: React.FC<URLViewerProps> = ({ url }) => {
  const { t } = useTranslation();
  if (isElectronDesktop()) return <WebviewHost url={url} showNavBar className='bg-bg-1' />;
  // The WebUI has no <webview>: offer the page in a new tab of the phone's own browser.
  return (
    <div className='flex flex-col items-center justify-center gap-12px h-full p-16px bg-bg-1'>
      <span className='text-13px text-t-secondary break-all text-center'>{url}</span>
      {/^https?:\/\//i.test(url) && (
        <Button type='primary' onClick={() => void openExternalUrl(url)}>
          {t('preview.browser.openLink')}
        </Button>
      )}
    </div>
  );
};

export default URLViewer;
