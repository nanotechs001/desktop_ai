/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * The desktop Pet is removed from this fork: no pet window is ever created and
 * the tray menu has no pet item.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => {
  const BrowserWindow = vi.fn();
  const menuTemplates: Array<Array<{ label?: string; type?: string }>> = [];
  class Tray {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    on = vi.fn();
    destroy = vi.fn();
  }
  return {
    BrowserWindow,
    menuTemplates,
    Tray,
    app: { isPackaged: false, commandLine: { getSwitchValue: () => '' }, on: vi.fn() },
    ipcMain: { on: vi.fn(), handle: vi.fn(), removeHandler: vi.fn(), removeAllListeners: vi.fn() },
    screen: { getPrimaryDisplay: () => ({ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }) },
    Menu: {
      buildFromTemplate: (template: Array<{ label?: string; type?: string }>) => {
        menuTemplates.push(template);
        return {};
      },
    },
  };
});

vi.mock('electron', () => ({
  app: electron.app,
  BrowserWindow: electron.BrowserWindow,
  ipcMain: electron.ipcMain,
  Menu: electron.Menu,
  screen: electron.screen,
}));
vi.mock('@/common/electronSafe', () => ({
  electronApp: electron.app,
  electronMenu: electron.Menu,
  electronNativeImage: {
    createFromPath: () => ({ resize: () => ({}) }),
  },
  electronTray: electron.Tray,
}));
vi.mock('@/common', () => ({
  ipcBridge: {
    database: { getUserConversations: { invoke: vi.fn().mockResolvedValue({ items: [] }) } },
    conversation: { activeCount: { invoke: vi.fn().mockResolvedValue({ count: 0 }) } },
  },
}));
vi.mock('@process/services/i18n', () => ({ default: { t: (key: string) => key } }));

import { createPetWindow, isPetSupported } from '@process/pet/petManager';
import { createOrUpdateTray, destroyTray } from '@/process/utils/tray';

describe('desktop pet', () => {
  beforeEach(() => {
    electron.BrowserWindow.mockClear();
  });

  it('is unsupported everywhere', () => {
    expect(isPetSupported()).toBe(false);
  });

  it('creates no pet window', () => {
    createPetWindow();

    expect(electron.BrowserWindow).not.toHaveBeenCalled();
  });

  it('has no tray menu item', async () => {
    electron.menuTemplates.length = 0;
    createOrUpdateTray();
    await vi.waitFor(() => expect(electron.menuTemplates.length).toBeGreaterThan(0));
    destroyTray();

    const labels = electron.menuTemplates.flat().map((item) => item.label ?? '');
    expect(labels.some((label) => label.includes('pet.'))).toBe(false);
    expect(labels).toContain('common.tray.checkUpdate');
  });
});
