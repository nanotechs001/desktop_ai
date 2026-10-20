/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * In the WebUI the one-shot startup reads (settings, theme, language, fonts...)
 * run before sign-in and fail with 401. Signing in must re-run them in place —
 * no page reload — and the desktop app, which is never signed out, must not.
 */

const config = vi.hoisted(() => ({
  initialize: vi.fn(),
  whenReady: vi.fn(),
  get: vi.fn(),
}));

vi.mock('@/common/config/configService', () => ({ configService: config }));
vi.mock('@/common', () => ({ ipcBridge: { systemSettings: { languageChanged: { on: vi.fn() } } } }));

type AuthModule = typeof import('@/renderer/hooks/context/AuthContext');
type AuthApi = ReturnType<AuthModule['useAuth']>;

const USER = { id: 'u1', username: 'admin' };

function json(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

/** Backend stub: `/api/auth/user` answers as signed in once `signedIn` is true. */
function stubBackend(state: { signedIn: boolean }) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/auth/user') return state.signedIn ? json(200, { success: true, user: USER }) : json(401, {});
      if (url === '/api/auth/refresh') return json(401, {});
      if (url === '/login') {
        state.signedIn = true;
        return json(200, { success: true, user: USER });
      }
      return json(404, {});
    })
  );
}

async function mountAuth() {
  const { AuthProvider, useAuth } = await import('@/renderer/hooks/context/AuthContext');
  const { onAuthenticated } = await import('@/renderer/hooks/context/authEvents');
  const fired = vi.fn();
  const off = onAuthenticated(fired);
  const api: { current: AuthApi | null } = { current: null };
  const Probe = () => {
    api.current = useAuth();
    return null;
  };
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );
  await waitFor(() => expect(api.current?.ready).toBe(true));
  return { api: api as { current: AuthApi }, fired, off };
}

describe('AuthProvider sign-in transition', () => {
  beforeEach(() => {
    vi.resetModules();
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    delete (window as { electronAPI?: unknown }).electronAPI;
  });

  it('fires once when a signed-out page signs in, and not on later status checks', async () => {
    stubBackend({ signedIn: false });
    const { api, fired, off } = await mountAuth();
    expect(api.current.status).toBe('unauthenticated');
    expect(fired).not.toHaveBeenCalled();

    await act(async () => {
      await api.current.login({ username: 'admin', password: 'pw' });
    });
    expect(fired).toHaveBeenCalledTimes(1);

    await act(async () => {
      await api.current.refresh();
    });
    expect(api.current.status).toBe('authenticated');
    expect(fired).toHaveBeenCalledTimes(1);
    off();
  });

  it('fires when a refresh finds the session a QR login created', async () => {
    const backend = { signedIn: false };
    stubBackend(backend);
    const { api, fired, off } = await mountAuth();

    backend.signedIn = true;
    await act(async () => {
      await api.current.refresh();
    });
    expect(fired).toHaveBeenCalledTimes(1);
    off();
  });

  it('does not fire for a page that loads already signed in', async () => {
    stubBackend({ signedIn: true });
    const { api, fired, off } = await mountAuth();
    expect(api.current.status).toBe('authenticated');
    expect(fired).not.toHaveBeenCalled();
    off();
  });

  it('never fires in the desktop app', async () => {
    (window as { electronAPI?: unknown }).electronAPI = {};
    stubBackend({ signedIn: false });
    const { api, fired, off } = await mountAuth();

    await act(async () => {
      await api.current.logout();
      await api.current.login({ username: 'admin', password: 'pw' });
      await api.current.refresh();
    });
    expect(fired).not.toHaveBeenCalled();
    off();
  });
});

describe('startup reads re-run on sign-in', () => {
  beforeEach(() => {
    vi.resetModules();
    config.initialize.mockReset();
    config.whenReady.mockReset();
    config.get.mockReset();
  });

  it('re-initialises the settings cache', async () => {
    config.initialize.mockResolvedValue(undefined);
    await import('@renderer/services/bootstrapRenderer');
    const { emitAuthenticated } = await import('@/renderer/hooks/context/authEvents');

    emitAuthenticated();
    expect(config.initialize).toHaveBeenCalledTimes(1);
  });

  it('switches to the saved language that the signed-out read could not see', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    config.whenReady.mockRejectedValueOnce(new Error('401'));
    const { default: i18n } = await import('@/renderer/services/i18n');
    const { emitAuthenticated } = await import('@/renderer/hooks/context/authEvents');
    await waitFor(() => expect(config.whenReady).toHaveBeenCalledTimes(1));
    expect(i18n.language).toBe('en-US');

    config.whenReady.mockResolvedValue(undefined);
    config.get.mockImplementation((key: string) => (key === 'language' ? 'de-DE' : undefined));
    emitAuthenticated();

    await waitFor(() => expect(i18n.language).toBe('de-DE'));
  });
});
