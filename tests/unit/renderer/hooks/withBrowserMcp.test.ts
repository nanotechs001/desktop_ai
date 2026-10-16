import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IMcpServer, ISessionMcpServer } from '@/common/config/storage';
import { BUILTIN_BROWSER_MCP_NAME } from '@/common/config/constants';

const browserRecord = {
  id: 'builtin-browser-id',
  name: BUILTIN_BROWSER_MCP_NAME,
  enabled: true,
  builtin: true,
  transport: { type: 'stdio', command: 'node', args: ['browser-mcp.js'] },
} as IMcpServer;

const userRecord = { id: 'user-id', name: 'User MCP', enabled: true, builtin: false } as IMcpServer;
const userSession: ISessionMcpServer = { id: 'user-id', name: 'User MCP', transport: { type: 'stdio', command: 'x' } };

describe('withBrowserMcp', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.resetModules();
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('adds the aionui-browser session server when absent', async () => {
    const { withBrowserMcp } = await import('@/renderer/hooks/mcp/withBrowserMcp');
    const result = withBrowserMcp([userSession], [userRecord, browserRecord]);
    expect(result.map((s) => s.name)).toEqual(['User MCP', BUILTIN_BROWSER_MCP_NAME]);
    expect(result[1]).toEqual({ id: browserRecord.id, name: browserRecord.name, transport: browserRecord.transport });
  });

  it('does not duplicate it when already selected', async () => {
    const { withBrowserMcp } = await import('@/renderer/hooks/mcp/withBrowserMcp');
    const selected = [
      { id: browserRecord.id, name: browserRecord.name, transport: browserRecord.transport },
      userSession,
    ];
    const result = withBrowserMcp(selected, [browserRecord, userRecord]);
    expect(result).toEqual(selected);
  });

  it('returns input unchanged (and warns once) when the record is unavailable', async () => {
    const { withBrowserMcp } = await import('@/renderer/hooks/mcp/withBrowserMcp');
    const selected = [userSession];
    expect(withBrowserMcp(selected, [userRecord])).toBe(selected);
    expect(withBrowserMcp(selected, [])).toBe(selected);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('does not mutate its input', async () => {
    const { withBrowserMcp } = await import('@/renderer/hooks/mcp/withBrowserMcp');
    const selected = [userSession];
    withBrowserMcp(selected, [browserRecord]);
    expect(selected).toEqual([userSession]);
  });
});
