/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { IMcpServer, ISessionMcpServer } from '@/common/config/storage';
import { BUILTIN_BROWSER_MCP_NAME } from '@/common/config/constants';

const { getClientBusinessSettingMock, mcpServiceMock } = vi.hoisted(() => ({
  getClientBusinessSettingMock: vi.fn(),
  mcpServiceMock: {
    listServers: { invoke: vi.fn() },
  },
}));

vi.mock('@/renderer/services/clientBusinessSettings', () => ({
  getClientBusinessSetting: getClientBusinessSettingMock,
}));

vi.mock('@/common/adapter/ipcBridge', () => ({
  mcpService: mcpServiceMock,
}));

import { ensureBackendMcpCatalog } from '@/renderer/hooks/mcp/catalog';
import { isBuiltinBrowserMcp, withBrowserMcp } from '@/renderer/hooks/mcp/withBrowserMcp';

describe('ensureBackendMcpCatalog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getClientBusinessSettingMock.mockResolvedValue([]);
    mcpServiceMock.listServers.invoke.mockResolvedValue([
      {
        id: 'user-1',
        name: 'user one',
        enabled: true,
        transport: { type: 'stdio', command: 'user', args: [] },
        created_at: 2,
        updated_at: 2,
        original_json: '{}',
        builtin: false,
      },
    ]);
  });

  it('reads MCP catalog from backend settings without falling back to configService', async () => {
    getClientBusinessSettingMock.mockResolvedValue([
      {
        id: 'builtin-1',
        name: 'builtin one',
        enabled: true,
        transport: { type: 'stdio', command: 'builtin', args: [] },
        created_at: 1,
        updated_at: 1,
        original_json: '{}',
        builtin: true,
      },
    ]);

    const result = await ensureBackendMcpCatalog();

    expect(result.userServers).toHaveLength(1);
    expect(result.builtinServers).toHaveLength(1);
    expect(result.allServers).toHaveLength(2);
  });

  it('does not re-import legacy user MCP rows from backend client settings at runtime', async () => {
    getClientBusinessSettingMock.mockResolvedValue([
      {
        id: 'legacy-user-1',
        name: 'legacy user server',
        enabled: true,
        transport: { type: 'stdio', command: 'legacy-user', args: [] },
        created_at: 1,
        updated_at: 1,
        original_json: '{}',
        builtin: false,
      },
    ]);
    mcpServiceMock.listServers.invoke.mockResolvedValue([]);

    const result = await ensureBackendMcpCatalog();

    expect(result.userServers).toEqual([]);
    expect(result.builtinServers).toEqual([]);
    expect(result.allServers).toEqual([]);
  });
});

describe('withBrowserMcp', () => {
  const browserRecord = {
    id: 'builtin-browser-id',
    name: BUILTIN_BROWSER_MCP_NAME,
    enabled: true,
    builtin: true,
    transport: { type: 'stdio', command: 'node', args: ['browser-mcp.js'] },
  } as IMcpServer;
  const userRecord = { id: 'user-id', name: 'User MCP', enabled: true, builtin: false } as IMcpServer;
  const userSession: ISessionMcpServer = {
    id: 'user-id',
    name: 'User MCP',
    transport: { type: 'stdio', command: 'x' },
  };
  const browserSession: ISessionMcpServer = {
    id: browserRecord.id,
    name: browserRecord.name,
    transport: browserRecord.transport,
  };
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('adds the aionui-browser session server when absent', () => {
    const result = withBrowserMcp([userSession], [userRecord, browserRecord]);
    expect(result).toEqual([userSession, browserSession]);
  });

  it('does not duplicate it when already selected', () => {
    const selected = [browserSession, userSession];
    expect(withBrowserMcp(selected, [browserRecord, userRecord])).toEqual(selected);
  });

  it('returns input unchanged and warns on every call when the record is unavailable', () => {
    const selected = [userSession];
    expect(withBrowserMcp(selected, [userRecord])).toBe(selected);
    expect(withBrowserMcp(selected, [])).toBe(selected);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('does not mutate its input', () => {
    const selected = [userSession];
    withBrowserMcp(selected, [browserRecord]);
    expect(selected).toEqual([userSession]);
  });

  it('does not treat a user server named aionui-browser as the built-in', () => {
    const impostor = { id: 'impostor', name: BUILTIN_BROWSER_MCP_NAME, builtin: false } as IMcpServer;
    expect(isBuiltinBrowserMcp(impostor)).toBe(false);
    const impostorSession: ISessionMcpServer = {
      id: 'impostor',
      name: impostor.name,
      transport: browserRecord.transport,
    };
    expect(withBrowserMcp([impostorSession], [impostor, browserRecord])).toEqual([impostorSession, browserSession]);
    expect(withBrowserMcp([], [impostor])).toEqual([]);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });
});
