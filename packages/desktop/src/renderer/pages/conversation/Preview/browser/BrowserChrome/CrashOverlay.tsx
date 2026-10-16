/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Button } from '@arco-design/web-react';
import { Caution } from '@icon-park/react';
import { useTranslation } from 'react-i18next';

const KEY = 'preview.browserChrome.crash';

export type CrashState = 'crashed' | 'unresponsive' | null;

export type CrashOverlayProps = {
  state: CrashState;
  onReload: () => void;
  /** Dismisses the "isn't responding" overlay; Electron fires `unresponsive` again if the page stays hung. */
  onWait: () => void;
};

/** Covers a browser tab's page area when its renderer crashed or stopped responding. */
const CrashOverlay: React.FC<CrashOverlayProps> = ({ state, onReload, onWait }) => {
  const { t } = useTranslation();
  if (!state) return null;

  return (
    <div className='absolute inset-0 z-10 flex flex-col items-center justify-center gap-16px bg-bg-1 text-t-primary'>
      <Caution theme='outline' size='48' />
      <div className='text-16px'>{t(`${KEY}.${state}`)}</div>
      <div className='flex gap-8px'>
        {state === 'unresponsive' && <Button onClick={onWait}>{t(`${KEY}.wait`)}</Button>}
        <Button type='primary' onClick={onReload}>
          {t(`${KEY}.reload`)}
        </Button>
      </div>
    </div>
  );
};

export default CrashOverlay;
