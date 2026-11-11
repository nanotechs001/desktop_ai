import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const setShareIcon = vi.hoisted(() => vi.fn(() => Promise.resolve()));
vi.mock('@/common', () => ({ ipcBridge: { application: { setShareIcon: { invoke: setShareIcon } } } }));
vi.mock('@renderer/utils/platform', () => ({ isElectronDesktop: () => true }));

import { SCREEN_SHARE_STORAGE_KEY, useScreenShareMode } from '@renderer/hooks/ui/screenShare/useScreenShareMode';

describe('useScreenShareMode', () => {
  beforeEach(() => {
    localStorage.clear();
    setShareIcon.mockClear();
  });

  it('applies only in browser mode, remembers the switch, and never touches the icon at startup', () => {
    const { result, rerender } = renderHook(({ browser }) => useScreenShareMode(browser), {
      initialProps: { browser: false },
    });
    expect(setShareIcon).not.toHaveBeenCalled();

    act(() => result.current.toggle());
    expect(result.current).toMatchObject({ enabled: true, active: false });
    expect(localStorage.getItem(SCREEN_SHARE_STORAGE_KEY)).toBe('1');
    expect(setShareIcon).not.toHaveBeenCalled();

    rerender({ browser: true });
    expect(result.current.active).toBe(true);
    expect(setShareIcon).toHaveBeenLastCalledWith({ enabled: true });

    rerender({ browser: false });
    expect(setShareIcon).toHaveBeenLastCalledWith({ enabled: false });
  });

  it('starts from the remembered switch', () => {
    localStorage.setItem(SCREEN_SHARE_STORAGE_KEY, '1');
    const { result } = renderHook(() => useScreenShareMode(true));
    expect(result.current.active).toBe(true);
    expect(setShareIcon).toHaveBeenCalledWith({ enabled: true });
  });
});
