import { parseSkillProposal, type SkillProposal } from '@/common/types/agent/skillProposal';
import { BUILTIN_ARTIFACTS_MCP_NAME, BUILTIN_NOTES_MCP_NAME } from '@/common/config/constants';

/** What the chat card needs from an `aionui-artifacts` create/update call. */
export type ArtifactCardData = { title?: string; kind?: string; version: number; url: string };

const TOOL_NAME = /^(?:create|update)$/;
// `mcp__aionui-artifacts__create`, `aionui-artifacts.create`, `aionui-artifacts - update (MCP)`.
const QUALIFIED_TOOL_NAME = new RegExp(`(?:^|[^A-Za-z0-9-])${BUILTIN_ARTIFACTS_MCP_NAME}[\\W_]+(?:create|update)\\b`);

/** What the chat's "Saved to notebook" chip needs from an `aionui-notes` add call (old chats, and the `add` alias). */
export type NotebookChipData = { text: string; source: 'agent' | 'page' };

const MEMORY_ACTIONS = ['created', 'updated', 'superseded'] as const;
const MEMORY_SCOPES = ['own', 'shared'] as const;

/** What the chat's "Remembered" chip needs from an `aionui-notes` memory_save call. */
export type MemoryChipData = {
  kind: 'memory';
  action: (typeof MEMORY_ACTIONS)[number];
  /** `shared`: a fact about the user, in the memory every agent reads. */
  scope: (typeof MEMORY_SCOPES)[number];
  title: string;
};

/** A note the agent saved: to its old notebook, or to its memory. */
export type NoteChipData = NotebookChipData | MemoryChipData;

// `mcp__aionui-notes__add`, `aionui-notes.add`, `aionui-notes - add (MCP)`.
const QUALIFIED_NOTE_TOOL_NAME = new RegExp(`(?:^|[^A-Za-z0-9-])${BUILTIN_NOTES_MCP_NAME}[\\W_]+add\\b`);

// `mcp__aionui-notes__memory_save`, `aionui-notes.memory_save`, `aionui-notes - memory_save (MCP)`.
const QUALIFIED_MEMORY_TOOL_NAME = new RegExp(`(?:^|[^A-Za-z0-9-])${BUILTIN_NOTES_MCP_NAME}[\\W_]+memory_save\\b`);

// `mcp__aionui-notes__propose_skill`, `aionui-notes.propose_skill`, `aionui-notes - propose_skill (MCP)`.
const QUALIFIED_SKILL_TOOL_NAME = new RegExp(`(?:^|[^A-Za-z0-9-])${BUILTIN_NOTES_MCP_NAME}[\\W_]+propose_skill\\b`);

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

/**
 * Reads an add call of the built-in notes MCP: its result is the MCP's JSON `{ id, saved, text, source }`. Returns
 * undefined for any other call and for an error or malformed result.
 */
export const parseNoteToolCall = (
  name: string,
  output: string | undefined,
  server?: string
): NotebookChipData | undefined => {
  if (!QUALIFIED_NOTE_TOOL_NAME.test(name) && !(server === BUILTIN_NOTES_MCP_NAME && name === 'add')) return undefined;
  const result = parseResult(output);
  const text = asText(result?.text);
  const source = result?.source;
  if (result?.saved !== true || !text || (source !== 'agent' && source !== 'page')) return undefined;
  return { text, source };
};

const oneOf = <T extends string>(values: readonly T[], value: unknown): value is T =>
  (values as readonly unknown[]).includes(value);

/** The chip of a memory_save result `{ saved, action, scope, id, version, title }`, or undefined when it isn't one. */
const toMemoryChip = (result: Record<string, unknown> | undefined): MemoryChipData | undefined => {
  const title = asText(result?.title);
  if (result?.saved !== true || !title || !asText(result.id)) return undefined;
  if (!oneOf(MEMORY_ACTIONS, result.action) || !oneOf(MEMORY_SCOPES, result.scope)) return undefined;
  return { kind: 'memory', action: result.action, scope: result.scope, title };
};

/**
 * Reads a memory_save call of the built-in notes MCP from its JSON result. Returns undefined for any other call and
 * for an error or malformed result.
 */
export const parseMemorySaveToolCall = (
  name: string,
  output: string | undefined,
  server?: string
): MemoryChipData | undefined => {
  const isMemoryTool =
    QUALIFIED_MEMORY_TOOL_NAME.test(name) || (server === BUILTIN_NOTES_MCP_NAME && name === 'memory_save');
  return isMemoryTool ? toMemoryChip(parseResult(output)) : undefined;
};

/**
 * Reads a propose_skill call of the built-in notes MCP: the draft comes from the call input (an object, or a JSON
 * string). Returns undefined for any other call, for an error result and for a draft that fails validation.
 */
export const parseSkillProposalToolCall = (
  name: string,
  input: unknown,
  output: string | undefined,
  server?: string
): SkillProposal | undefined => {
  const isSkillTool =
    QUALIFIED_SKILL_TOOL_NAME.test(name) || (server === BUILTIN_NOTES_MCP_NAME && name === 'propose_skill');
  if (!isSkillTool || parseResult(output)?.isError === true) return undefined;
  return parseSkillProposal(typeof input === 'string' ? parseResult(input) : input);
};

/** What a tool call row shows for the built-in MCPs: an artifact card, a "Saved to notebook"/"Remembered" chip, a skill card. */
export type BuiltinToolCards = { artifact?: ArtifactCardData; note?: NoteChipData; skill?: SkillProposal };

/** Whether `record` (the whole call: names, input, wrapper metadata) mentions `word`, at any depth. */
const mentions = (record: unknown, word: string): boolean => {
  try {
    return JSON.stringify(record ?? '').includes(word);
  } catch {
    return false;
  }
};

/**
 * The built-in cards a tool call shows, for every engine. First by the tool's own name (Claude's `mcp__…`, Codex's
 * `server.tool`, a separate server field). Then by its result alone, for engines that wrap or rename MCP calls (OpenCode
 * runs them inside its `execute` tool): the result must be exactly the built-in's JSON, and the call must name the tool
 * somewhere, so page text or another tool's output never makes a card.
 */
export const detectBuiltinToolCards = (
  name: string,
  input: unknown,
  output: string | undefined,
  server?: string,
  record?: unknown
): BuiltinToolCards => {
  const call = { name, input, server, record };
  const result = parseResult(output);
  const fields = (typeof input === 'string' ? parseResult(input) : isRecord(input) ? input : undefined) ?? {};

  const artifact =
    parseArtifactToolCall(name, input, output, server) ??
    (result &&
    mentions(call, BUILTIN_ARTIFACTS_MCP_NAME) &&
    asText(result.url) &&
    asText(result.id) &&
    typeof result.version === 'number'
      ? {
          title: asText(fields.title),
          kind: asText(fields.kind),
          version: result.version,
          url: asText(result.url) as string,
        }
      : undefined);

  const noteText = asText(result?.text);
  const note =
    parseNoteToolCall(name, output, server) ??
    (result?.saved === true &&
    noteText &&
    (result.source === 'agent' || result.source === 'page') &&
    mentions(call, BUILTIN_NOTES_MCP_NAME)
      ? { text: noteText, source: result.source }
      : undefined) ??
    parseMemorySaveToolCall(name, output, server) ??
    (mentions(call, 'memory_save') ? toMemoryChip(result) : undefined);

  const skill =
    parseSkillProposalToolCall(name, input, output, server) ??
    (result?.proposed === true && mentions(call, 'propose_skill')
      ? parseSkillProposal({ name: result.name, description: result.description, steps: result.steps })
      : undefined);

  return { artifact, note, skill };
};
