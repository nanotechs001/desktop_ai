/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 *
 * MCP OAuth login: a failed sign-in must surface its reason on the server row,
 * and a successful one must refresh the status from the backend.
 */

import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { mcpService } from '@/common/adapter/ipcBridge';
import type { IMcpServer } from '@/common/config/storage';
import { useMcpOAuth } from '@/renderer/hooks/mcp/useMcpOAuth';
import McpServerHeader from '@/renderer/pages/settings/ToolsSettings/McpServerHeader';

const platform = vi.hoisted(() => ({ desktop: true }));
vi.mock('@/renderer/utils/platform', () => ({ isElectronDesktop: () => platform.desktop }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { error?: string }) => (options?.error ? `${key}|${options.error}` : key),
    i18n: { language: 'en' },
  }),
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  mcpService: {
    loginMcpOAuth: { invoke: vi.fn() },
    checkOAuthStatus: { invoke: vi.fn() },
    logoutMcpOAuth: { invoke: vi.fn() },
  },
}));

const server: IMcpServer = {
  id: 'srv-1',
  name: 'BugHerd',
  transport: { type: 'streamable_http', url: 'https://mcp.bugherd.com/mcp' },
} as unknown as IMcpServer;

describe('useMcpOAuth login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps the failure reason on the server status when the backend reports failure', async () => {
    vi.mocked(mcpService.loginMcpOAuth.invoke).mockResolvedValue({
      success: false,
      error: 'OAuth error: Token exchange failed: invalid_grant',
    });
    const { result } = renderHook(() => useMcpOAuth());
    act(() => result.current.markLoginRequired(server.id));

    let outcome: { success: boolean; error?: string } | undefined;
    await act(async () => {
      outcome = await result.current.login(server);
    });

    expect(outcome).toEqual({ success: false, error: 'OAuth error: Token exchange failed: invalid_grant' });
    expect(result.current.oauthStatus[server.id]).toMatchObject({
      needsLogin: true,
      isAuthenticated: false,
      error: 'OAuth error: Token exchange failed: invalid_grant',
    });
    expect(result.current.loggingIn[server.id]).toBe(false);
  });

  it('keeps the failure reason when the login request throws', async () => {
    vi.mocked(mcpService.loginMcpOAuth.invoke).mockRejectedValue(new Error('backend unreachable'));
    const { result } = renderHook(() => useMcpOAuth());

    await act(async () => {
      await result.current.login(server);
    });

    expect(result.current.oauthStatus[server.id]?.error).toBe('backend unreachable');
    expect(result.current.oauthStatus[server.id]?.needsLogin).toBe(true);
  });

  it('refreshes the status from the backend after a successful login', async () => {
    vi.mocked(mcpService.loginMcpOAuth.invoke).mockResolvedValue({ success: true });
    vi.mocked(mcpService.checkOAuthStatus.invoke).mockResolvedValue({ authenticated: true });
    const { result } = renderHook(() => useMcpOAuth());
    act(() => result.current.markLoginRequired(server.id));

    await act(async () => {
      await result.current.login(server);
    });

    expect(mcpService.checkOAuthStatus.invoke).toHaveBeenCalledWith({ server_url: 'https://mcp.bugherd.com/mcp' });
    expect(result.current.oauthStatus[server.id]).toMatchObject({
      isAuthenticated: true,
      needsLogin: false,
      isChecking: false,
    });
    expect(result.current.oauthStatus[server.id]?.error).toBeUndefined();
  });
});

describe('McpServerHeader OAuth failure', () => {
  it('shows the sign-in failure reason inline on the server row', () => {
    render(
      <McpServerHeader
        server={server}
        isTestingConnection={false}
        oauthStatus={{ isAuthenticated: false, needsLogin: true, isChecking: false, error: 'code expired' }}
        onTestConnection={vi.fn()}
        onEditServer={vi.fn()}
        onDeleteServer={vi.fn()}
        onOAuthLogin={vi.fn()}
      />
    );

    expect(screen.getByText('settings.mcpOAuthLoginFailedWithReason|code expired')).toBeTruthy();
  });

  it('shows no failure text without an error', () => {
    render(
      <McpServerHeader
        server={server}
        isTestingConnection={false}
        oauthStatus={{ isAuthenticated: false, needsLogin: true, isChecking: false }}
        onTestConnection={vi.fn()}
        onEditServer={vi.fn()}
        onDeleteServer={vi.fn()}
        onOAuthLogin={vi.fn()}
      />
    );

    expect(screen.queryByText(/mcpOAuthLoginFailedWithReason/)).toBeNull();
  });
});

describe('MCP OAuth from the WebUI (M12)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    platform.desktop = false;
  });
  afterEach(() => {
    cleanup();
    platform.desktop = true;
  });

  const renderHeader = () =>
    render(
      <McpServerHeader
        server={server}
        isTestingConnection={false}
        oauthStatus={{ isAuthenticated: false, needsLogin: true, isChecking: false }}
        onTestConnection={vi.fn()}
        onEditServer={vi.fn()}
        onDeleteServer={vi.fn()}
        onOAuthLogin={vi.fn()}
      />
    );

  it('disables Login and says to sign in on the desktop app', () => {
    renderHeader();

    const login = screen.getByRole('button', { name: /settings\.mcpLogin/ });
    expect(login.hasAttribute('disabled')).toBe(true);
    expect(screen.getByText('settings.mcpLoginDesktopOnly')).toBeTruthy();
  });

  it('keeps Login enabled on the desktop app', () => {
    platform.desktop = true;
    renderHeader();

    expect(screen.getByRole('button', { name: /settings\.mcpLogin/ }).hasAttribute('disabled')).toBe(false);
    expect(screen.queryByText('settings.mcpLoginDesktopOnly')).toBeNull();
  });

  it('never starts a sign-in, which would open a browser on the desktop', async () => {
    const { result } = renderHook(() => useMcpOAuth());

    let outcome: { success: boolean; error?: string } | undefined;
    await act(async () => {
      outcome = await result.current.login(server);
    });

    expect(mcpService.loginMcpOAuth.invoke).not.toHaveBeenCalled();
    expect(outcome?.success).toBe(false);
  });
});
