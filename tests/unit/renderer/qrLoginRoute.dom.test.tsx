/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/hooks/context/AuthContext', () => ({
  useAuth: () => ({ status: 'unauthenticated', user: null }),
}));
vi.mock('@/renderer/hooks/system/useCrossSessionRateLimitNotice', () => ({
  useCrossSessionRateLimitNotice: () => {},
}));
vi.mock('@renderer/components/layout/DocumentTitle', () => ({ default: () => null }));
vi.mock('@renderer/pages/login/QrLoginPage', () => ({
  default: () => <div>qr login page {window.location.hash}</div>,
}));
vi.mock('@renderer/pages/login', () => ({ default: () => <div>password login page</div> }));

import PanelRoute from '@renderer/components/layout/Router';

describe('/qr-login route', () => {
  afterEach(() => {
    cleanup();
    window.history.replaceState(null, '', '/');
  });

  it('is reachable without a session when the QR opens it as a real path', async () => {
    window.history.replaceState(null, '', '/qr-login?token=abc');
    render(<PanelRoute layout={<div>protected layout</div>} />);

    expect(await screen.findByText(/qr login page/)).toBeInTheDocument();
    expect(screen.queryByText('password login page')).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
    expect(window.location.hash).toBe('#/qr-login?token=abc');
  });

  it('is reachable as a hash route too', async () => {
    window.history.replaceState(null, '', '/#/qr-login?token=abc');
    render(<PanelRoute layout={<div>protected layout</div>} />);
    expect(await screen.findByText(/qr login page/)).toBeInTheDocument();
  });
});
