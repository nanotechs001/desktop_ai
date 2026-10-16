/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';

/** `<browser-action-list>` from electron-chrome-extensions/browser-action, injected by the main preload. */
declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      'browser-action-list': React.DetailedHTMLProps<React.HTMLAttributes<HTMLElement>, HTMLElement> & {
        partition?: string;
        tab?: string;
        alignment?: string;
      };
    }
  }
}
