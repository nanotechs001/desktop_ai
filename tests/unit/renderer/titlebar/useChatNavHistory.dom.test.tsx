import { act, renderHook } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true, isMacOS: () => true }));

import { emitter } from '@/renderer/utils/emitter';
import { useChatNavHistory } from '@/renderer/components/layout/Titlebar/useChatNavHistory';

const router = vi.hoisted(() => ({
  navigate: null as null | ((to: string) => void),
  pathname: '',
}));

const RouterProbe: React.FC = () => {
  const navigate = useNavigate();
  router.navigate = (to) => void navigate(to);
  router.pathname = useLocation().pathname;
  return null;
};

const renderNav = (initial = '/conversation/a') =>
  renderHook(() => useChatNavHistory(), {
    wrapper: ({ children }) => (
      <MemoryRouter initialEntries={[initial]}>
        {children}
        <RouterProbe />
      </MemoryRouter>
    ),
  });

const go = (to: string) => act(() => router.navigate?.(to));

describe('useChatNavHistory', () => {
  beforeEach(() => {
    router.navigate = null;
    router.pathname = '';
  });

  it('is disabled at both ends with a single visited chat', () => {
    const { result } = renderNav();

    expect(result.current.canBack).toBe(false);
    expect(result.current.canForward).toBe(false);
  });

  it('moves between visited chats and disables the buttons at the ends', () => {
    const { result } = renderNav();
    go('/conversation/b');
    go('/conversation/c');

    expect(result.current.canBack).toBe(true);
    expect(result.current.canForward).toBe(false);

    act(() => result.current.back());
    expect(router.pathname).toBe('/conversation/b');
    expect(result.current.canForward).toBe(true);

    act(() => result.current.back());
    expect(router.pathname).toBe('/conversation/a');
    expect(result.current.canBack).toBe(false);

    act(() => result.current.forward());
    act(() => result.current.forward());
    expect(router.pathname).toBe('/conversation/c');
    expect(result.current.canForward).toBe(false);
  });

  it('drops forward entries when a new chat is opened after going back', () => {
    const { result } = renderNav();
    go('/conversation/b');
    act(() => result.current.back());
    go('/conversation/c');

    expect(result.current.canForward).toBe(false);
    act(() => result.current.back());
    expect(router.pathname).toBe('/conversation/a');
  });

  it('ignores non-chat routes and returns to the last chat from one', () => {
    const { result } = renderNav();
    go('/conversation/b');
    go('/settings/agent');
    go('/scheduled');

    expect(result.current.canBack).toBe(true);
    act(() => result.current.back());
    expect(router.pathname).toBe('/conversation/b');

    act(() => result.current.back());
    expect(router.pathname).toBe('/conversation/a');
    expect(result.current.canBack).toBe(false);
  });

  it('keeps at most 50 entries', () => {
    const { result } = renderNav('/conversation/0');
    for (let index = 1; index <= 60; index += 1) go(`/conversation/${index}`);
    for (let index = 0; index < 60; index += 1) {
      if (result.current.canBack) act(() => result.current.back());
    }

    expect(router.pathname).toBe('/conversation/11');
  });

  it('goes back and forward with Cmd+[ and Cmd+]', () => {
    renderNav();
    go('/conversation/b');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: '[', metaKey: true, cancelable: true }));
    });
    expect(router.pathname).toBe('/conversation/a');

    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: ']', metaKey: true, cancelable: true }));
    });
    expect(router.pathname).toBe('/conversation/b');
  });

  it('can go forward again after visiting a non-chat route', () => {
    const { result } = renderNav();
    go('/conversation/b');
    act(() => result.current.back());
    go('/settings/agent');

    expect(result.current.canForward).toBe(true);
    act(() => result.current.forward());
    expect(router.pathname).toBe('/conversation/b');
  });

  it('treats query variants of the same chat as one entry', () => {
    const { result } = renderNav();
    go('/conversation/a?x=1');

    expect(result.current.canBack).toBe(false);
  });

  it('forgets a deleted chat so Back never lands on it', () => {
    const { result } = renderNav();
    go('/conversation/b');
    go('/conversation/c');

    act(() => emitter.emit('conversation.deleted', 'b'));
    act(() => result.current.back());

    expect(router.pathname).toBe('/conversation/a');
    expect(result.current.canBack).toBe(false);
  });

  it('is not trapped after the open chat is deleted', () => {
    const { result } = renderNav();
    go('/conversation/b');

    act(() => emitter.emit('conversation.deleted', 'b'));
    go('/guid');

    expect(result.current.canBack).toBe(true);
    act(() => result.current.back());
    expect(router.pathname).toBe('/conversation/a');
  });

  it('forgets a deleted chat in the Forward part and keeps the rest of Forward', () => {
    const { result } = renderNav();
    go('/conversation/b');
    go('/conversation/c');
    go('/conversation/d');
    act(() => result.current.back());
    act(() => result.current.back());
    expect(router.pathname).toBe('/conversation/b');

    act(() => emitter.emit('conversation.deleted', 'c'));

    expect(result.current.canForward).toBe(true);
    act(() => result.current.forward());
    expect(router.pathname).toBe('/conversation/d');
    expect(result.current.canForward).toBe(false);
    act(() => result.current.back());
    expect(router.pathname).toBe('/conversation/b');
  });

  it('forgets an archived chat so Back never lands on it', () => {
    const { result } = renderNav();
    go('/conversation/b');
    go('/conversation/c');

    act(() => emitter.emit('conversation.archived', 'b'));
    act(() => result.current.back());

    expect(router.pathname).toBe('/conversation/a');
  });
});
