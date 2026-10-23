/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef } from 'react';
import { Button } from '@arco-design/web-react';
import { Caution } from '@icon-park/react';
import { useTranslation } from 'react-i18next';

const KEY = 'preview.browserChrome.crash';

export type CrashState = 'crashed' | 'unresponsive' | null;

export type CrashOverlayProps = {
  state: CrashState;
  /** A reload is in flight; the overlay stays until the page reports a finished load. */
  reloading?: boolean;
  onReload: () => void;
  /** Dismisses the "isn't responding" overlay; Electron fires `unresponsive` again if the page stays hung. */
  onWait: () => void;
  /** Whether the tab is on screen; a hidden tab's overlay takes the focus only once the tab is shown. */
  active?: boolean;
};

/** Covers a browser tab's page area when its renderer crashed or stopped responding. */
const CrashOverlay: React.FC<CrashOverlayProps> = ({ state, reloading = false, onReload, onWait, active = true }) => {
  const { t } = useTranslation();
  const reloadRef = useRef<HTMLElement>(null);

  // Only a crash takes focus: a hang may clear by itself, and the user may be typing elsewhere.
  useEffect(() => {
    if (state === 'crashed' && active) reloadRef.current?.focus();
  }, [state, active]);

  if (!state) return null;

  return (
    <div
      role='alert'
      className='absolute inset-0 z-10 flex flex-col items-center justify-center gap-16px bg-1 text-t-primary'
    >
      <Caution theme='outline' size='48' />
      <div className='text-16px'>{t(`${KEY}.${state}`)}</div>
      <div className='flex gap-8px'>
        {state === 'unresponsive' && <Button onClick={onWait}>{t(`${KEY}.wait`)}</Button>}
        <Button ref={reloadRef} type='primary' loading={reloading} onClick={onReload}>
          {t(`${KEY}.reload`)}
        </Button>
      </div>
    </div>
  );
};

export default CrashOverlay;
