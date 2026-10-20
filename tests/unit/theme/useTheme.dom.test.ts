import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Theme } from '@/common/theme/types';

const { changedOnMock, configGetMock, setActiveThemeMock } = vi.hoisted(() => ({
  changedOnMock: vi.fn(() => vi.fn()),
  configGetMock: vi.fn(),
  setActiveThemeMock: vi.fn(),
}));

vi.mock('@/common/config/configService', () => ({
  configService: {
    get: configGetMock,
    whenReady: vi.fn().mockResolvedValue(undefined),
  },
}));

vi.mock('@/common', () => ({
  ipcBridge: {
    theme: {
      changed: { on: changedOnMock },
    },
  },
}));

vi.mock('@/renderer/utils/theme/applyTheme', () => ({
  applyTheme: vi.fn(),
  seedElectronTheme: vi.fn().mockResolvedValue(undefined),
  setActiveTheme: setActiveThemeMock,
}));

vi.mock('@/renderer/utils/theme/systemThemeWatcher', () => ({
  startSystemThemeWatcher: vi.fn(() => vi.fn()),
}));

import useTheme from '@/renderer/hooks/system/useTheme';
import { emitAuthenticated } from '@/renderer/hooks/context/authEvents';
import { applyTheme } from '@/renderer/utils/theme/applyTheme';

const darkTheme: Theme = {
  id: 'dark',
  name: 'Dark',
  appearance: 'dark',
  builtin: true,
  created_at: 0,
  updated_at: 0,
};

describe('useTheme selection', () => {
  beforeEach(() => {
    configGetMock.mockImplementation((key: string) => {
      if (key === 'theme.activeId') return 'light';
      if (key === 'theme.userThemes') return [];
      return undefined;
    });
    setActiveThemeMock.mockReset();
  });

  it('updates local theme state without waiting for a cross-window event', async () => {
    setActiveThemeMock.mockResolvedValue(darkTheme);
    const { result } = renderHook(() => useTheme());

    await waitFor(() => expect(result.current[0]?.appearance).toBe('light'));
    await act(async () => result.current[1]('dark'));

    expect(result.current[0]?.appearance).toBe('dark');
    expect(result.current[2]).toBe('dark');
    expect(localStorage.getItem('__aionui_theme')).toBe('dark');
  });

  it('keeps the current state when selecting a theme fails', async () => {
    setActiveThemeMock.mockRejectedValue(new Error('save failed'));
    const { result } = renderHook(() => useTheme());

    await waitFor(() => expect(result.current[0]?.appearance).toBe('light'));
    await expect(act(async () => result.current[1]('dark'))).rejects.toThrow('save failed');

    expect(result.current[0]?.appearance).toBe('light');
  });

  it('applies the saved theme again once a signed-out WebUI page signs in', async () => {
    configGetMock.mockImplementation((key: string) => {
      if (key === 'theme.activeId') return 'dark';
      if (key === 'theme.userThemes') return [];
      return undefined;
    });
    vi.mocked(applyTheme).mockClear();

    emitAuthenticated();

    await waitFor(() => expect(applyTheme).toHaveBeenCalledWith(expect.objectContaining({ id: 'dark' })));
  });
});
