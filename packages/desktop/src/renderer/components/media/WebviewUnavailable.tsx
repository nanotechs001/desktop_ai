/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@arco-design/web-react';
import { useOptionalPreviewContext } from '@/renderer/pages/conversation/Preview/context/PreviewContext';

type WebviewUnavailableProps = {
  className?: string;
  style?: React.CSSProperties;
};

/**
 * Stands in for `<webview>` outside Electron (the WebUI in a plain browser), where the tag does not exist.
 * Inside a preview it offers the way back to the chat, which on a phone the preview covers.
 */
const WebviewUnavailable: React.FC<WebviewUnavailableProps> = ({ className, style }) => {
  const { t } = useTranslation();
  const preview = useOptionalPreviewContext();

  return (
    <div className={`h-full w-full flex items-center justify-center bg-1 ${className ?? ''}`} style={style}>
      <div className='text-center max-w-400px px-16px'>
        <div className='text-14px text-t-secondary mb-12px'>{t('preview.browser.desktopOnly')}</div>
        {preview && (
          <Button size='small' type='primary' onClick={preview.closePreview}>
            {t('common.back')}
          </Button>
        )}
      </div>
    </div>
  );
};

export default WebviewUnavailable;
