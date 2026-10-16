/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Button } from '@arco-design/web-react';
import { Puzzle } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import type { BrowserTabProfile } from '@/common/types/browser';
import { useOptionalPreviewContext } from '../../context/PreviewContext';

const CHROME_WEB_STORE_URL = 'https://chromewebstore.google.com/';

type ExtensionActionsProps = {
  /** The tab's partition: each browser profile has its own extensions. */
  partition: string;
  /** The tab's profile; the Web Store opens there, so installs land in this profile. */
  profile?: BrowserTabProfile;
};

/** Nav-bar extension action icons (with their popups) plus a shortcut to the Chrome Web Store. */
const ExtensionActions: React.FC<ExtensionActionsProps> = ({ partition, profile }) => {
  const { t } = useTranslation();
  const preview = useOptionalPreviewContext();
  const label = t('preview.browserChrome.extensions.get');

  return (
    <div className='flex items-center'>
      {/* Ruling H: electron-chrome-extensions' own web component (injected by the preload), not a raw control. */}
      <browser-action-list partition={partition} alignment='bottom right' />
      <Button
        type='text'
        size='mini'
        aria-label={label}
        title={label}
        icon={<Puzzle theme='outline' size='16' />}
        onClick={() => preview?.openBrowserTab(CHROME_WEB_STORE_URL, profile)}
      />
    </div>
  );
};

export default ExtensionActions;
