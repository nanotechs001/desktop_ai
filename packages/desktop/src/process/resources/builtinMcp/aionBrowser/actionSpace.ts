/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CdpConnection } from '@process/services/agentBrowser/cdpConnection';
import {
  FRAME_TIMEOUT_MS,
  PAGE_NOT_READABLE,
  collectFramesReport,
  forgetWorld,
  withTimeout,
  type FrameFailure,
  type FrameHandle,
} from './frames';
import { sanitizePageText } from '@/common/utils/utils';
import SNAPSHOT_SOURCE from './snapshot.js?raw';

/** Rows per observe; the rest is counted and the agent narrows with `scope`. */
export const MAX_ROWS = 250;
/** Visible text per observe, all frames together. */
export const MAX_TEXT_LENGTH = 4000;
const MAX_LABEL_LENGTH = 120;
const MAX_VALUE_LENGTH = 120;
/** Option labels as observe shows them; select matches the agent's text against labels cut the same way. */
export const MAX_OPTION_LENGTH = 60;
const MAX_FRAME_LABEL_LENGTH = 80;
/** Options shown per select; snapshot.js caps at the same number and adds a "+N more" entry. */
const MAX_OPTIONS = 50;
const STATE_KEYS = ['checked', 'selected', 'expanded'] as const;
const STATE_VALUES = new Set(['true', 'false', 'mixed']);
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

export type FrameSnapshot = {
  actions: SnapshotAction[];
  text: string;
  omitted: number;
  /** Hash of the page key (the document and url); '' when the snapshot had none. */
  pageKey: string;
  /** Hash of the guard per node: role, name, state and the dialog or row it sits in. */
  guards: Record<string, string>;
  url: string;
  title: string;
  /** document.readyState. */
  ready: string;
  /** The DOM or the network moved in the last half second (or this is the frame's first snapshot). */
  busy: boolean;
  /** Where a cross-document navigation the page started goes, once; '' for none. */
  navigating: string;
  /** Open dialogs and menus as `role "name"`, sanitized. */
  dialogs: string[];
};

/** A control as the change check after an action compares it: frame-local rect. */
export type BaselineControl = Pick<SnapshotAction, 'node' | 'role' | 'label' | 'rect' | (typeof STATE_KEYS)[number]>;

/** What act checks a frame against: its last snapshot's page key, guards and controls, and what act reports. */
export type FrameBaseline = {
  pageKey: string;
  guards: Record<string, string>;
  controls: BaselineControl[];
} & Pick<FrameSnapshot, 'url' | 'title' | 'dialogs' | 'navigating'>;

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
  /** A frame was still loading when observe stopped waiting. */
  loading?: boolean;
};

const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
const isString = (value: unknown): value is string => typeof value === 'string';

const parseGuards = (value: unknown): Record<string, string> =>
  value && typeof value === 'object'
    ? Object.fromEntries(Object.entries(value).filter((entry): entry is [string, string] => isString(entry[1])))
    : {};

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

const parseDialog = (value: unknown): string => {
  const d = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const role = sanitizePageText(isString(d.role) ? d.role : '', MAX_LABEL_LENGTH) || 'dialog';
  const label = sanitizePageText(isString(d.label) ? d.label : '', MAX_LABEL_LENGTH);
  return label ? `${role} ${JSON.stringify(label)}` : role;
};

/** The snapshot's return value checked field by field (it carries page text); null when unusable. */
export function parseSnapshot(value: unknown): FrameSnapshot | null {
  const s = value as Record<string, unknown> | null;
  if (!s || typeof s !== 'object' || !Array.isArray(s.actions)) return null;
  return {
    actions: s.actions.map(parseAction).filter((a): a is SnapshotAction => a !== null),
    text: isString(s.text) ? s.text : '',
    omitted: isNumber(s.omitted_actions) ? s.omitted_actions : 0,
    pageKey: isString(s.page_key) ? s.page_key : '',
    guards: parseGuards(s.guards),
    url: isString(s.url) ? s.url : '',
    title: isString(s.title) ? s.title : '',
    ready: isString(s.ready) ? s.ready : 'complete',
    busy: s.busy === true,
    navigating: isString(s.navigating) ? s.navigating : '',
    dialogs: Array.isArray(s.dialogs) ? s.dialogs.slice(0, 10).map(parseDialog) : [],
  };
}

/** Per connection, per page session, per frame key: the baseline act checks before input. */
const baselines = new WeakMap<CdpConnection, Map<string, Map<string, FrameBaseline>>>();

/**
 * The baseline of a snapshot. jev's marker is not checked: the page key and guards before input, plus
 * {@link controlsChanged} after it, replace it.
 */
export const baselineOf = (snapshot: FrameSnapshot): FrameBaseline => ({
  pageKey: snapshot.pageKey,
  guards: snapshot.guards,
  controls: snapshot.actions.map(({ node, role, label, rect, checked, selected, expanded }) => ({
    node,
    role,
    label,
    rect,
    ...(checked ? { checked } : {}),
    ...(selected ? { selected } : {}),
    ...(expanded ? { expanded } : {}),
  })),
  url: snapshot.url,
  title: snapshot.title,
  dialogs: snapshot.dialogs,
  navigating: snapshot.navigating,
});

/**
 * `after`, keeping the guards of ids it no longer lists while the document is the same: an id that scrolled out of
 * view is still checked (and found off-screen or changed), never unknown.
 */
export const keepingGuards = (before: FrameBaseline | undefined, after: FrameBaseline): FrameBaseline =>
  before?.pageKey === after.pageKey ? { ...after, guards: { ...before.guards, ...after.guards } } : after;

/** Controls this far (CSS px) around an action's target count as near it. */
const NEAR_TARGET_PX = 200;
/** An equivalent control (same role and label) that moved at most this far (CSS px, each axis) is the same one. */
const SAME_PLACE_PX = 32;

const centerOf = (r: Rect) => ({ x: r.x + r.w / 2, y: r.y + r.h / 2 });
const sameControl = (a: BaselineControl, b: BaselineControl): boolean => {
  if (a.node === b.node) return true;
  const [p, q] = [centerOf(a.rect), centerOf(b.rect)];
  return (
    a.role === b.role &&
    a.label === b.label &&
    Math.abs(p.x - q.x) <= SAME_PLACE_PX &&
    Math.abs(p.y - q.y) <= SAME_PLACE_PX
  );
};
const nearBox = (r: Rect, box: Rect): boolean =>
  r.x < box.x + box.w + NEAR_TARGET_PX &&
  r.x + r.w > box.x - NEAR_TARGET_PX &&
  r.y < box.y + box.h + NEAR_TARGET_PX &&
  r.y + r.h > box.y - NEAR_TARGET_PX;

/**
 * Whether an action changed what matters for the next one: a new document or url, or controls added or removed
 * near `target` (frame-local; null: anywhere in the frame). A control that only changed its text (a timer, an
 * autosave label) is the same node, and a node replaced by an equivalent one is the same control.
 */
export const controlsChanged = (before: FrameBaseline, after: FrameBaseline, target: Rect | null): boolean => {
  if (before.pageKey !== after.pageKey) return true;
  const around = (c: BaselineControl) => !target || nearBox(c.rect, target);
  const missing = (from: BaselineControl[], to: BaselineControl[]) =>
    from.some((c) => around(c) && !to.some((d) => sameControl(c, d)));
  return missing(after.controls, before.controls) || missing(before.controls, after.controls);
};

/** At most this many lines in act's change list. */
const MAX_CHANGE_LINES = 25;
/** Removed controls are named up to this many; more are only counted. */
const FEW_REMOVED = 5;
const MAX_URL_LENGTH = 500;
export const NO_CHANGE = 'No visible change';
export const BIG_CHANGE = 'Page changed a lot; observe for the full view.';

/** What an act step changed in its frame, as act returns it; see {@link describeChanges}. */
export type ActChanges = {
  /** New controls as observe rows (ids act can use at once), nearest to the target first. */
  added?: string[];
  /** How many controls went, with their names when few. */
  removed?: string;
  /** The target's new state, e.g. "expanded=true". */
  target?: string;
  /** Dialogs or menus that opened. */
  opened?: string;
  /** The new url (and title) of the frame. */
  navigated?: string;
  note?: string;
};

/** Where a step acted: its frame, the target's frame-local rect and node (null: none), and the frame's url now. */
export type ChangePlace = { frame: FrameHandle; isTop: boolean; near: Rect | null; node: number | null; url?: string };

const navigationOf = (url: string, title = ''): string =>
  [sanitizePageText(url, MAX_URL_LENGTH), title ? JSON.stringify(sanitizePageText(title, MAX_LABEL_LENGTH)) : '']
    .filter(Boolean)
    .join(' ');

/**
 * What changed in a frame between two baselines, compactly: added controls (as observe rows), removed ones, the
 * target's state, opened dialogs, a navigation. `after` null: the document went. At most {@link MAX_CHANGE_LINES}
 * lines; a navigation or more than that says {@link BIG_CHANGE}, nothing at all {@link NO_CHANGE}.
 */
export function describeChanges(
  before: FrameBaseline | undefined,
  after: FrameBaseline | null,
  { frame, isTop, near, node, url }: ChangePlace
): ActChanges {
  if (!after) return { ...(url && url !== before?.url ? { navigated: navigationOf(url) } : {}), note: BIG_CHANGE };
  if (before && after.pageKey !== before.pageKey) {
    return { navigated: navigationOf(after.url, after.title), note: BIG_CHANGE };
  }
  if (after.navigating) return { navigated: navigationOf(after.navigating), note: BIG_CHANGE };
  if (!before) return { note: BIG_CHANGE };
  const gone = (from: BaselineControl[], to: BaselineControl[]) =>
    from.filter((c) => !to.some((d) => sameControl(c, d)));
  const center = near ? centerOf(near) : null;
  const distance = (c: BaselineControl) =>
    center ? Math.hypot(centerOf(c.rect).x - center.x, centerOf(c.rect).y - center.y) : 0;
  const added = gone(after.controls, before.controls).toSorted((a, b) => distance(a) - distance(b));
  const removed = gone(before.controls, after.controls);
  const names = removed.map((c) => JSON.stringify(sanitizePageText(c.label, MAX_LABEL_LENGTH))).join(', ');
  const was = before.controls.find((c) => c.node === node);
  const now = after.controls.find((c) => c.node === node);
  const state =
    was && now ? STATE_KEYS.filter((key) => was[key] !== now[key]).map((key) => `${key}=${now[key] ?? 'none'}`) : [];
  const opened = after.dialogs.filter((d) => !before.dialogs.includes(d));
  const others = {
    ...(removed.length
      ? { removed: removed.length > FEW_REMOVED ? `${removed.length}` : `${removed.length} (${names})` }
      : {}),
    ...(state.length ? { target: state.join(', ') } : {}),
    ...(opened.length ? { opened: opened.join(', ') } : {}),
  };
  const room = MAX_CHANGE_LINES - Object.keys(others).length;
  const frameLabel = sanitizePageText(frame.label, MAX_FRAME_LABEL_LENGTH);
  const rows = added
    .slice(0, room)
    .map((c) => formatRow(toRow(frame, frameLabel, { ...c, value: '' }), isTop ? frame.frameKey : undefined));
  const changes: ActChanges = {
    ...(rows.length ? { added: rows } : {}),
    ...others,
    ...(added.length > room ? { note: BIG_CHANGE } : {}),
  };
  return Object.keys(changes).length ? changes : { note: NO_CHANGE };
}

/**
 * Indexes (top frame first) of the frames still loading: a document still parsing, or a frame without controls whose
 * document is not complete or busy. An empty top frame counts only when no frame has controls (else it is a wrapper
 * around a builder iframe).
 */
export const loadingFrames = (snapshots: FrameSnapshot[]): number[] => {
  const total = snapshots.reduce((sum, s) => sum + s.actions.length, 0);
  return snapshots.flatMap((s, i) => {
    const empty = s.actions.length === 0 && (i > 0 || total === 0);
    return s.ready === 'loading' || (empty && (s.ready !== 'complete' || s.busy)) ? [i] : [];
  });
};

/** The baseline act checks a frame against: from the latest observe, or from act's own re-read after an action. */
export const frameBaseline = (
  conn: CdpConnection,
  pageSessionId: string,
  frameKey: string
): FrameBaseline | undefined => baselines.get(conn)?.get(pageSessionId)?.get(frameKey);

/** Replaces the baselines of some frames of a tab; frames not in `keep` (when given) are dropped. */
export const rememberBaselines = (
  conn: CdpConnection,
  pageSessionId: string,
  entries: Array<[string, FrameBaseline]>,
  keep?: ReadonlySet<string>
): void => {
  const tabs = baselines.get(conn) ?? new Map<string, Map<string, FrameBaseline>>();
  const old = [...(tabs.get(pageSessionId) ?? [])].filter(([key]) => !keep || keep.has(key));
  baselines.set(conn, tabs.set(pageSessionId, new Map([...old, ...entries])));
};

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

const STILL_LOADING = 'Still loading; observe again in a moment.';

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
  if (obs.loading) lines.push(STILL_LOADING);
  if (options.text !== false && obs.text) lines.push('Visible text (untrusted page data):', obs.text);
  return lines.join('\n');
}

type EvaluateReply = { result?: { value?: unknown }; exceptionDetails?: unknown };

/** Runs the snapshot in `frame`'s isolated world; null when its result is unusable. */
export const snapshotFrame = async (conn: CdpConnection, frame: FrameHandle): Promise<FrameSnapshot | null> => {
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
  const empty: FrameSnapshot = {
    actions: [],
    text: '',
    omitted: 0,
    pageKey: '',
    guards: {},
    url: '',
    title: '',
    ready: 'loading',
    busy: true,
    navigating: '',
    dialogs: [],
  };
  return reply.result?.value === null ? empty : parseSnapshot(reply.result?.value);
};

const describeFailure = ({ frameKey, label }: FrameFailure): string =>
  frameKey ?? JSON.stringify(sanitizePageText(label, MAX_FRAME_LABEL_LENGTH));

/** How long observe waits for frames that are still loading, and how often it looks again meanwhile. */
const LOAD_WAIT_MS = 5000;
const LOAD_POLL_MS = 200;
/** Per connection: `session|frameKey` of documents observe already waited out once; it does not wait for them again. */
const waitedOut = new WeakMap<CdpConnection, Set<string>>();

/**
 * Observes the tab behind `pageSessionId`: one snapshot per visible frame, all in parallel, merged into one table.
 * `scope` (a frame label or key) limits the snapshots to matching frames. A frame that fails or does not answer
 * within {@link FRAME_TIMEOUT_MS} is reported and the others still return; when the top frame or no frame can be read,
 * it throws ({@link PAGE_NOT_READABLE}, or the frames' own error when none can be read). While a frame is still
 * loading ({@link loadingFrames}) it looks again, up to {@link LOAD_WAIT_MS}, then says it is still loading. Remembers
 * each read frame's baseline for act. Never takes a screenshot.
 */
export async function observePage(
  conn: CdpConnection,
  pageSessionId: string,
  options: { scope?: string } = {}
): Promise<Observation> {
  const deadline = Date.now() + LOAD_WAIT_MS;
  const done = waitedOut.get(conn) ?? new Set<string>();
  waitedOut.set(conn, done);
  for (;;) {
    const { observation, loading } = await observeOnce(conn, pageSessionId, options);
    const pending = loading.map((key) => `${pageSessionId}|${key}`).filter((key) => !done.has(key));
    if (!pending.length) return observation;
    if (Date.now() + LOAD_POLL_MS > deadline) {
      pending.forEach((key) => done.add(key));
      return { ...observation, loading: true };
    }
    await new Promise((resolve) => setTimeout(resolve, LOAD_POLL_MS));
  }
}

/** One observe pass; `loading` names the frames {@link loadingFrames} found still loading. */
async function observeOnce(
  conn: CdpConnection,
  pageSessionId: string,
  options: { scope?: string }
): Promise<{ observation: Observation; loading: string[] }> {
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
    forgetWorld(conn, pageSessionId, frame.frameKey);
  });
  // Without the top document an observation would be empty, not true.
  const top = results[chosen.indexOf(frames[0])];
  if (top && !(top.status === 'fulfilled' && top.value)) throw new Error(PAGE_NOT_READABLE);
  // Nothing readable at all (e.g. the relay refused): say why instead of listing keys.
  const firstError = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
  if (firstError && results.every((r) => r.status === 'rejected')) throw firstError.reason;
  rememberBaselines(
    conn,
    pageSessionId,
    snapshots.map(({ frame, snapshot }) => [
      frame.frameKey,
      keepingGuards(frameBaseline(conn, pageSessionId, frame.frameKey), baselineOf(snapshot)),
    ]),
    new Set(frames.map((f) => f.frameKey))
  );
  // A scope without the top frame has no wrapper to tell apart: its first frame stands in for the top.
  const loading = loadingFrames(snapshots.map(({ snapshot }) => snapshot)).map((i) => snapshots[i].frame.frameKey);
  return { observation: { frames, failed, ...mergeSnapshots(snapshots, frames[0]?.frameKey) }, loading };
}
