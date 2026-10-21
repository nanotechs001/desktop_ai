/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

const windows = vi.hoisted(
  () => [] as Array<{ webContents: { setZoomFactor: ReturnType<typeof vi.fn>; getZoomMode: () => string } }>
);
vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => windows } }));
vi.mock('@process/utils/persistOnQuit', () => ({ trackPersistedWrite: vi.fn() }));

import { setZoomFactor } from '@process/utils/zoom';

const makeWindow = (zoomMode: string) => ({ webContents: { setZoomFactor: vi.fn(), getZoomMode: () => zoomMode } });

describe('updating the zoom of every window', () => {
  it('zooms the main window but never a robot window, whose zoom is locked', () => {
    const main = makeWindow('default');
    const robot = makeWindow('disabled');
    windows.push(main, robot);

    setZoomFactor(1.2);

    expect(main.webContents.setZoomFactor).toHaveBeenCalledWith(1.2);
    expect(robot.webContents.setZoomFactor).not.toHaveBeenCalled();
  });
});
