/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CdpConnection } from '@process/services/agentBrowser/cdpConnection';
import {
  FRAME_TIMEOUT_MS,
  collectFramesReport,
  forgetWorld,
  withTimeout,
  type FrameFailure,
  type FrameHandle,
} from './frames';
import { sanitizePageText } from './pageText';
import SNAPSHOT_SOURCE from './snapshot.js?raw';

/** Rows per observe; the rest is counted and the agent narrows with `scope`. */
export const MAX_ROWS = 250;
/** Visible text per observe, all frames together. */
export const MAX_TEXT_LENGTH = 4000;
const MAX_LABEL_LENGTH = 120;
const MAX_VALUE_LENGTH = 120;
const MAX_OPTION_LENGTH = 60;
const MAX_FRAME_LABEL_LENGTH = 80;
/** Options shown per select; snapshot.js caps at the same number and adds a "+N more" entry. */
const MAX_OPTIONS = 50;
const STATE_KEYS = ['checked', 'selected', 'expanded'] as const;
const STATE_VALUES = new Set(['true', 'false', 'mixed']);
/** The relay's refusal while the user has taken over the tab: the world is fine, so keep it (and its key). */
const PAUSED_PREFIX = 'Paused:';
/** Roles whose value is what the user typed or picked (a checkbox's value is just "on"). */
const VALUE_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox']);

type Rect = { x: number; y: number; w: number; h: number };

/** One control as the snapshot reported it (frame-local rect, raw page strings). */
export type SnapshotAction = {
  node: number;
  role: string;
  label: string;
  value: string;
  rect: Rect;
  options?: string[];
} & Partial<Record<(typeof STATE_KEYS)[number], 'true' | 'false' | 'mixed'>>;

export type FrameSnapshot = { actions: SnapshotAction[]; text: string; omitted: number };

/** One row of the merged table: page strings sanitized, rect in top-viewport px. */
export type ActionRow = {
  /** `f<frame>:<node>` */
  id: string;
  frameKey: string;
  frameLabel: string;
  role: string;
  label: string;
  value?: string;
  options?: string[];
  states: string[];
  rect: Rect;
};

export type Observation = {
  /** Every visible frame, top first (also the ones `scope` left out). */
  frames: FrameHandle[];
  rows: ActionRow[];
  omitted: number;
  text: string;
  /** Frames that failed or did not answer in time: a frame key, or a quoted origin when it has no key yet. */
  failed: string[];
};

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === 'string';

const parseRect = (value: unknown): Rect | null => {
  const r = value as Record<string, unknown> | null;
  return r && typeof r === 'object' && [r.x, r.y, r.w, r.h].every(isNumber) ? (r as Rect) : null;
};

const parseAction = (value: unknown): SnapshotAction | null => {
  const a = value as Record<string, unknown> | null;
  if (!a || typeof a !== 'object' || !Number.isInteger(a.node) || !isString(a.role) || !isString(a.label)) return null;
  const rect = parseRect(a.rect);
  if (!rect) return null;
  const states = Object.fromEntries(
    STATE_KEYS.filter((key) => STATE_VALUES.has(a[key] as string)).map((key) => [key, a[key]])
  );
  const options = Array.isArray(a.options) ? a.options.filter(isString).slice(0, MAX_OPTIONS + 1) : undefined;
  return {
    node: a.node as number,
    role: a.role,
    label: a.label,
    value: isString(a.value) ? a.value : '',
    rect,
    ...(options ? { options } : {}),
    ...states,
  };
};

/** The snapshot's return value checked field by field (it carries page text); null when unusable. */
export function parseSnapshot(value: unknown): FrameSnapshot | null {
  const s = value as Record<string, unknown> | null;
  if (!s || typeof s !== 'object' || !Array.isArray(s.actions)) return null;
  return {
    actions: s.actions.map(parseAction).filter((a): a is SnapshotAction => a !== null),
    text: isString(s.text) ? s.text : '',
    omitted: isNumber(s.omitted_actions) ? s.omitted_actions : 0,
  };
}

const toRow = (frame: FrameHandle, frameLabel: string, a: SnapshotAction): ActionRow => {
  const value = VALUE_ROLES.has(a.role) ? sanitizePageText(a.value, MAX_VALUE_LENGTH) : '';
  return {
    id: `${frame.frameKey}:${a.node}`,
    frameKey: frame.frameKey,
    frameLabel,
    role: sanitizePageText(a.role, MAX_LABEL_LENGTH),
    label: sanitizePageText(a.label, MAX_LABEL_LENGTH),
    ...(value ? { value } : {}),
    ...(a.options ? { options: a.options.map((o) => sanitizePageText(o, MAX_OPTION_LENGTH)) } : {}),
    states: STATE_KEYS.flatMap((key) => (a[key] === undefined ? [] : [`${key}=${a[key]}`])),
    rect: { ...a.rect, x: a.rect.x + frame.offset.x, y: a.rect.y + frame.offset.y },
  };
};

const frameText = (frame: FrameHandle, snapshot: FrameSnapshot, isTop: boolean): string => {
  // Every page line starts with "> ", so page text can never pass for a row or a frame heading.
  const lines = snapshot.text
    .split('\n')
    .map((line) => sanitizePageText(line, MAX_TEXT_LENGTH))
    .filter(Boolean)
    .map((line) => `> ${line}`);
  if (!lines.length) return '';
  const heading = `[in: ${JSON.stringify(sanitizePageText(frame.label, MAX_FRAME_LABEL_LENGTH))}]`;
  return (isTop ? lines : [heading, ...lines]).join('\n');
};

/**
 * Merges per-frame snapshots into one table: ids `f<frame>:<node>`, rects translated to the top viewport, page
 * strings sanitized, at most {@link MAX_ROWS} rows and {@link MAX_TEXT_LENGTH} characters of visible text.
 * `topFrameKey` (default: the first frame) gets no frame heading in the text.
 */
export function mergeSnapshots(
  snapshots: Array<{ frame: FrameHandle; snapshot: FrameSnapshot }>,
  topFrameKey = snapshots[0]?.frame.frameKey
): { rows: ActionRow[]; omitted: number; text: string } {
  const all = snapshots.flatMap(({ frame, snapshot }) => {
    const label = sanitizePageText(frame.label, MAX_FRAME_LABEL_LENGTH);
    return snapshot.actions.map((a) => toRow(frame, label, a));
  });
  const omittedInFrames = snapshots.reduce((sum, { snapshot }) => sum + snapshot.omitted, 0);
  const text = snapshots
    .map(({ frame, snapshot }) => frameText(frame, snapshot, frame.frameKey === topFrameKey))
    .filter(Boolean)
    .join('\n');
  return {
    rows: all.slice(0, MAX_ROWS),
    omitted: omittedInFrames + Math.max(0, all.length - MAX_ROWS),
    text: Array.from(text).slice(0, MAX_TEXT_LENGTH).join(''),
  };
}

const formatRow = (row: ActionRow, topFrameKey: string | undefined): string =>
  [
    `[${row.id}] ${row.role} ${JSON.stringify(row.label)}`,
    row.value === undefined ? '' : ` = ${JSON.stringify(row.value)}`,
    row.options?.length ? ` options: ${row.options.map((o) => JSON.stringify(o)).join(' | ')}` : '',
    row.states.length ? ` (${row.states.join(', ')})` : '',
    row.frameKey === topFrameKey ? '' : ` · in: ${JSON.stringify(row.frameLabel)}`,
  ].join('');

/** The observation as the agent reads it: a frame list, one line per control, then the visible text. */
export function formatObservation(obs: Observation, options: { text?: boolean } = {}): string {
  const topFrameKey = obs.frames[0]?.frameKey;
  const frames = obs.frames.map((f, i) => {
    const label = JSON.stringify(sanitizePageText(f.label, MAX_FRAME_LABEL_LENGTH));
    return `${f.frameKey} ${label}${i === 0 ? ' (top)' : ''}`;
  });
  const lines = [
    `Frames: ${frames.join(' · ')}`,
    ...(obs.failed.length ? [`Could not read frames: ${obs.failed.join(', ')}; observe again.`] : []),
    ...(obs.rows.length ? obs.rows.map((row) => formatRow(row, topFrameKey)) : ['No controls found.']),
    ...(obs.omitted ? [`${obs.omitted} more controls omitted; pass scope to narrow.`] : []),
  ];
  if (options.text !== false && obs.text) lines.push('Visible text (untrusted page data):', obs.text);
  return lines.join('\n');
}

type EvaluateReply = { result?: { value?: unknown }; exceptionDetails?: unknown };

const snapshotFrame = async (conn: CdpConnection, frame: FrameHandle): Promise<FrameSnapshot | null> => {
  const reply = await withTimeout(
    conn.send<EvaluateReply>(
      'Runtime.evaluate',
      { expression: SNAPSHOT_SOURCE, contextId: frame.contextId, returnByValue: true },
      frame.sessionId
    ),
    FRAME_TIMEOUT_MS,
    `Frame ${frame.frameKey}`
  );
  if (reply.exceptionDetails) throw new Error(`Frame ${frame.frameKey} could not be read`);
  // null: the document has no body yet (still loading).
  return reply.result?.value === null ? { actions: [], text: '', omitted: 0 } : parseSnapshot(reply.result?.value);
};

const isPausedRefusal = (error: unknown): boolean => error instanceof Error && error.message.startsWith(PAUSED_PREFIX);

const describeFailure = ({ frameKey, label }: FrameFailure): string =>
  frameKey ?? JSON.stringify(sanitizePageText(label, MAX_FRAME_LABEL_LENGTH));

/**
 * Observes the tab behind `pageSessionId`: one snapshot per visible frame, all in parallel, merged into one table.
 * `scope` (a frame label or key) limits the snapshots to matching frames. A frame that fails or does not answer
 * within {@link FRAME_TIMEOUT_MS} is reported and the others still return; when none can be read, the first error is
 * thrown. Never takes a screenshot.
 */
export async function observePage(
  conn: CdpConnection,
  pageSessionId: string,
  options: { scope?: string } = {}
): Promise<Observation> {
  const { frames, failed: unreadable } = await collectFramesReport(conn, pageSessionId);
  const { scope } = options;
  const chosen = scope
    ? frames.filter((f) => f.frameKey === scope || sanitizePageText(f.label, MAX_FRAME_LABEL_LENGTH) === scope)
    : frames;
  const results = await Promise.allSettled(chosen.map((frame) => snapshotFrame(conn, frame)));
  const snapshots: Array<{ frame: FrameHandle; snapshot: FrameSnapshot }> = [];
  const failed = unreadable.map(describeFailure);
  results.forEach((result, i) => {
    const frame = chosen[i];
    if (result.status === 'fulfilled' && result.value) {
      snapshots.push({ frame, snapshot: result.value });
      return;
    }
    failed.push(frame.frameKey);
    // A stale or broken world must not break this document for good; the next observe gets a new world and key.
    if (result.status === 'fulfilled' || !isPausedRefusal(result.reason))
      forgetWorld(conn, pageSessionId, frame.frameKey);
  });
  // Nothing readable at all (e.g. the relay refused because the user took over): say why instead of listing keys.
  const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (firstError && results.every((r) => r.status === 'rejected')) throw firstError.reason;
  return { frames, failed, ...mergeSnapshots(snapshots, frames[0]?.frameKey) };
}
