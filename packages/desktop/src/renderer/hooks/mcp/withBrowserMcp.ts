import { BUILTIN_ARTIFACTS_MCP_NAME, BUILTIN_BROWSER_MCP_NAME } from '@/common/config/constants';
import type { IMcpServer, ISessionMcpServer } from '@/common/config/storage';
import { toSessionMcpServer } from './catalog';

/** Built-in MCP servers attached to every conversation. */
const BUILTIN_SESSION_MCP_NAMES: readonly string[] = [BUILTIN_BROWSER_MCP_NAME, BUILTIN_ARTIFACTS_MCP_NAME];

type BuiltinCandidate = Pick<IMcpServer, 'name' | 'builtin'>;

/** True only for an app built-in record named `name`; a user server with the same name does not count. */
const isBuiltinNamed = (server: BuiltinCandidate, name: string): boolean =>
  server.builtin === true && server.name === name;

/** True only for the app's built-in browser record. */
export const isBuiltinBrowserMcp = (server: BuiltinCandidate): boolean =>
  isBuiltinNamed(server, BUILTIN_BROWSER_MCP_NAME);

/** True for any built-in record attached to every conversation (browser, artifacts); its picker row is locked on. */
export const isBuiltinSessionMcp = (server: BuiltinCandidate): boolean =>
  BUILTIN_SESSION_MCP_NAMES.some((name) => isBuiltinNamed(server, name));

/** True when the catalog holds a built-in record for every session MCP (browser, artifacts). */
export const hasAllBuiltinSessionMcps = (available: IMcpServer[]): boolean =>
  BUILTIN_SESSION_MCP_NAMES.every((name) => available.some((server) => isBuiltinNamed(server, name)));

/**
 * Ensure the built-in session MCPs (browser, artifacts) are part of a new conversation's session servers.
 * AionCore only injects their tools when they are listed here, so every renderer-created conversation goes
 * through this. A record missing from the catalog is skipped with one warning per call.
 */
export const withBrowserMcp = (selected: ISessionMcpServer[], available: IMcpServer[]): ISessionMcpServer[] => {
  const records = BUILTIN_SESSION_MCP_NAMES.map((name) => ({
    name,
    record: available.find((server) => isBuiltinNamed(server, name)),
  }));
  const missing = records.filter(({ record }) => !record).map(({ name }) => name);
  const added = records.flatMap(({ record }) =>
    record && !selected.some((server) => server.id === record.id) ? [toSessionMcpServer(record)] : []
  );
  if (missing.length > 0) {
    console.warn(`[withBrowserMcp] ${missing.join(', ')} not in the MCP catalog; agents get no such tools`);
  }
  return added.length > 0 ? [...selected, ...added] : selected;
};
