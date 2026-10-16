/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import CrashOverlay from '@/renderer/pages/conversation/Preview/browser/BrowserChrome/CrashOverlay';

const KEY = 'preview.browserChrome.crash';

afterEach(cleanup);

describe('CrashOverlay', () => {
  it('crashed shows the crash message with Reload, which calls onReload', () => {
    const onReload = vi.fn();
    render(<CrashOverlay state='crashed' onReload={onReload} onWait={vi.fn()} />);

    expect(screen.getByText(`${KEY}.crashed`)).toBeTruthy();
    expect(screen.queryByText(`${KEY}.wait`)).toBeNull();

    fireEvent.click(screen.getByText(`${KEY}.reload`));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('unresponsive shows Wait and Reload, each calling its own handler', () => {
    const onReload = vi.fn();
    const onWait = vi.fn();
    render(<CrashOverlay state='unresponsive' onReload={onReload} onWait={onWait} />);

    expect(screen.getByText(`${KEY}.unresponsive`)).toBeTruthy();

    fireEvent.click(screen.getByText(`${KEY}.wait`));
    expect(onWait).toHaveBeenCalledTimes(1);
    expect(onReload).not.toHaveBeenCalled();

    fireEvent.click(screen.getByText(`${KEY}.reload`));
    expect(onReload).toHaveBeenCalledTimes(1);
  });

  it('null renders nothing', () => {
    const { container } = render(<CrashOverlay state={null} onReload={vi.fn()} onWait={vi.fn()} />);

    expect(container.innerHTML).toBe('');
  });
});
