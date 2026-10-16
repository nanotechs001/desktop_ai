import { BUILTIN_ARTIFACTS_MCP_NAME } from '@/common/config/constants';

/** What the chat card needs from an `aionui-artifacts` create/update call. */
export type ArtifactCardData = { title?: string; kind?: string; version: number; url: string };

const TOOL_NAME = /^(?:create|update)$/;
// `mcp__aionui-artifacts__create`, `aionui-artifacts.create`, `aionui-artifacts - update (MCP)`.
const QUALIFIED_TOOL_NAME = new RegExp(`(?:^|[^A-Za-z0-9-])${BUILTIN_ARTIFACTS_MCP_NAME}[\\W_]+(?:create|update)\\b`);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const asText = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

const parseResult = (output: string | undefined): Record<string, unknown> | undefined => {
  try {
    const parsed: unknown = JSON.parse(output ?? '');
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
};

/**
 * Reads a create/update call of the built-in artifacts MCP. `name` is the engine's tool name (it may carry the
 * server) and `server` the separate server field some engines send. The result text is the MCP's JSON
 * `{ id, version, url }`; title and kind come from the call input (an object, or a JSON string). Returns undefined for any other call and for
 * a missing or malformed result, so the caller falls back to the plain tool row.
 */
export const parseArtifactToolCall = (
  name: string,
  input: unknown,
  output: string | undefined,
  server?: string
): ArtifactCardData | undefined => {
  const isArtifactTool =
    QUALIFIED_TOOL_NAME.test(name) || (server === BUILTIN_ARTIFACTS_MCP_NAME && TOOL_NAME.test(name));
  if (!isArtifactTool) return undefined;
  const result = parseResult(output);
  const url = asText(result?.url);
  if (!result || !url || typeof result.version !== 'number' || !asText(result.id)) return undefined;
  // Some engines hand the input over as text (a JSON string, or just a description).
  const fields = (typeof input === 'string' ? parseResult(input) : isRecord(input) ? input : undefined) ?? {};
  return { title: asText(fields.title), kind: asText(fields.kind), version: result.version, url };
};
