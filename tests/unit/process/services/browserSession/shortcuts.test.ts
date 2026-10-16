/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ emit: vi.fn() }));

vi.mock('@/common', () => ({ ipcBridge: { browser: { shortcut: { emit: mocks.emit } } } }));

import { classifyBrowserShortcut, installBrowserShortcuts } from '@process/services/browserSession/shortcuts';

type Input = Parameters<typeof classifyBrowserShortcut>[0];

const key = (k: string, mods: Partial<Input> = {}): Input => ({
  type: 'keyDown',
  key: k,
  meta: false,
  control: false,
  shift: false,
  alt: false,
  ...mods,
});

describe('classifyBrowserShortcut', () => {
  it.each([
    ['f', 'find'],
    ['l', 'focus-address'],
    ['t', 'new-tab'],
    ['w', 'close-tab'],
    ['r', 'reload'],
    ['[', 'back'],
    [']', 'forward'],
    ['=', 'zoom-in'],
    ['+', 'zoom-in'],
    ['-', 'zoom-out'],
    ['0', 'zoom-reset'],
    ['p', 'print'],
  ])('darwin meta+%s -> %s', (k, action) => {
    expect(classifyBrowserShortcut(key(k, { meta: true }), 'darwin')).toBe(action);
  });

  it('darwin meta+shift+r -> hard-reload; win32 control+r -> reload; win32 control+shift+r -> hard-reload', () => {
    expect(classifyBrowserShortcut(key('R', { meta: true, shift: true }), 'darwin')).toBe('hard-reload');
    expect(classifyBrowserShortcut(key('r', { control: true }), 'win32')).toBe('reload');
    expect(classifyBrowserShortcut(key('R', { control: true, shift: true }), 'win32')).toBe('hard-reload');
  });

  it('meta+shift++ (US layout zoom in) -> zoom-in', () => {
    expect(classifyBrowserShortcut(key('+', { meta: true, shift: true }), 'darwin')).toBe('zoom-in');
  });

  it('uses the platform modifier only: darwin ignores control, win32 and linux ignore meta', () => {
    expect(classifyBrowserShortcut(key('r', { control: true }), 'darwin')).toBeNull();
    expect(classifyBrowserShortcut(key('r', { meta: true }), 'win32')).toBeNull();
    expect(classifyBrowserShortcut(key('f', { control: true }), 'linux')).toBe('find');
  });

  it('meta+q, plain "r", keyUp events and alt-modified keys -> null', () => {
    expect(classifyBrowserShortcut(key('q', { meta: true }), 'darwin')).toBeNull();
    expect(classifyBrowserShortcut(key('r'), 'darwin')).toBeNull();
    expect(classifyBrowserShortcut({ ...key('r', { meta: true }), type: 'keyUp' }, 'darwin')).toBeNull();
    expect(classifyBrowserShortcut(key('r', { meta: true, alt: true }), 'darwin')).toBeNull();
    expect(classifyBrowserShortcut(key('f', { meta: true, shift: true }), 'darwin')).toBeNull();
  });

  it('Escape without modifiers -> escape; with a modifier -> null', () => {
    expect(classifyBrowserShortcut(key('Escape'), 'darwin')).toBe('escape');
    expect(classifyBrowserShortcut(key('Escape', { shift: true }), 'darwin')).toBeNull();
    expect(classifyBrowserShortcut(key('Escape', { meta: true }), 'darwin')).toBeNull();
  });
});

describe('installBrowserShortcuts', () => {
  const setup = () => {
    let handler: (event: Electron.Event, input: Input) => void = vi.fn();
    const navigationHistory = {
      canGoBack: vi.fn(() => true),
      canGoForward: vi.fn(() => true),
      goBack: vi.fn(),
      goForward: vi.fn(),
    };
    let zoom = 0;
    const contents = {
      id: 42,
      on: vi.fn((_name: string, listener: typeof handler) => {
        handler = listener;
      }),
      reload: vi.fn(),
      reloadIgnoringCache: vi.fn(),
      print: vi.fn(),
      navigationHistory,
      getZoomLevel: () => zoom,
      setZoomLevel: vi.fn((level: number) => {
        zoom = level;
      }),
    };
    installBrowserShortcuts(contents as unknown as Electron.WebContents, 'darwin');
    const press = (input: Input) => {
      const event = { preventDefault: vi.fn() };
      handler(event as unknown as Electron.Event, input);
      return event;
    };
    return { contents, navigationHistory, press };
  };

  beforeEach(() => mocks.emit.mockClear());

  it('meta+r prevents the default (no app-menu reload) and reloads the page', () => {
    const { contents, press } = setup();
    const event = press(key('r', { meta: true }));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(contents.reload).toHaveBeenCalledOnce();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('meta+q passes through untouched', () => {
    const { contents, press } = setup();
    const event = press(key('q', { meta: true }));
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(contents.reload).not.toHaveBeenCalled();
    expect(mocks.emit).not.toHaveBeenCalled();
  });

  it('hard-reload, back, forward and print are handled in main', () => {
    const { contents, navigationHistory, press } = setup();
    press(key('R', { meta: true, shift: true }));
    press(key('[', { meta: true }));
    press(key(']', { meta: true }));
    press(key('p', { meta: true }));
    expect(contents.reloadIgnoringCache).toHaveBeenCalledOnce();
    expect(navigationHistory.goBack).toHaveBeenCalledOnce();
    expect(navigationHistory.goForward).toHaveBeenCalledOnce();
    expect(contents.print).toHaveBeenCalledOnce();
  });

  it('does not navigate when there is no history in that direction', () => {
    const { navigationHistory, press } = setup();
    navigationHistory.canGoBack.mockReturnValue(false);
    const event = press(key('[', { meta: true }));
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(navigationHistory.goBack).not.toHaveBeenCalled();
  });

  it('zoom steps by 0.5, clamps to [-3, 5] and resets to 0', () => {
    const { contents, press } = setup();
    press(key('=', { meta: true }));
    expect(contents.setZoomLevel).toHaveBeenLastCalledWith(0.5);
    for (let i = 0; i < 20; i++) press(key('=', { meta: true }));
    expect(contents.setZoomLevel).toHaveBeenLastCalledWith(5);
    press(key('0', { meta: true }));
    expect(contents.setZoomLevel).toHaveBeenLastCalledWith(0);
    for (let i = 0; i < 20; i++) press(key('-', { meta: true }));
    expect(contents.setZoomLevel).toHaveBeenLastCalledWith(-3);
  });

  it('renderer-bound shortcuts emit with the webContents id and prevent the default', () => {
    const { press } = setup();
    for (const [k, action] of [
      ['f', 'find'],
      ['l', 'focus-address'],
      ['t', 'new-tab'],
      ['w', 'close-tab'],
    ]) {
      const event = press(key(k, { meta: true }));
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(mocks.emit).toHaveBeenLastCalledWith({ webContentsId: 42, action });
    }
  });

  it('escape is reported to the renderer but still reaches the page', () => {
    const { press } = setup();
    const event = press(key('Escape'));
    expect(mocks.emit).toHaveBeenCalledWith({ webContentsId: 42, action: 'escape' });
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});
