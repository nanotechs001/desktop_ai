import type { IMessageAcpToolCall, IMessageToolCall, IMessageToolGroup } from './chatLib';
import { getAcpImagePath } from './acpToolCallOutput';
import {
  detectBuiltinToolCards,
  type BuiltinToolCards,
  type ArtifactCardData,
  type NoteChipData,
} from './artifactToolCall';
import type { SkillProposal } from '@/common/types/agent/skillProposal';

export type NormalizedToolStatus = 'pending' | 'running' | 'completed' | 'error' | 'canceled';

export interface NormalizedToolCall {
  key: string;
  name: string;
  status: NormalizedToolStatus;
  description?: string;
  input?: string;
  output?: string;
  truncated?: boolean;
  messageId?: string;
  conversationId?: string;
  imagePath?: string;
  /** Set for a finished create/update call of the artifacts MCP; the summary renders a card for it. */
  artifact?: ArtifactCardData;
  /** Set for a finished save of the notes MCP: an old notebook add ("Saved to notebook" chip) or a memory_save (memory chip). */
  note?: NoteChipData;
  /** Set for a finished propose_skill call of the notes MCP; the summary renders a review card for it. */
  skill?: SkillProposal;
}

const formatValue = (value: unknown): string => {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
};

const hasKeys = (value: Record<string, unknown> | undefined): boolean => Object.keys(value ?? {}).length > 0;

// ===== tool_group → NormalizedToolCall[] =====

function normalizeToolGroupStatus(status: string): NormalizedToolStatus {
  switch (status) {
    case 'Success':
      return 'completed';
    case 'Error':
      return 'error';
    case 'Canceled':
      return 'canceled';
    case 'Pending':
      return 'pending';
    case 'Executing':
    case 'Confirming':
    default:
      return 'running';
  }
}

const getResultDisplayText = (
  result_display: IMessageToolGroup['content'][0]['result_display']
): string | undefined => {
  if (!result_display) return undefined;
  if (typeof result_display === 'string') return result_display;
  if ('file_diff' in result_display) return result_display.file_diff;
  if ('img_url' in result_display) return result_display.relative_path || result_display.img_url;
  return undefined;
};

export function normalizeToolGroup(message: IMessageToolGroup): NormalizedToolCall[] {
  if (!Array.isArray(message.content)) return [];
  return message.content.map(({ name, call_id, description, confirmationDetails, status, result_display }) => {
    let desc = typeof description === 'string' ? description.slice(0, 100) : '';
    const type = confirmationDetails?.type;
    if (type === 'edit') desc = confirmationDetails.file_name;
    if (type === 'exec') desc = confirmationDetails.command;
    if (type === 'info') desc = confirmationDetails.urls?.join(';') || confirmationDetails.title;
    if (type === 'mcp') desc = confirmationDetails.server_name + ':' + confirmationDetails.tool_name;

    let input: string | undefined;
    if (confirmationDetails) {
      const { title: _title, type: _type, ...rest } = confirmationDetails;
      if (Object.keys(rest).length) input = formatValue(rest);
    } else if (description) {
      input = description;
    }

    return {
      key: call_id,
      name,
      status: normalizeToolGroupStatus(status),
      description: desc,
      input,
      output: getResultDisplayText(result_display),
      ...detectBuiltinToolCards(
        name,
        input,
        getResultDisplayText(result_display),
        type === 'mcp' ? confirmationDetails.server_name : undefined,
        confirmationDetails
      ),
    };
  });
}

// ===== acp_tool_call → NormalizedToolCall =====

function normalizeAcpStatus(status: string): NormalizedToolStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'error';
    case 'in_progress':
      return 'running';
    case 'pending':
    default:
      return 'pending';
  }
}

const buildParamSummary = (kind: string, rawInput?: Record<string, unknown>): string | undefined => {
  if (!rawInput) return undefined;

  if (kind === 'read' || kind === 'edit') {
    return (rawInput.file_path as string) || (rawInput.path as string) || (rawInput.file_name as string);
  }
  if (kind === 'execute') {
    return rawInput.command as string;
  }
  if (kind === 'search' || kind === 'grep') {
    const parts: string[] = [];
    if (rawInput.pattern) parts.push(`"${rawInput.pattern}"`);
    if (rawInput.path) parts.push(`in ${rawInput.path}`);
    else if (rawInput.glob) parts.push(`in ${rawInput.glob}`);
    return parts.length > 0 ? parts.join(' ') : undefined;
  }
  if (kind === 'glob') {
    const parts: string[] = [];
    if (rawInput.pattern) parts.push(`${rawInput.pattern}`);
    if (rawInput.path) parts.push(`in ${rawInput.path}`);
    return parts.length > 0 ? parts.join(' ') : undefined;
  }
  if (kind === 'write') {
    return (rawInput.file_path as string) || (rawInput.path as string);
  }

  for (const key of ['file_path', 'command', 'path', 'pattern', 'query', 'url']) {
    if (rawInput[key] && typeof rawInput[key] === 'string') return rawInput[key] as string;
  }
  return undefined;
};

type AcpToolCallUpdateCompat = IMessageAcpToolCall['content']['update'] & {
  session_update?: string;
  raw_input?: Record<string, unknown>;
  raw_output?: unknown;
  rawOutput?: unknown;
};

type NestedToolCall = { tool: string; input: unknown };

/**
 * The MCP calls a code-mode tool made: OpenCode runs MCP tools inside its own `execute` tool and lists them in
 * `raw_output.metadata.tool_calls` (`{ tool: 'aionui-notes.add', status, input }`). Completed ones only, last first.
 */
const nestedToolCalls = (rawOutput: unknown): NestedToolCall[] => {
  const calls = (rawOutput as { metadata?: { tool_calls?: unknown } } | undefined)?.metadata?.tool_calls;
  if (!Array.isArray(calls)) return [];
  return calls
    .filter(
      (call): call is { tool: string; status?: unknown; input?: unknown } =>
        typeof call === 'object' && call !== null && typeof (call as { tool?: unknown }).tool === 'string'
    )
    .filter((call) => call.status === undefined || call.status === 'completed')
    .map((call) => ({ tool: call.tool, input: call.input }))
    .toReversed();
};

/** `cards` filled in from the code-mode calls (last first): the script's return value is its last call's result. */
const withNested = (cards: BuiltinToolCards, calls: NestedToolCall[], output: string | undefined): BuiltinToolCards => {
  let filled = cards;
  for (const call of calls) {
    const found = detectBuiltinToolCards(call.tool, call.input, output);
    filled = {
      artifact: filled.artifact ?? found.artifact,
      note: filled.note ?? found.note,
      skill: filled.skill ?? found.skill,
    };
  }
  return filled;
};

type AcpToolCallContentCompat = IMessageAcpToolCall['content'] & {
  _compact?: {
    truncated?: boolean;
    original_size?: number;
    preview_chars?: number;
  };
  update?: AcpToolCallUpdateCompat;
};

export function normalizeAcpToolCall(message: IMessageAcpToolCall): NormalizedToolCall | undefined {
  const content = message.content as AcpToolCallContentCompat | undefined;
  const update = content?.update;
  if (!update) return undefined;

  const rawInput = update.rawInput ?? update.raw_input;
  const input = rawInput ? formatValue(rawInput) : undefined;

  let output: string | undefined;
  if (Array.isArray(update.content) && update.content.length) {
    output = update.content
      .map((item) => {
        if (typeof item !== 'object' || item === null) return '';
        if (item.type === 'content' && item.content?.text) return item.content.text;
        if (item.type === 'diff' && 'path' in item) return `[diff] ${item.path}`;
        return '';
      })
      .filter(Boolean)
      .join('\n');
  }

  const keyParam = buildParamSummary(update.kind, rawInput);
  const nested = nestedToolCalls(update.rawOutput ?? update.raw_output);

  return {
    key: update.tool_call_id,
    name: update.title,
    status: normalizeAcpStatus(update.status),
    description: keyParam || (rawInput?.command as string) || update.kind,
    input,
    output,
    truncated: content?._compact?.truncated === true,
    messageId: message.id,
    conversationId: message.conversation_id,
    imagePath: getAcpImagePath(update),
    ...withNested(detectBuiltinToolCards(update.title, rawInput, output, undefined, update), nested, output),
  };
}

// ===== tool_call → NormalizedToolCall =====

function normalizeToolCallStatus(status?: string): NormalizedToolStatus {
  switch (status) {
    case 'completed':
      return 'completed';
    case 'error':
      return 'error';
    case 'running':
      return 'running';
    case 'canceled':
      return 'canceled';
    default:
      return 'pending';
  }
}

export function normalizeToolCall(message: IMessageToolCall): NormalizedToolCall | undefined {
  const { call_id, name, status, input, output, args, description } = message.content;
  if (!call_id) return undefined;

  const displayInput = input
    ? formatValue(input)
    : args && Object.keys(args).length > 0
      ? formatValue(args)
      : undefined;

  return {
    key: call_id,
    name,
    status: normalizeToolCallStatus(status),
    description: description || undefined,
    input: displayInput,
    output,
    ...detectBuiltinToolCards(name, hasKeys(input) ? input : args, output, undefined, message.content),
  };
}

// ===== Unified entry =====

export type ToolMessage = IMessageToolGroup | IMessageAcpToolCall | IMessageToolCall;

export function normalizeToolMessages(messages: ToolMessage[]): NormalizedToolCall[] {
  return messages
    .flatMap((m) => {
      if (m.type === 'tool_group') return normalizeToolGroup(m);
      if (m.type === 'acp_tool_call') return normalizeAcpToolCall(m);
      if (m.type === 'tool_call') return normalizeToolCall(m);
      return undefined;
    })
    .filter((item): item is NormalizedToolCall => item !== undefined);
}

export function hasRunningToolMessages(messages: ToolMessage[]): boolean {
  return messages.some((m) => {
    if (m.type === 'tool_group') {
      return Array.isArray(m.content) && m.content.some((t) => normalizeToolGroupStatus(t.status) === 'running');
    }
    if (m.type === 'acp_tool_call') {
      return m.content?.update && normalizeAcpStatus(m.content.update.status) === 'running';
    }
    if (m.type === 'tool_call') {
      return normalizeToolCallStatus(m.content?.status) === 'running';
    }
    return false;
  });
}
