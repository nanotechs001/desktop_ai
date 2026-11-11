/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */
import React from 'react';
import type { ScreenShareMode } from '@renderer/hooks/ui/screenShare/useScreenShareMode';

export interface LayoutContextValue {
  isMobile: boolean;
  siderCollapsed: boolean;
  setSiderCollapsed: (value: boolean) => void;
  /** A browser tab fills the window (chat hidden): the screen-share toggle shows only then. */
  browserMode?: boolean;
  screenShare?: ScreenShareMode;
}

export const LayoutContext = React.createContext<LayoutContextValue | null>(null);

export function useLayoutContext(): LayoutContextValue | null {
  return React.useContext(LayoutContext);
}
