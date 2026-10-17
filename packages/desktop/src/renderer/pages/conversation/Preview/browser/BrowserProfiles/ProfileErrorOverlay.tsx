/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button } from '@arco-design/web-react';
import { Caution } from '@icon-park/react';
import React from 'react';
import { useTranslation } from 'react-i18next';

const KEY = 'preview.browserChrome.profile';

type ProfileErrorOverlayProps = {
  /** Why main could not set the tab's browser profile up. */
  error: string;
  onRetry: () => void;
};

/** Covers a browser tab whose browser profile could not be set up, in the place of the page that never loaded. */
const ProfileErrorOverlay: React.FC<ProfileErrorOverlayProps> = ({ error, onRetry }) => {
  const { t } = useTranslation();
  return (
    <div
      role='alert'
      className='absolute inset-0 z-10 flex flex-col items-center justify-center gap-16px bg-bg-1 text-t-primary'
    >
      <Caution theme='outline' size='48' />
      <div className='text-16px'>{t(`${KEY}.unavailable`)}</div>
      <div className='max-w-480px text-center text-12px text-t-secondary'>{error}</div>
      <Button type='primary' onClick={onRetry}>
        {t(`${KEY}.retry`)}
      </Button>
    </div>
  );
};

export default ProfileErrorOverlay;
