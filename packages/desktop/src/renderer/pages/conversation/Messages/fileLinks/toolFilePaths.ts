/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { IMessageAcpToolCall, IMessageToolCall, IMessageToolGroup } from '@/common/chat/chatLib';

/** Tool messages that can carry file paths an agent wrote. */
export type FileToolMessage = IMessageAcpToolCall | IMessageToolCall | IMessageToolGroup;

/**
 * Extensions the preview pane renders as a document (html / word / ppt / excel /
 * pdf / markdown). Everything else — source code, images, csv — is deliberately
 * left out: the chips are for documents the user asked the agent to produce.
 */
export const PREVIEWABLE_DOCUMENT_EXTENSIONS: ReadonlySet<string> = new Set([
  'html',
  'htm',
  'docx',
  'pptx',
  'xlsx',
  'pdf',
  'md',
]);

/** One file a tool call created or edited. */
export type ToolFileTarget = {
  /** Path as the agent wrote it: absolute, or relative to the workspace. */
  path: string;
  /** Stable per tool call (tool_call_id / call_id), shared by every path of that call. */
  toolKey: string;
  /** The tool call finished successfully. Only completed calls produce chips. */
  completed: boolean;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const getExtension = (path: string): string => {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
};

/** True when `path` ends in one of {@link PREVIEWABLE_DOCUMENT_EXTENSIONS} (case-insensitive). */
export const isPreviewableDocumentPath = (path: string): boolean =>
  PREVIEWABLE_DOCUMENT_EXTENSIONS.has(getExtension(path.trim()));

/** Absolute POSIX (`/x`), Windows drive (`C:\x`, `C:/x`) or UNC (`\\host\x`) path. */
export const isAbsolutePath = (path: string): boolean =>
  path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');

/** File name part of a path, either separator. */
export const getPathBaseName = (path: string): string => path.split(/[\\/]/).pop() || path;

/**
 * Comparison key for de-duplication: separators unified, `./` dropped, and
 * case-folded (two spellings of one path on a case-insensitive disk are one file;
 * the opposite mistake — hiding a second chip on Linux — is harmless).
 */
export const getPathKey = (path: string): string =>
  path
    .trim()
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+/g, '/')
    .toLowerCase();

/** Join a `cd` target with a relative path; absolute paths win. */
const joinDir = (dir: string | undefined, path: string): string => {
  if (!dir || isAbsolutePath(path)) return path;
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}${path.replace(/^\.[\\/]/, '')}`;
};

const asString = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() ? value.trim() : undefined;

// ===== Shell command parsing =====

type ShellToken = { kind: 'word'; value: string } | { kind: 'op'; value: string };

/**
 * Minimal shell tokenizer: quotes group words, and `&& || ; | > >>` plus newlines
 * become operator tokens. Backslash is kept literal on purpose — on Windows it is
 * the path separator, and treating it as an escape would mangle `C:\Users\...`.
 */
export const tokenizeShellCommand = (command: string): ShellToken[] => {
  const tokens: ShellToken[] = [];
  let current = '';
  let hasWord = false;
  let quote: '"' | "'" | null = null;

  const pushWord = () => {
    if (hasWord) tokens.push({ kind: 'word', value: current });
    current = '';
    hasWord = false;
  };

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      hasWord = true;
      continue;
    }
    if (ch === ' ' || ch === '\t') {
      pushWord();
      continue;
    }
    if (ch === '\n' || ch === '\r' || ch === ';') {
      pushWord();
      tokens.push({ kind: 'op', value: ';' });
      continue;
    }
    if (ch === '&' || ch === '|' || ch === '>') {
      pushWord();
      const next = command[i + 1];
      if (next === ch) {
        tokens.push({ kind: 'op', value: ch + ch });
        i++;
      } else {
        tokens.push({ kind: 'op', value: ch });
      }
      continue;
    }
    current += ch;
    hasWord = true;
  }
  pushWord();
  return tokens;
};

/**
 * officecli verbs that only read a document. Every other officecli verb (create,
 * add, set, remove, …) is treated as writing the document arguments it names.
 */
const OFFICECLI_READ_ONLY_VERBS = new Set([
  'view',
  'get',
  'query',
  'read',
  'show',
  'info',
  'list',
  'validate',
  'check',
  'help',
  'watch',
  'unwatch',
]);

/** Flags whose value is an output file, for any command (`pandoc -o out.docx`). */
const OUTPUT_FLAGS = new Set(['-o', '--output', '--out', '--outfile', '--output-file']);

const getCommandName = (word: string): string =>
  getPathBaseName(word)
    .toLowerCase()
    .replace(/\.(exe|cmd|bat)$/, '');

/** Output files named in one simple command (the words between operators). */
const extractFromSimpleCommand = (words: string[]): string[] => {
  if (words.length === 0) return [];
  const name = getCommandName(words[0]);
  const args = words.slice(1);
  const found: string[] = [];

  if (name === 'officecli') {
    const verb = args[0]?.toLowerCase();
    if (verb && !verb.startsWith('-') && !OFFICECLI_READ_ONLY_VERBS.has(verb)) {
      for (const arg of args.slice(1)) {
        const value = arg.startsWith('-') && arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : arg;
        if (!value.startsWith('-') && isPreviewableDocumentPath(value)) found.push(value);
      }
    }
    return found;
  }

  // `cp a b.html` / `mv a b.html`: the destination is the last argument.
  if (name === 'cp' || name === 'mv' || name === 'copy' || name === 'move') {
    const dest = [...args].toReversed().find((arg) => !arg.startsWith('-'));
    if (dest && isPreviewableDocumentPath(dest)) found.push(dest);
    return found;
  }

  if (name === 'tee') {
    for (const arg of args) if (!arg.startsWith('-') && isPreviewableDocumentPath(arg)) found.push(arg);
    return found;
  }

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const eq = arg.indexOf('=');
    if (eq > 0 && OUTPUT_FLAGS.has(arg.slice(0, eq))) {
      const value = arg.slice(eq + 1);
      if (isPreviewableDocumentPath(value)) found.push(value);
      continue;
    }
    if (OUTPUT_FLAGS.has(arg) && args[i + 1] && isPreviewableDocumentPath(args[i + 1])) {
      found.push(args[i + 1]);
      i++;
    }
  }
  return found;
};

/**
 * Document files a shell command clearly writes. Conservative by design: only
 * officecli write verbs, output redirection (`>`/`>>`), `tee`, `cp`/`mv`
 * destinations and `-o`/`--output` flag values — a path that is merely
 * mentioned (`cat report.md`) is never reported. A preceding `cd <dir>` is
 * applied to relative paths.
 */
export const extractWrittenFilesFromCommand = (command: string): string[] => {
  const tokens = tokenizeShellCommand(command);
  const found: string[] = [];
  let cwd: string | undefined;
  let words: string[] = [];

  const flush = () => {
    if (words.length >= 2 && getCommandName(words[0]) === 'cd') {
      cwd = joinDir(cwd, words[1]);
    } else {
      for (const path of extractFromSimpleCommand(words)) found.push(joinDir(cwd, path));
    }
    words = [];
  };

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token.kind === 'word') {
      words.push(token.value);
      continue;
    }
    if (token.value === '>' || token.value === '>>') {
      const target = tokens[i + 1];
      if (target?.kind === 'word') {
        // `2>` / `1>`: the fd number was read as the last word.
        if (words.length > 0 && /^\d$/.test(words[words.length - 1])) words.pop();
        if (isPreviewableDocumentPath(target.value)) found.push(joinDir(cwd, target.value));
        i++;
      }
      continue;
    }
    flush();
  }
  flush();
  return found;
};

const commandToString = (value: unknown): string | undefined => {
  if (typeof value === 'string') return value;
  if (Array.isArray(value) && value.every((part) => typeof part === 'string')) {
    // Codex-style argv (`["bash", "-lc", "<script>"]`): the script is the last part.
    const parts = value as string[];
    const shellIndex = parts.findIndex((part) => part === '-c' || part === '-lc' || part === '-Command');
    return shellIndex >= 0 && parts[shellIndex + 1] ? parts.slice(shellIndex + 1).join(' ') : parts.join(' ');
  }
  return undefined;
};

/** Paths named by common file-path keys of a tool's input object. */
const pathsFromInput = (input: Record<string, unknown> | undefined): string[] => {
  if (!input) return [];
  const paths: string[] = [];
  for (const key of ['file_path', 'filePath', 'path', 'target_file', 'notebook_path', 'absolute_path']) {
    const value = asString(input[key]);
    if (value) paths.push(value);
  }
  return paths;
};

// ===== Per-message extraction =====

type ToolCategory = 'write' | 'execute' | 'other';

/** Categorise a free-form tool name (aionrs / MCP style). */
export const categorizeToolName = (name: string): ToolCategory => {
  const lower = name.toLowerCase();
  if (/(^|[_\s-])(read|view|glob|grep|search|list|find|fetch|open)([_\s-]|$)/.test(lower) || /^(read|ls)/.test(lower))
    return 'other';
  if (/write|edit|create|save|str_replace|apply_patch|patch/.test(lower)) return 'write';
  if (/bash|shell|exec|run_command|terminal|powershell|command/.test(lower)) return 'execute';
  return 'other';
};

type AcpUpdateCompat = IMessageAcpToolCall['content']['update'] & { raw_input?: Record<string, unknown> };

const fromAcp = (message: IMessageAcpToolCall): ToolFileTarget[] => {
  const update = message.content?.update as AcpUpdateCompat | undefined;
  if (!update) return [];
  const kind = String(update.kind ?? '');
  const rawInput = isRecord(update.rawInput)
    ? update.rawInput
    : isRecord(update.raw_input)
      ? update.raw_input
      : undefined;
  const toolKey = update.tool_call_id || message.id;
  const completed = update.status === 'completed';
  const paths: string[] = [];

  if (kind === 'edit' || kind === 'write') {
    for (const item of Array.isArray(update.content) ? update.content : []) {
      if (isRecord(item) && item.type === 'diff' && typeof item.path === 'string') paths.push(item.path);
    }
    for (const location of Array.isArray(update.locations) ? update.locations : []) {
      if (isRecord(location) && typeof location.path === 'string') paths.push(location.path);
    }
    paths.push(...pathsFromInput(rawInput));
  } else if (kind === 'execute') {
    const command = commandToString(rawInput?.command) ?? commandToString(rawInput?.cmd);
    if (command) paths.push(...extractWrittenFilesFromCommand(command));
  } else if (kind !== 'read' && update.title && categorizeToolName(update.title) === 'write') {
    paths.push(...pathsFromInput(rawInput));
  }

  return paths.map((path) => ({ path, toolKey, completed }));
};

const fromToolCall = (message: IMessageToolCall): ToolFileTarget[] => {
  const { call_id, name, status, input, args } = message.content ?? ({} as IMessageToolCall['content']);
  const toolKey = call_id || message.id;
  const completed = status === 'completed';
  const params = isRecord(input) && Object.keys(input).length > 0 ? input : isRecord(args) ? args : undefined;
  const category = categorizeToolName(name ?? '');
  if (category === 'write') return pathsFromInput(params).map((path) => ({ path, toolKey, completed }));
  if (category === 'execute') {
    const command = commandToString(params?.command) ?? commandToString(params?.cmd);
    return command ? extractWrittenFilesFromCommand(command).map((path) => ({ path, toolKey, completed })) : [];
  }
  return [];
};

const fromToolGroup = (message: IMessageToolGroup): ToolFileTarget[] => {
  if (!Array.isArray(message.content)) return [];
  return message.content.flatMap((item) => {
    const toolKey = item.call_id || message.id;
    const completed = item.status === 'Success';
    const paths: string[] = [];
    const details = item.confirmationDetails;
    if (details?.type === 'edit' && details.file_name) paths.push(details.file_name);
    if (details?.type === 'exec' && details.command) paths.push(...extractWrittenFilesFromCommand(details.command));
    const display = item.result_display;
    if (isRecord(display) && 'file_name' in display && typeof display.file_name === 'string') {
      paths.push(display.file_name);
    }
    return paths.map((path) => ({ path, toolKey, completed }));
  });
};

const targetCache = new WeakMap<FileToolMessage, ToolFileTarget[]>();

/**
 * Every previewable document a tool message created or edited (unfiltered by
 * status; callers decide). Read-only tools never contribute.
 */
export const extractToolFileTargets = (message: FileToolMessage): ToolFileTarget[] => {
  // Message objects are replaced, never mutated, on update — so a per-object cache
  // keeps re-renders during streaming from re-parsing every earlier tool call.
  const cached = targetCache.get(message);
  if (cached) return cached;
  let targets: ToolFileTarget[];
  if (message.type === 'acp_tool_call') targets = fromAcp(message);
  else if (message.type === 'tool_call') targets = fromToolCall(message);
  else targets = fromToolGroup(message);
  // The targets were built just above, so trimming in place is safe.
  for (const target of targets) target.path = target.path.trim();
  const result = targets.filter((target) => target.path && isPreviewableDocumentPath(target.path));
  targetCache.set(message, result);
  return result;
};

/** One chip: a unique document produced in a turn. */
export type TurnFile = {
  path: string;
  name: string;
  key: string;
};

/**
 * Unique completed documents across a turn's tool messages, in first-seen order.
 * The same file edited by several calls (or listed both as diff and location)
 * yields one entry.
 */
export const collectTurnFiles = (messages: FileToolMessage[]): TurnFile[] => {
  const seen = new Set<string>();
  const files: TurnFile[] = [];
  for (const message of messages) {
    for (const target of extractToolFileTargets(message)) {
      if (!target.completed) continue;
      const key = getPathKey(target.path);
      if (seen.has(key)) continue;
      seen.add(key);
      files.push({ path: target.path, name: getPathBaseName(target.path), key });
    }
  }
  return files;
};

/** Type guard for the tool messages this module understands. */
export const isFileToolMessage = (message: { type: string }): message is FileToolMessage =>
  message.type === 'acp_tool_call' || message.type === 'tool_call' || message.type === 'tool_group';
