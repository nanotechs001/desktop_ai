/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'path';
import { app, nativeImage, type BrowserWindow } from 'electron';

/** Shown as the app icon while screen-share mode is on: a plain globe, so the shared window reads as a generic browser. */
export const SHARE_ICON_FILE = 'share-icon.png';

const resourcesDir = (): string => (app.isPackaged ? process.resourcesPath : path.join(process.cwd(), 'resources'));

/** The normal icon file: dev builds use the padded dev icon on macOS, like the startup dock icon. */
const normalIconFile = (): string => (process.platform === 'darwin' && !app.isPackaged ? 'app_dev.png' : 'app.png');

/** Swaps the dock (macOS) or window/taskbar (Windows, Linux) icon for screen-share mode, and back. */
export function setShareIcon(window: BrowserWindow | null, enabled: boolean): void {
  const icon = nativeImage.createFromPath(path.join(resourcesDir(), enabled ? SHARE_ICON_FILE : normalIconFile()));
  if (icon.isEmpty()) {
    console.warn('[ShareIcon] icon file missing or unreadable');
    return;
  }
  if (process.platform === 'darwin') app.dock?.setIcon(icon);
  else if (window && !window.isDestroyed()) window.setIcon(icon);
}
