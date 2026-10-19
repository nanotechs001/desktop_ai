/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type TunnelStatus =
  | { state: 'stopped' }
  | { state: 'downloading' }
  | { state: 'starting' }
  | { state: 'running'; url: string }
  | { state: 'error'; message: string };

const mocks = vi.hoisted(() => {
  const state: { tunnelListener: ((s: unknown) => void) | null } = { tunnelListener: null };
  return {
    state,
    unsubscribeTunnel: vi.fn(),
    getTunnelStatus: vi.fn(),
    startTunnel: vi.fn(),
    stopTunnel: vi.fn(),
    getStatus: vi.fn(),
    generateQRToken: vi.fn(),
    messageError: vi.fn(),
  };
});

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: unknown) =>
      typeof options === 'object' && options !== null && 'reason' in options
        ? `${key}|${String((options as { reason: unknown }).reason)}`
        : key,
    i18n: { language: 'en-US' },
  }),
}));

vi.mock('@arco-design/web-react', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@arco-design/web-react')>();
  return { ...actual, Message: { ...actual.Message, error: mocks.messageError, success: vi.fn(), warning: vi.fn() } };
});

vi.mock('@/common/adapter/ipcBridge', () => ({
  shell: { openExternal: { invoke: vi.fn(() => Promise.resolve()) } },
  webui: {
    getStatus: { invoke: mocks.getStatus },
    generateQRToken: { invoke: mocks.generateQRToken },
    statusChanged: { on: vi.fn(() => () => {}) },
    start: { invoke: vi.fn() },
    stop: { invoke: vi.fn() },
    tunnel: {
      getStatus: { invoke: mocks.getTunnelStatus },
      start: { invoke: mocks.startTunnel },
      stop: { invoke: mocks.stopTunnel },
      statusChanged: {
        on: vi.fn((cb: (s: unknown) => void) => {
          mocks.state.tunnelListener = cb;
          return mocks.unsubscribeTunnel;
        }),
      },
    },
  },
}));

vi.mock('@/common/adapter/httpBridge', () => ({ isBackendHttpError: () => false }));
vi.mock('@/common/config/configService', () => ({
  configService: { get: vi.fn(() => false), set: vi.fn(() => Promise.resolve()) },
}));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => true }));
vi.mock('@/renderer/components/settings/SettingsModal/settingsViewContext', () => ({
  useSettingsViewMode: () => 'modal',
}));
vi.mock('@/renderer/components/base/AionScrollArea', () => ({
  default: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
vi.mock('@/renderer/components/base/AionModal', () => ({ default: () => null }));
vi.mock('@/renderer/services/i18n/format', () => ({ formatTime: () => '12:00' }));
vi.mock('qrcode.react', () => ({
  QRCodeSVG: ({ value }: { value: string }) => <div data-testid='qr' data-value={value} />,
}));

import WebuiModalContent from '@/renderer/components/settings/SettingsModal/contents/WebuiModalContent';

const TUNNEL_URL = 'https://quiet-fox-1234.trycloudflare.com';
const baseStatus = {
  running: true,
  port: 25808,
  allowRemote: false,
  localUrl: 'http://localhost:25808',
  adminUsername: 'admin',
};

const emitTunnel = (status: TunnelStatus) => act(async () => mocks.state.tunnelListener?.(status));
const tunnelSwitch = () => screen.getByRole('switch', { name: 'settings.webui.tunnelLabel' });

const renderRow = async (tunnel: TunnelStatus = { state: 'stopped' }, webui: Partial<typeof baseStatus> = {}) => {
  mocks.getStatus.mockResolvedValue({ ...baseStatus, ...webui });
  mocks.getTunnelStatus.mockResolvedValue(tunnel);
  render(<WebuiModalContent />);
  await screen.findByText('settings.webui.tunnelLabel');
  await act(async () => {});
};

describe('WebuiModalContent secure link row', () => {
  beforeEach(() => {
    mocks.state.tunnelListener = null;
    mocks.startTunnel.mockResolvedValue({ success: true, status: { state: 'stopped' } });
    mocks.stopTunnel.mockResolvedValue({ success: true, status: { state: 'stopped' } });
    mocks.generateQRToken.mockResolvedValue({ token: 'TOK', expires_at_ms: 1_900_000_000_000 });
    Object.assign(navigator, { clipboard: { writeText: vi.fn(() => Promise.resolve()) } });
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('shows the label, help text and a switch', async () => {
    await renderRow();
    expect(screen.getByText('settings.webui.tunnelLabel')).toBeInTheDocument();
    expect(screen.getByText('settings.webui.tunnelDesc')).toBeInTheDocument();
    expect(tunnelSwitch()).not.toBeDisabled();
    expect(tunnelSwitch()).toHaveAttribute('aria-checked', 'false');
  });

  it('starts the link when turned on and keeps the switch on', async () => {
    await renderRow();
    fireEvent.click(tunnelSwitch());
    await waitFor(() => expect(mocks.startTunnel).toHaveBeenCalledTimes(1));
    await emitTunnel({ state: 'starting' });
    expect(tunnelSwitch()).toHaveAttribute('aria-checked', 'true');
  });

  it('turning it off calls stop', async () => {
    await renderRow({ state: 'running', url: TUNNEL_URL });
    expect(tunnelSwitch()).toHaveAttribute('aria-checked', 'true');
    fireEvent.click(tunnelSwitch());
    await waitFor(() => expect(mocks.stopTunnel).toHaveBeenCalledTimes(1));
    expect(mocks.startTunnel).not.toHaveBeenCalled();
  });

  it('renders each non-running state and stays on during an error', async () => {
    await renderRow();
    await emitTunnel({ state: 'downloading' });
    expect(screen.getByText('settings.webui.tunnelDownloading')).toBeInTheDocument();
    expect(tunnelSwitch()).toHaveAttribute('aria-checked', 'true');

    await emitTunnel({ state: 'starting' });
    expect(screen.getByText('settings.webui.tunnelStarting')).toBeInTheDocument();

    await emitTunnel({ state: 'error', message: 'cloudflared exited (1)' });
    expect(screen.getByText('settings.webui.tunnelError|cloudflared exited (1)')).toBeInTheDocument();
    expect(tunnelSwitch()).toHaveAttribute('aria-checked', 'true');

    await emitTunnel({ state: 'stopped' });
    expect(tunnelSwitch()).toHaveAttribute('aria-checked', 'false');
  });

  it('follows getStatus on mount', async () => {
    await renderRow({ state: 'error', message: 'boom' });
    expect(screen.getByText('settings.webui.tunnelError|boom')).toBeInTheDocument();
    expect(tunnelSwitch()).toHaveAttribute('aria-checked', 'true');
  });

  it('running shows the link, a copy button, the warning and a tunnel QR', async () => {
    await renderRow({ state: 'running', url: TUNNEL_URL });
    expect(screen.getByText(TUNNEL_URL)).toBeInTheDocument();
    expect(screen.getByText('settings.webui.tunnelWarning')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'settings.webui.tunnelCopyLink' }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(TUNNEL_URL);

    const qr = await screen.findByTestId('qr');
    expect(qr).toHaveAttribute('data-value', `${TUNNEL_URL}/qr-login?token=TOK`);
  });

  it('uses the tunnel URL for the QR when LAN access is on as well', async () => {
    await renderRow(
      { state: 'running', url: TUNNEL_URL },
      { allowRemote: true, networkUrl: 'http://192.168.1.5:25808' }
    );
    expect(await screen.findByTestId('qr')).toHaveAttribute('data-value', `${TUNNEL_URL}/qr-login?token=TOK`);
  });

  it('keeps the 4 minute QR refresh scheduled until the page unmounts', async () => {
    const setSpy = vi.spyOn(globalThis, 'setTimeout');
    const clearSpy = vi.spyOn(globalThis, 'clearTimeout');
    await renderRow({ state: 'running', url: TUNNEL_URL });
    await screen.findByTestId('qr');

    const refreshCall = setSpy.mock.calls.findIndex(([, delay]) => delay === 4 * 60 * 1000);
    expect(refreshCall).toBeGreaterThanOrEqual(0);
    const timerId = setSpy.mock.results[refreshCall].value;
    expect(clearSpy).not.toHaveBeenCalledWith(timerId);

    cleanup();
    expect(clearSpy).toHaveBeenCalledWith(timerId);
  });

  it('keeps the LAN QR when only LAN access is on, then swaps it when the link comes up', async () => {
    await renderRow({ state: 'stopped' }, { allowRemote: true, networkUrl: 'http://192.168.1.5:25808' });
    expect(await screen.findByTestId('qr')).toHaveAttribute(
      'data-value',
      'http://192.168.1.5:25808/qr-login?token=TOK'
    );

    await emitTunnel({ state: 'running', url: TUNNEL_URL });
    await waitFor(() =>
      expect(screen.getByTestId('qr')).toHaveAttribute('data-value', `${TUNNEL_URL}/qr-login?token=TOK`)
    );
  });

  it('shows no QR when neither LAN access nor the link is on', async () => {
    await renderRow({ state: 'starting' });
    expect(screen.queryByTestId('qr')).not.toBeInTheDocument();
    expect(mocks.generateQRToken).not.toHaveBeenCalled();
  });

  it('is disabled with a hint while the WebUI is off', async () => {
    await renderRow({ state: 'stopped' }, { running: false });
    expect(tunnelSwitch()).toBeDisabled();
    expect(screen.getByText('settings.webui.tunnelNeedsWebui')).toBeInTheDocument();
  });

  it('translates a webui-off refusal', async () => {
    mocks.startTunnel.mockResolvedValue({ success: false, code: 'webui-off' });
    await renderRow();
    fireEvent.click(tunnelSwitch());
    await waitFor(() => expect(mocks.messageError).toHaveBeenCalledWith('settings.webui.tunnelNeedsWebui'));
    expect(tunnelSwitch()).toHaveAttribute('aria-checked', 'false');
  });

  it('unsubscribes from status changes on unmount', async () => {
    await renderRow();
    cleanup();
    expect(mocks.unsubscribeTunnel).toHaveBeenCalledTimes(1);
  });
});
