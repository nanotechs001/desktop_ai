import { BUILTIN_BROWSER_MCP_NAME } from '@/common/config/constants';
import type { IMcpServer, ISessionMcpServer } from '@/common/config/storage';
import { toSessionMcpServer } from './catalog';

/** True only for the app's built-in browser record; a user server with the same name does not count. */
export const isBuiltinBrowserMcp = (server: Pick<IMcpServer, 'name' | 'builtin'>): boolean =>
  server.builtin === true && server.name === BUILTIN_BROWSER_MCP_NAME;

/**
 * Ensure the built-in browser MCP is part of a new conversation's session servers.
 * AionCore only injects the browser tools when it is listed here, so every
 * renderer-created conversation goes through this. Returns the input untouched
 * (and warns on every call) when the browser record is not in the catalog.
 */
export const withBrowserMcp = (selected: ISessionMcpServer[], available: IMcpServer[]): ISessionMcpServer[] => {
  const record = available.find(isBuiltinBrowserMcp);
  if (!record) {
    console.warn(`[withBrowserMcp] ${BUILTIN_BROWSER_MCP_NAME} is not in the MCP catalog; agents get no browser tools`);
    return selected;
  }
  if (selected.some((server) => server.id === record.id)) return selected;
  return [...selected, toSessionMcpServer(record)];
};
