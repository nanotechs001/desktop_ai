/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ refresh: vi.fn(), reconnect: vi.fn() }));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@renderer/hooks/context/AuthContext', () => ({ useAuth: () => ({ refresh: mocks.refresh }) }));

import QrLoginPage from '@/renderer/pages/login/QrLoginPage';

const renderAt = (url: string) =>
  render(
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path='/qr-login' element={<QrLoginPage />} />
        <Route path='/' element={<div>home</div>} />
        <Route path='/login' element={<div>login screen</div>} />
      </Routes>
    </MemoryRouter>
  );

type WindowWithReconnect = Window & { __websocketReconnect?: () => void };

describe('QrLoginPage', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    mocks.refresh.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', fetchMock);
    (window as WindowWithReconnect).__websocketReconnect = mocks.reconnect;
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    delete (window as WindowWithReconnect).__websocketReconnect;
  });

  it('posts the token, refreshes auth and goes home on success', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200 });
    renderAt('/qr-login?token=abc%20123');

    expect(await screen.findByText('home')).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/auth/qr-login');
    expect(init.method).toBe('POST');
    expect(init.credentials).toBe('include');
    expect(JSON.parse(init.body)).toEqual({ qr_token: 'abc 123' });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.reconnect).toHaveBeenCalledTimes(1);
  });

  it('shows the expired message and a way back to sign in on 401', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 401 });
    renderAt('/qr-login?token=stale');

    expect(await screen.findByText('login.qrExpired')).toBeInTheDocument();
    expect(mocks.refresh).not.toHaveBeenCalled();
    screen.getByRole('button', { name: 'login.qrBackToLogin' }).click();
    expect(await screen.findByText('login screen')).toBeInTheDocument();
  });

  it('shows the expired message when the request itself fails', async () => {
    fetchMock.mockRejectedValue(new TypeError('network down'));
    renderAt('/qr-login?token=abc');
    expect(await screen.findByText('login.qrExpired')).toBeInTheDocument();
  });

  it('shows the expired message without any request when there is no token', async () => {
    renderAt('/qr-login');
    expect(await screen.findByText('login.qrExpired')).toBeInTheDocument();
    await waitFor(() => expect(fetchMock).not.toHaveBeenCalled());
  });
});
