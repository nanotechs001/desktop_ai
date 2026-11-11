/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import { isElectronDesktop } from '@renderer/utils/platform';

export const SCREEN_SHARE_STORAGE_KEY = 'screen-share-mode';

const readStored = (): boolean => {
  try {
    return localStorage.getItem(SCREEN_SHARE_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
};

export type ScreenShareMode = {
  /** The user's switch, remembered across restarts. */
  enabled: boolean;
  /** In effect now: the switch is on and the browser fills the window. */
  active: boolean;
  toggle: () => void;
};

/**
 * Screen-share mode makes the full-window browser look like a plain browser: the layout hides the sidebar and the
 * titlebar's app icons, and the app icon becomes a plain globe. It applies only in browser mode (`browserMode`).
 */
export function useScreenShareMode(browserMode: boolean): ScreenShareMode {
  const [enabled, setEnabled] = useState(readStored);
  const active = enabled && browserMode;
  // The normal icon is only restored after a swap, so startup keeps the packaged icon untouched.
  const swapped = useRef(false);

  useEffect(() => {
    if (!isElectronDesktop() || (!active && !swapped.current)) return;
    swapped.current = active;
    ipcBridge.application.setShareIcon.invoke({ enabled: active }).catch((error: unknown) => {
      console.warn('[ScreenShare] icon swap failed:', error);
    });
  }, [active]);

  const toggle = useCallback(() => {
    setEnabled((previous) => {
      const next = !previous;
      try {
        localStorage.setItem(SCREEN_SHARE_STORAGE_KEY, next ? '1' : '0');
      } catch {
        // Not remembered (storage unavailable); the switch still works for this session.
      }
      return next;
    });
  }, []);

  return { enabled, active, toggle };
}
