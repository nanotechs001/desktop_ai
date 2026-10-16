import { BUILTIN_BROWSER_MCP_NAME } from '@/common/config/constants';
import type { IMcpServer, ISessionMcpServer } from '@/common/config/storage';
import { toSessionMcpServer } from './catalog';

let warnedMissingRecord = false;

/**
 * Ensure the built-in browser MCP is part of a new conversation's session servers.
 * AionCore only injects the browser tools when it is listed here, so every
 * renderer-created conversation goes through this. Returns the input untouched
 * when the browser record is not in the catalog (warns once).
 */
export const withBrowserMcp = (selected: ISessionMcpServer[], available: IMcpServer[]): ISessionMcpServer[] => {
  if (selected.some((server) => server.name === BUILTIN_BROWSER_MCP_NAME)) return selected;
  const record = available.find((server) => server.name === BUILTIN_BROWSER_MCP_NAME);
  if (!record) {
    if (!warnedMissingRecord) {
      warnedMissingRecord = true;
      console.warn(
        `[withBrowserMcp] ${BUILTIN_BROWSER_MCP_NAME} is not in the MCP catalog; agents get no browser tools`
      );
    }
    return selected;
  }
  return [...selected, toSessionMcpServer(record)];
};
