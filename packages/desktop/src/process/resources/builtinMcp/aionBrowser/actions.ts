/**
 * @license
 * Copyright 2026 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CdpConnection } from '@process/services/agentBrowser/cdpConnection';
import { isRiskyLabel } from '@process/services/agentBrowser/confirmGate';
import {
  BIG_CHANGE,
  MAX_OPTION_LENGTH,
  NO_CHANGE,
  baselineOf,
  controlsChanged,
  describeChanges,
  frameBaseline,
  keepingGuards,
  rememberBaselines,
  snapshotFrame,
  type ActChanges,
} from './actionSpace';
import { FRAME_TIMEOUT_MS, collectFramesReport, frameUrl, intersect, withTimeout, type FrameHandle } from './frames';
import { sanitizePageText } from '@/common/utils/utils';
import {
  DEVICE_PIXEL_RATIO,
  ENTER_LABELS,
  OWNER_HIT,
  POINT_LABELS,
  RESOLVE_TARGET,
  SCROLL_AT,
  SELECT_OPTION,
  SETTLE,
} from './inPage';

/** An executed action as the pane shows it (AgentActionEvent): code-owned op, a bounded label, top-viewport rect. */
export type ReportedAction = {
  op: string;
  label: string;
  rect: { x: number; y: number; width: number; height: number } | null;
};

/**
 * Where actions go: the tab's page session, the relay path that tells the pane what ran, and the one that asks the
 * user before a risky click or key. `confirm` names the frame the control sits in (the relay looks up its origin
 * itself) and resolves false (never rejects) for anything but an explicit Allow.
 */
export type ActionContext = {
  conn: CdpConnection;
  sessionId: string;
  report(action: ReportedAction): Promise<void>;
  confirm(label: string, frame: Pick<FrameHandle, 'sessionId' | 'frameId'>): Promise<boolean>;
};

export const ACT_OPS = ['click', 'type', 'select', 'press', 'scroll', 'hover'] as const;
export const DRAG_POSITIONS = ['before', 'after', 'inside'] as const;
export const SCROLL_DIRECTIONS = ['up', 'down'] as const;

type KeySpec = { key: string; code: string; keyCode: number; text?: string };
const PRESS_KEYS: Readonly<Record<string, KeySpec>> = {
  Enter: { key: 'Enter', code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { key: 'Tab', code: 'Tab', keyCode: 9 },
  Escape: { key: 'Escape', code: 'Escape', keyCode: 27 },
  Backspace: { key: 'Backspace', code: 'Backspace', keyCode: 8 },
  Delete: { key: 'Delete', code: 'Delete', keyCode: 46 },
  ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', keyCode: 39 },
  Home: { key: 'Home', code: 'Home', keyCode: 36 },
  End: { key: 'End', code: 'End', keyCode: 35 },
  PageUp: { key: 'PageUp', code: 'PageUp', keyCode: 33 },
  PageDown: { key: 'PageDown', code: 'PageDown', keyCode: 34 },
  Space: { key: ' ', code: 'Space', keyCode: 32, text: ' ' },
};
/** Keys `press` accepts; `scroll` takes up or down in the same field. */
export const ACT_KEYS = Object.keys(PRESS_KEYS).concat(SCROLL_DIRECTIONS) as [string, ...string[]];

export type ActOp = (typeof ACT_OPS)[number];
export type DragPosition = (typeof DRAG_POSITIONS)[number];
export type ActStep = { op: ActOp; target?: string; text?: string; key?: string };
export type Outcome = { result: 'done' | 'stale' | 'denied' | 'error'; reason?: string };
export type StepResult = { op: ActOp; target?: string } & Outcome;

/** Wait after input when the page shows no frame (spec §4: two animation frames or 50 ms). */
const SETTLE_MS = 50;
/** How long act waits before it looks again at a frame that showed no change after an action. */
const RELOOK_MS = 100;
/** Upper bound for the in-page settle (comboboxes wait up to 200 ms for their options). */
const SETTLE_TIMEOUT_MS = 500;
/** Longest wait for one input, screenshot or report command; a page stuck in a dialog never answers. */
const COMMAND_TIMEOUT_MS = 5000;
const NO_RESPONSE = 'the page did not respond (a dialog may be open)';
/** Largest screenshot side, CSS px. */
const MAX_SCREENSHOT_SIDE = 4096;
const DRAG_STEPS = 5;
/** A drag that moves less than this is a click (the page gets one on a release near the press). */
const MIN_DRAG_PX = 4;
/** How long a started HTML5 drag takes to show up as Input.dragIntercepted (spike: within 200 ms). */
const DRAG_INTERCEPT_MS = 200;
/** Where on the drop target each position lands, as a fraction of its height. */
const DROP_AT: Readonly<Record<DragPosition, number>> = { before: 0.25, inside: 0.5, after: 0.75 };
/** A scroll moves this share of the visible frame. */
const SCROLL_SHARE = 0.8;
const MAX_REPORT_LABEL = 80;
const MAX_REPORT_FRAME = 40;
/** Longest risky label shown to the user (the relay bounds it again). */
const MAX_CONFIRM_LABEL = 120;
const TEXT_ROLES = new Set(['textbox', 'searchbox', 'spinbutton', 'combobox']);
const LEFT = { button: 'left', clickCount: 1 } as const;
// Select-all is Cmd+A on macOS and Ctrl+A elsewhere; the MCP runs on the same OS as AionUi.
const SELECT_ALL_MODIFIER = process.platform === 'darwin' ? 4 : 2;
const TARGET_ID = /^(f\d+):(\d+)$/;
/** How long act looks for a control that hovering its builder item shows (a toolbar icon), and how often. */
const REVEAL_MS = 300;
const REVEAL_POLL_MS = 30;

type Point = { x: number; y: number };
type Box = Point & { w: number; h: number };
/** An observed control, checked fresh, with its geometry in top-viewport CSS px. */
type Target = {
  id: string;
  frame: FrameHandle;
  isTop: boolean;
  node: number;
  rect: Box;
  point: Point;
  role: string;
  label: string;
  editable: boolean;
  options?: string[];
  /** The rect in its frame's own coordinates, as snapshots report rects. */
  local: Box;
};

/**
 * The frame an action acted in (and whether it is the top one), and where in it: the target's frame-local rect and
 * node, null without a target (the whole frame counts).
 */
type Acted = { frame: FrameHandle; isTop: boolean; near: Box | null; node: number | null };

/** A step that did not run for a reason the agent can act on (observe again, fix the call). */
class StepError extends Error {
  constructor(
    readonly result: 'stale' | 'denied' | 'error',
    message: string
  ) {
    super(message);
  }
}

/** The target shows only while its builder item is hovered: move the pointer to `at` (the item's own area) first. */
class HoverFirst extends StepError {
  constructor(
    message: string,
    readonly at: Point
  ) {
    super('stale', message);
  }
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const inside = (p: Point, box: Box): boolean =>
  p.x >= box.x && p.y >= box.y && p.x < box.x + box.w && p.y < box.y + box.h;
const isNumber = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

/**
 * Sends a page-session command that may hang while the page is blocked (Input.*, captureScreenshot): after
 * {@link COMMAND_TIMEOUT_MS} it fails the step with {@link NO_RESPONSE}. The command is never retried.
 */
const sendBounded = <T>(
  ctx: ActionContext,
  method: string,
  params: Record<string, unknown>,
  ms = COMMAND_TIMEOUT_MS
): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new StepError('error', NO_RESPONSE)), ms);
  });
  return Promise.race([ctx.conn.send<T>(method, params, ctx.sessionId), timeout]).finally(() => clearTimeout(timer));
};

/** A Runtime.callFunctionOn argument: a value, or a remote object in the same world. */
type CallArgument = { value: unknown } | { objectId: string };
const values = (...args: unknown[]): CallArgument[] => args.map((value) => ({ value }));

type CallReply = { result?: { value?: unknown }; exceptionDetails?: unknown };

/** Calls one of our in-page functions in `frame`'s isolated world; arguments travel as CDP arguments, never as code. */
const callIn = async (
  conn: CdpConnection,
  frame: FrameHandle,
  fn: string,
  args: CallArgument[],
  awaitPromise = false
): Promise<unknown> => {
  const reply = await conn.send<CallReply>(
    'Runtime.callFunctionOn',
    {
      functionDeclaration: fn,
      executionContextId: frame.contextId,
      arguments: args,
      returnByValue: true,
      awaitPromise,
    },
    frame.sessionId
  );
  if (reply.exceptionDetails) throw new Error(`Frame ${frame.frameKey} could not run the check`);
  return reply.result?.value;
};

const parseResolved = (value: unknown): Omit<Target, 'id' | 'frame' | 'isTop' | 'node' | 'local'> | string => {
  const v = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  if (typeof v.stale === 'string') return v.stale;
  const r = (v.rect && typeof v.rect === 'object' ? v.rect : {}) as Record<string, unknown>;
  if (![r.x, r.y, r.w, r.h].every(isNumber)) return 'the page changed since observe';
  const options = Array.isArray(v.options) ? v.options.filter((o): o is string => typeof o === 'string') : undefined;
  const rect = { x: r.x as number, y: r.y as number, w: r.w as number, h: r.h as number };
  const p = (v.point && typeof v.point === 'object' ? v.point : {}) as Record<string, unknown>;
  return {
    rect,
    point: isNumber(p.x) && isNumber(p.y) ? { x: p.x, y: p.y } : { x: rect.x + rect.w / 2, y: rect.y + rect.h / 2 },
    role: typeof v.role === 'string' ? v.role : '',
    label: typeof v.label === 'string' ? v.label : '',
    editable: v.editable !== false,
    ...(options ? { options } : {}),
  };
};

/**
 * Resolves an observed id to its element, the way jev guards an action: the frame's page key and the target's guard
 * must match the baseline, its click point (the center, or a builder item's own area) must hit the element itself (not
 * a cover), and the absolute point must lie in the part of its frame the top viewport shows. Geometry is read fresh.
 * With hitTest, a control a builder item shows only while hovered (a GoHighLevel toolbar icon) is revealed first: the
 * pointer moves onto the item's own area and act looks again, by the same identity, for up to {@link REVEAL_MS}.
 * Throws {@link StepError}.
 */
async function resolveTarget(ctx: ActionContext, id: string, hitTest = true): Promise<Target> {
  try {
    return await resolveOnce(ctx, id, hitTest, hitTest);
  } catch (error) {
    if (!(error instanceof HoverFirst)) throw error;
    await mouse(ctx, 'mouseMoved', error.at);
    const deadline = Date.now() + REVEAL_MS;
    for (;;) {
      try {
        return await resolveOnce(ctx, id, hitTest, false);
      } catch (again) {
        if (!(again instanceof StepError) || again.result !== 'stale' || Date.now() >= deadline) throw again;
      }
      await sleep(REVEAL_POLL_MS);
    }
  }
}

async function resolveOnce(ctx: ActionContext, id: string, hitTest: boolean, reveal: boolean): Promise<Target> {
  const match = TARGET_ID.exec(id);
  const baseline = match ? frameBaseline(ctx.conn, ctx.sessionId, match[1]) : undefined;
  const guard = match ? baseline?.guards[match[2]] : undefined;
  if (!match || !baseline || guard === undefined) {
    throw new StepError('error', `Unknown target ${id}; use an id from the latest observe.`);
  }
  const { frames } = await collectFramesReport(ctx.conn, ctx.sessionId);
  const frame = frames.find((f) => f.frameKey === match[1]);
  if (!frame) throw new StepError('stale', 'its frame changed or is off-screen');
  const node = Number(match[2]);
  const value = await withTimeout(
    callIn(ctx.conn, frame, RESOLVE_TARGET, values(node, baseline.pageKey, guard, hitTest, reveal)),
    FRAME_TIMEOUT_MS,
    'The target check'
  ).catch(staleUnlessStep);
  const hover = (value as { hover?: Record<string, unknown> } | null)?.hover;
  if (reveal && hover && isNumber(hover.x) && isNumber(hover.y)) {
    const at = { x: hover.x + frame.offset.x, y: hover.y + frame.offset.y };
    // An item this frame's viewport shows but the top one does not: look as without it.
    if (!inside(at, frame.clip)) return resolveOnce(ctx, id, hitTest, false);
    throw new HoverFirst(String((value as { stale?: unknown }).stale), at);
  }
  const found = parseResolved(value);
  if (typeof found === 'string') throw new StepError('stale', found);
  const rect = { ...found.rect, x: found.rect.x + frame.offset.x, y: found.rect.y + frame.offset.y };
  const point = { x: found.point.x + frame.offset.x, y: found.point.y + frame.offset.y };
  if (!inside(point, frame.clip)) throw new StepError('stale', 'the target is off-screen; scroll it into view first');
  if (hitTest) await checkOwners(ctx, frames, frame, point);
  return { ...found, id, frame, isTop: frame === frames[0], node, rect, point, local: found.rect };
}

/** A failed freshness call means the document changed (e.g. went away mid-call). */
const staleUnlessStep = (error: unknown): never => {
  if (error instanceof StepError) throw error;
  throw new StepError('stale', 'the page changed since observe');
};

/**
 * The elementFromPoint check for the frames around the target: in each document up to the top, the topmost element
 * at the point must be the iframe that shows the target's frame (else a cover in an outer page, e.g. a modal over a
 * builder iframe, would take the click). Each owner is resolved into our own world of its session's root frame.
 */
async function checkOwners(ctx: ActionContext, frames: FrameHandle[], frame: FrameHandle, point: Point): Promise<void> {
  for (const owner of frame.owners) {
    const root = frames.find((f) => f.sessionId === owner.sessionId && f.frameId === owner.rootFrameId);
    if (!root) throw new StepError('stale', 'its frame changed or is off-screen');
    const check = (async () => {
      const { backendNodeId } = await ctx.conn.send<{ backendNodeId: number }>(
        'DOM.getFrameOwner',
        { frameId: owner.frameId },
        owner.sessionId
      );
      const { object } = await ctx.conn.send<{ object: { objectId?: string } }>(
        'DOM.resolveNode',
        { backendNodeId, executionContextId: root.contextId },
        owner.sessionId
      );
      if (!object.objectId) return false;
      const at = { x: point.x - root.offset.x, y: point.y - root.offset.y };
      return callIn(ctx.conn, root, OWNER_HIT, [{ objectId: object.objectId }, ...values(at.x, at.y)]);
    })();
    const shown = await withTimeout(check, FRAME_TIMEOUT_MS, 'The cover check').catch(staleUnlessStep);
    if (shown === true) continue;
    // OWNER_HIT names the cover when it can (a dialog over a builder's frame), else returns '' or false.
    const cover = typeof shown === 'string' && shown ? shown : '';
    throw new StepError(
      'stale',
      cover ? `the target is covered by ${cover}; close or move it first` : 'the target is covered by another element'
    );
  }
}

const mouse = (ctx: ActionContext, type: string, at: Point, extra: Record<string, unknown> = {}): Promise<unknown> =>
  sendBounded(ctx, 'Input.dispatchMouseEvent', { type, x: at.x, y: at.y, ...extra });

const click = async (ctx: ActionContext, at: Point): Promise<void> => {
  await mouse(ctx, 'mouseMoved', at);
  let released = false;
  try {
    await mouse(ctx, 'mousePressed', at, LEFT); // a press that fails or times out may still have landed
    await mouse(ctx, 'mouseReleased', at, LEFT);
    released = true;
  } finally {
    // Best effort: a button left down would break the user's own clicks; the first error is the one thrown.
    if (!released) await mouse(ctx, 'mouseReleased', at, LEFT).catch((): void => undefined);
  }
};

const pressKey = async (ctx: ActionContext, spec: KeySpec, extra: Record<string, unknown> = {}): Promise<void> => {
  const base: Record<string, unknown> = {
    key: spec.key,
    code: spec.code,
    windowsVirtualKeyCode: spec.keyCode,
    ...extra,
  };
  await sendBounded(ctx, 'Input.dispatchKeyEvent', {
    type: spec.text ? 'keyDown' : 'rawKeyDown',
    ...base,
    ...(spec.text ? { text: spec.text } : {}),
  });
  const { commands: _commands, ...up } = base;
  await sendBounded(ctx, 'Input.dispatchKeyEvent', { type: 'keyUp', ...up });
};

const SELECT_ALL: KeySpec = { key: 'a', code: 'KeyA', keyCode: 65 };

const targetLabel = (t: Target): string => {
  const label = `[${t.id}] ${sanitizePageText(t.label, MAX_REPORT_LABEL)}`;
  return t.isTop ? label : `${label} · in: ${sanitizePageText(t.frame.label, MAX_REPORT_FRAME)}`;
};

const rectOf = (t: Target): ReportedAction['rect'] => ({ x: t.rect.x, y: t.rect.y, width: t.rect.w, height: t.rect.h });

/** Tells the pane; the highlight is cosmetic, so a refused or rate-limited report never fails an action that ran. */
const reportSafely = (ctx: ActionContext, action: ReportedAction): Promise<void> =>
  withTimeout(ctx.report(action), COMMAND_TIMEOUT_MS, 'Report').catch((): void => undefined);

/** Two animation frames or 50 ms in the frame acted in (200 ms for a combobox's options); `null` frame: 50 ms. */
const settle = async (
  ctx: ActionContext,
  frame: FrameHandle | null,
  comboboxNode: number | null = null
): Promise<void> => {
  if (!frame) return sleep(SETTLE_MS);
  // A click that navigates takes the world with it; that page has settled as far as this step is concerned.
  await withTimeout(callIn(ctx.conn, frame, SETTLE, values(comboboxNode), true), SETTLE_TIMEOUT_MS, 'Settle').catch(
    (): void => undefined
  );
};

const need = (value: string | undefined, what: string, op: string): string => {
  if (value === undefined) throw new StepError('error', `${op} needs ${what}.`);
  return value;
};

/** A label the user would be asked about, and the frame its control sits in. */
type Labeled = { label: string; frame: FrameHandle };
/** Keys that act on the focused control (activate it, or change a native select); the gate reads it first. */
const ACTIVATING_KEYS = new Set([
  'Enter',
  'Space',
  'ArrowUp',
  'ArrowDown',
  'ArrowLeft',
  'ArrowRight',
  'Home',
  'End',
  'PageUp',
  'PageDown',
]);
const CHECK_FAILED = 'could not check what this input would activate; observe again';
const CHANGED_WHILE_ASKING = 'the user allowed it, but the control changed while they were asked; observe again';

/**
 * The step's checks again after the user allowed it (a hover-only control is revealed again, as the user's mouse
 * left the page to answer); any stale outcome says that the allowed control changed.
 */
const recheck = <T>(run: () => Promise<T>): Promise<T> =>
  run().catch((error: unknown): never => {
    if (error instanceof StepError && error.result === 'stale') throw new StepError('stale', CHANGED_WHILE_ASKING);
    throw error;
  });

/**
 * Asks the user before input when any of `items` (what the step will click or activate) is risky; throws
 * {@link StepError} `denied` unless they allow. True when it asked: the page may have changed while they decided.
 */
async function confirmRisky(ctx: ActionContext, items: Labeled[]): Promise<boolean> {
  const risky = items.find((item) => isRiskyLabel(item.label));
  if (risky === undefined) return false;
  if (!(await ctx.confirm(sanitizePageText(risky.label, MAX_CONFIRM_LABEL), risky.frame))) {
    throw new StepError('denied', 'the user denied this action');
  }
  return true;
}

/** Order-free identity of what a step would activate, to tell whether it changed while the user decided. */
const signature = (items: Labeled[]): string =>
  items
    .map(({ label, frame }) => `${frame.frameId}\u0000${label}`)
    .sort()
    .join('\n');

/**
 * Runs one of our in-page checks for the gate. One that fails or times out ends the step as `stale`: input never
 * goes out unchecked.
 */
const checkIn = (ctx: ActionContext, frame: FrameHandle, fn: string, args: CallArgument[]): Promise<unknown> =>
  withTimeout(callIn(ctx.conn, frame, fn, args), FRAME_TIMEOUT_MS, 'The check').catch((): never => {
    throw new StepError('stale', CHECK_FAILED);
  });

const strings = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((v) => typeof v === 'string') ? (value as string[]) : null;

/**
 * What a key press would activate, per frame: `t`'s frame, or (no target) every frame's focused control. With no
 * target and the focus on an iframe element no reported frame sees into, the press is unchecked: `stale`.
 */
async function focusLabels(ctx: ActionContext, t: Target | null, key: string): Promise<Labeled[]> {
  const frames = t ? [t.frame] : (await collectFramesReport(ctx.conn, ctx.sessionId)).frames;
  const reports = await Promise.all(
    frames.map(async (frame) => {
      const v = (await checkIn(ctx, frame, ENTER_LABELS, values(t ? t.node : null, key))) as Record<
        string,
        unknown
      > | null;
      const labels = strings(v?.labels);
      if (!labels || typeof v?.framed !== 'boolean' || typeof v.focused !== 'boolean') {
        throw new StepError('stale', CHECK_FAILED);
      }
      return { frame, labels, framed: v.framed, focused: v.focused };
    })
  );
  const reached = reports.some((r) => r.focused && !r.framed);
  if (!t && reports.some((r) => r.framed) && !reached) {
    throw new StepError('stale', 'keyboard focus is in a frame observe cannot see; observe again');
  }
  return reports.flatMap((r) => r.labels.map((label) => ({ label, frame: r.frame })));
}

/** What a click on `t` activates: its own label, and every control or pointer-run under its click point. */
const clickLabels = async (ctx: ActionContext, t: Target): Promise<Labeled[]> => [
  { label: t.label, frame: t.frame },
  ...(await pointLabels(ctx, t.point)),
];

/** Everything a press would click or activate: the target's click, and for a gated key the focused control. */
const pressLabels = async (ctx: ActionContext, t: Target | null, key: string): Promise<Labeled[]> => {
  const activating = ACTIVATING_KEYS.has(key);
  return [
    ...(t ? await clickLabels(ctx, t) : []),
    ...(activating ? await focusLabels(ctx, t, key) : []),
    // A target that cancels mousedown leaves the focus where it was, and the key goes there as well.
    ...(activating && t ? await focusLabels(ctx, null, key) : []),
  ];
};

/**
 * The controls under a top-viewport point in every frame showing it (a cover in an outer page counts as well). A
 * frame whose element at the point is an iframe that no deeper reported frame covers cannot be read: `stale`.
 */
async function pointLabels(ctx: ActionContext, at: Point): Promise<Labeled[]> {
  const { frames } = await collectFramesReport(ctx.conn, ctx.sessionId);
  const here = frames.filter((frame) => inside(at, frame.clip));
  if (here.length === 0) throw new StepError('stale', 'the point is not on a frame observe can see');
  const found = await Promise.all(
    here.map(async (frame) => {
      const v = (await checkIn(
        ctx,
        frame,
        POINT_LABELS,
        values(at.x - frame.offset.x, at.y - frame.offset.y)
      )) as Record<string, unknown> | null;
      const labels = strings(v?.labels);
      if (!labels || typeof v?.framed !== 'boolean') throw new StepError('stale', CHECK_FAILED);
      if (v.framed && !here.some((deeper) => deeper.owners.length > frame.owners.length)) {
        throw new StepError('stale', 'the point is on a frame observe cannot see; observe again');
      }
      return labels.map((label) => ({ label, frame }));
    })
  );
  return found.flat();
}

/** Runs one step's input; returns the frame (and the place in it) whose baseline the step may have changed. */
async function perform(ctx: ActionContext, step: ActStep): Promise<Acted | null> {
  const { op } = step;
  if (op === 'press' || op === 'scroll') return op === 'press' ? press(ctx, step) : scroll(ctx, step);
  const id = need(step.target, `target: a control id from observe, as in {op: '${op}', target: 'f1:12'}`, op);
  let t = await resolveTarget(ctx, id);
  if (op === 'click') {
    const asked = await clickLabels(ctx, t);
    if (await confirmRisky(ctx, asked)) {
      t = await recheck(async () => {
        const again = await resolveTarget(ctx, id);
        if (signature(await clickLabels(ctx, again)) !== signature(asked)) throw new StepError('stale', 'changed');
        return again;
      });
    }
  }
  if (op === 'hover') {
    await mouse(ctx, 'mouseMoved', t.point);
  } else if (op === 'click') {
    await click(ctx, t.point);
  } else if (op === 'type') {
    const text = need(step.text, 'text', op);
    // A native select is a combobox too, but typing into it would only jump between options.
    if (!TEXT_ROLES.has(t.role) || !t.editable || t.options) {
      throw new StepError('error', `${t.id} is not an editable text field.`);
    }
    await click(ctx, t.point);
    await pressKey(ctx, SELECT_ALL, { modifiers: SELECT_ALL_MODIFIER, commands: ['selectAll'] });
    await sendBounded(ctx, 'Input.insertText', { text });
  } else {
    await selectOption(ctx, t, need(step.text, 'the option label as text', op));
  }
  await reportSafely(ctx, { op, label: targetLabel(t), rect: rectOf(t) });
  await settle(ctx, t.frame, op === 'type' && t.role === 'combobox' ? t.node : null);
  return { frame: t.frame, isTop: t.isTop, near: t.local, node: t.node };
}

/** The option of native select `t` that `text` names, as the page labels it in full. */
function optionFor(t: Target, text: string): string {
  if (!t.options) throw new StepError('error', `${t.id} is not a native dropdown; click it open and click the option.`);
  // Compare the way observe showed the options: sanitized and cut.
  const wanted = sanitizePageText(text, MAX_OPTION_LENGTH);
  const option = t.options.find((o) => sanitizePageText(o, MAX_OPTION_LENGTH) === wanted);
  if (option === undefined) throw new StepError('error', `${t.id} has no enabled option with that label.`);
  return option;
}

/**
 * Native selects only (jev's in-page value set plus input and change events); custom dropdowns are clicked. Choosing
 * fires the page's change handler, so a risky option (or select) is asked about first, and re-read after Allow.
 */
async function selectOption(ctx: ActionContext, first: Target, text: string): Promise<void> {
  const labelsFor = (t: Target): Labeled[] => [
    { label: optionFor(t, text), frame: t.frame },
    { label: t.label, frame: t.frame },
  ];
  let t = first;
  const asked = labelsFor(t);
  if (await confirmRisky(ctx, asked)) {
    t = await recheck(async () => {
      const again = await resolveTarget(ctx, first.id);
      if (signature(labelsFor(again)) !== signature(asked)) throw new StepError('stale', 'changed');
      return again;
    });
  }
  // The page picks the option by its full label again, so a list that changed since the check is never misread.
  const chose = await withTimeout(
    callIn(ctx.conn, t.frame, SELECT_OPTION, values(t.node, optionFor(t, text))),
    FRAME_TIMEOUT_MS,
    'Choosing the option'
  ).catch(staleUnlessStep);
  if (chose !== true) {
    throw new StepError('stale', 'the dropdown changed since observe');
  }
}

async function press(ctx: ActionContext, step: ActStep): Promise<Acted | null> {
  const key = need(step.key, 'a key', 'press');
  if (!Object.hasOwn(PRESS_KEYS, key)) throw new StepError('error', `press cannot send ${key}.`);
  const spec = PRESS_KEYS[key];
  let t = step.target ? await resolveTarget(ctx, step.target) : null;
  // A target is clicked first; Enter and Space activate the focused control, and Enter submits its form.
  const asked = await pressLabels(ctx, t, key);
  if (await confirmRisky(ctx, asked)) {
    t = await recheck(async () => {
      const again = step.target ? await resolveTarget(ctx, step.target) : null;
      if (signature(await pressLabels(ctx, again, key)) !== signature(asked)) throw new StepError('stale', 'changed');
      return again;
    });
  }
  if (t) await click(ctx, t.point);
  await pressKey(ctx, spec);
  const label = t ? `${spec.code} on ${targetLabel(t)}` : spec.code;
  await reportSafely(ctx, { op: 'press', label, rect: t ? rectOf(t) : null });
  // Without a target the key went to whatever has focus; the top frame is the one we can re-read for sure.
  const frame = t?.frame ?? (await collectFramesReport(ctx.conn, ctx.sessionId)).frames[0];
  await settle(ctx, frame);
  return { frame, isTop: t?.isTop ?? true, near: t?.local ?? null, node: t?.node ?? null };
}

/**
 * Scrolls about one screen: at a target, its nearest container that can move that way (in its own frame, with no hit
 * test, so a covered list still scrolls); without one, a wheel at the middle of the top frame.
 */
async function scroll(ctx: ActionContext, step: ActStep): Promise<Acted | null> {
  const direction = step.key ?? 'down';
  if (direction !== 'up' && direction !== 'down') throw new StepError('error', 'scroll takes key up or down.');
  const t = step.target ? await resolveTarget(ctx, step.target, false) : null;
  const frame = t?.frame ?? (await collectFramesReport(ctx.conn, ctx.sessionId)).frames[0];
  if (t) {
    const moved = await withTimeout(
      callIn(ctx.conn, t.frame, SCROLL_AT, values(t.node, direction === 'down', SCROLL_SHARE)),
      FRAME_TIMEOUT_MS,
      'The scroll'
    ).catch(staleUnlessStep);
    if (moved !== true) throw new StepError('stale', 'the target changed since observe');
  } else {
    const at = { x: frame.clip.x + frame.clip.w / 2, y: frame.clip.y + frame.clip.h / 2 };
    const deltaY = Math.round(frame.clip.h * SCROLL_SHARE) * (direction === 'up' ? -1 : 1);
    await mouse(ctx, 'mouseWheel', at, { deltaX: 0, deltaY });
  }
  await reportSafely(ctx, {
    op: 'scroll',
    label: t ? `${direction} at ${targetLabel(t)}` : direction,
    rect: t ? rectOf(t) : null,
  });
  await settle(ctx, frame);
  // A scroll moves every control of the frame: the whole frame counts.
  return { frame, isTop: t?.isTop ?? true, near: null, node: null };
}

/** Runs `run`, turning what it throws into an outcome. */
async function attempt<T>(run: () => Promise<T | null>): Promise<{ outcome: Outcome; acted: T | null }> {
  try {
    return { outcome: { result: 'done' }, acted: await run() };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const result = error instanceof StepError ? error.result : 'error';
    return { outcome: { result, reason }, acted: null };
  }
}

/**
 * Re-reads the frame after an action: the new baseline for the next one (its new ids join the registry), whether the
 * action changed what matters ({@link controlsChanged} near where it acted), and what changed for the agent
 * ({@link describeChanges}). Ids the frame no longer lists keep their guards: act still checks each one, and a
 * missing one is stale rather than unknown.
 */
async function rebaseline(
  ctx: ActionContext,
  acted: Acted,
  relook = true
): Promise<{ changed: boolean; changes: ActChanges }> {
  const { frame, near } = acted;
  const before = frameBaseline(ctx.conn, ctx.sessionId, frame.frameKey);
  // null: the document went away (e.g. the click navigated), which is a change.
  const snapshot = await snapshotFrame(ctx.conn, frame).catch((): null => null);
  if (!snapshot) {
    const url = await frameUrl(ctx.conn, frame).catch((): undefined => undefined);
    return { changed: true, changes: describeChanges(before, null, { ...acted, url }) };
  }
  const after = baselineOf(snapshot);
  const changes = describeChanges(before, after, acted);
  // An OOPIF may handle the input, or a page render its answer, after the settle: look once more before saying none.
  if (relook && changes.note === NO_CHANGE) {
    await sleep(RELOOK_MS);
    return rebaseline(ctx, acted, false);
  }
  rememberBaselines(ctx.conn, ctx.sessionId, [[frame.frameKey, keepingGuards(before, after)]]);
  return { changed: !before || controlsChanged(before, after, near), changes };
}

const notRun = (left: number): string => (left ? ` ${left} more action${left === 1 ? '' : 's'} not run.` : '');

const stopNote = (outcome: Outcome, left: number): string => {
  if (outcome.result === 'denied') {
    return `The user denied this action; do not retry it or work around it unless they ask.${notRun(left)}`;
  }
  if (outcome.result === 'stale') return `Stale target: observe again before acting.${notRun(left)}`;
  return `Stopped at an error.${notRun(left)}`;
};

/**
 * Runs `steps` in order on observed ids (spec §4 Action): every input goes to the page session at absolute
 * coordinates, after the per-target freshness checks. Stops at the first step that is not done, and, with
 * `stopOnChange` (default), when a step navigates its frame or adds or removes controls near its target, unless the
 * next step targets one of the controls it added. Never retries.
 * `changes` is what the last step that ran changed in its frame ({@link describeChanges}).
 */
export async function act(
  ctx: ActionContext,
  steps: ActStep[],
  { stopOnChange = true }: { stopOnChange?: boolean } = {}
): Promise<{ results: StepResult[]; stopped?: string; changes?: ActChanges }> {
  const results: StepResult[] = [];
  let changes: ActChanges | undefined;
  const reply = (stopped?: string) => ({ results, ...(stopped ? { stopped } : {}), ...(changes ? { changes } : {}) });
  for (const [i, step] of steps.entries()) {
    const { outcome, acted } = await attempt(() => perform(ctx, step));
    results.push({ op: step.op, ...(step.target ? { target: step.target } : {}), ...outcome });
    const left = steps.length - i - 1;
    if (outcome.result !== 'done') return reply(stopNote(outcome, left));
    if (!acted) continue;
    try {
      const seen = await rebaseline(ctx, acted);
      changes = seen.changes;
      // A step that showed controls (a toolbar after a select) may be followed by a click on one of them.
      const next = steps[i + 1]?.target;
      const expected =
        seen.changes.note !== BIG_CHANGE && seen.changes.added?.some((row) => row.startsWith(`[${next}] `)) === true;
      if (left && seen.changed && stopOnChange && !expected) {
        return reply(`The page changed; observe again.${notRun(left)}`);
      }
    } catch {
      // After the last step the input has run; only the change list is missing.
      if (left) return reply(stopNote({ result: 'error' }, left));
    }
  }
  return reply();
}

/**
 * Drags observed `fromId` onto `toId` (spike §HTML5 drag): press, move in steps, release, all on the page session.
 * An HTML5 drag the page starts is intercepted and completed with dragEnter, dragOver and drop at the target;
 * without one, press, move and release cover pointer-based sortables.
 */
export async function drag(
  ctx: ActionContext,
  fromId: string,
  toId: string,
  position: DragPosition = 'inside'
): Promise<Outcome> {
  const { outcome } = await attempt(async () => {
    const plan = async () => {
      const from = await resolveTarget(ctx, fromId);
      const to = await resolveTarget(ctx, toId);
      const drop = { x: to.point.x, y: to.rect.y + to.rect.h * DROP_AT[position] };
      if (!inside(drop, to.frame.clip)) throw new StepError('stale', 'the drop point is off-screen');
      if (Math.hypot(drop.x - from.point.x, drop.y - from.point.y) < MIN_DRAG_PX) {
        throw new StepError('error', `a drag must move at least ${MIN_DRAG_PX} px; use act click for a click.`);
      }
      return { from, to, drop };
    };
    let { from, to, drop } = await plan();
    // A release on a control after a press near it is a click on it (or on their common parent): same gate.
    const asked = await pointLabels(ctx, drop);
    if (await confirmRisky(ctx, asked)) {
      ({ from, to, drop } = await recheck(async () => {
        const again = await plan();
        if (signature(await pointLabels(ctx, again.drop)) !== signature(asked)) throw new StepError('stale', 'changed');
        return again;
      }));
    }
    await dragBetween(ctx, from.point, drop);
    await reportSafely(ctx, { op: 'drag', label: `${targetLabel(from)} → ${targetLabel(to)}`, rect: rectOf(to) });
    await settle(ctx, to.frame);
    return to.frame;
  });
  return outcome;
}

async function dragBetween(ctx: ActionContext, from: Point, to: Point): Promise<void> {
  let intercepted: (data: unknown) => void = () => undefined;
  const dragData = new Promise<unknown>((resolve) => {
    intercepted = resolve;
  });
  const off = ctx.conn.on('Input.dragIntercepted', (params, sessionId) => {
    if (sessionId === ctx.sessionId) intercepted(params.data);
  });
  let pressed = false;
  let released = false;
  let last = from;
  let failure: { error: unknown } | null = null;
  const keepFirst = (error: unknown): void => {
    failure ??= { error };
  };
  try {
    await sendBounded(ctx, 'Input.setInterceptDrags', { enabled: true });
    await mouse(ctx, 'mouseMoved', from);
    pressed = true; // before the send: a press that times out may still have landed
    await mouse(ctx, 'mousePressed', from, LEFT);
    for (let step = 1; step <= DRAG_STEPS; step++) {
      last = {
        x: from.x + ((to.x - from.x) * step) / DRAG_STEPS,
        y: from.y + ((to.y - from.y) * step) / DRAG_STEPS,
      };
      await mouse(ctx, 'mouseMoved', last, { button: 'left', buttons: 1 });
    }
    const data = await Promise.race([dragData, sleep(DRAG_INTERCEPT_MS).then((): null => null)]);
    if (data && typeof data === 'object') {
      for (const type of ['dragEnter', 'dragOver', 'drop']) {
        await sendBounded(ctx, 'Input.dispatchDragEvent', { type, x: to.x, y: to.y, data });
      }
    }
    await mouse(ctx, 'mouseReleased', to, LEFT);
    released = true;
  } catch (error) {
    keepFirst(error);
  }
  off();
  // Best effort, in this order: a button left down or interception left on would break the user's own drags.
  if (pressed && !released) await mouse(ctx, 'mouseReleased', last, LEFT).catch(keepFirst);
  await sendBounded(ctx, 'Input.setInterceptDrags', { enabled: false }).catch(keepFirst);
  if (failure) throw failure.error;
}

type LayoutMetrics = {
  cssLayoutViewport: { clientWidth: number; clientHeight: number };
  cssVisualViewport: { pageX: number; pageY: number; clientWidth: number; clientHeight: number };
};

const layoutMetrics = (ctx: ActionContext): Promise<LayoutMetrics> =>
  sendBounded<LayoutMetrics>(ctx, 'Page.getLayoutMetrics', {}, FRAME_TIMEOUT_MS);

/**
 * A JPEG (base64) of the tab's visible area in CSS px, or of one observed control. Vision fallback only.
 * Throws {@link StepError} for an unknown or stale target.
 */
export async function screenshot(ctx: ActionContext, targetId?: string): Promise<string> {
  const t = targetId ? await resolveTarget(ctx, targetId, false) : null;
  const { cssVisualViewport: css } = await layoutMetrics(ctx);
  const viewport = { x: 0, y: 0, w: css.clientWidth, h: css.clientHeight };
  // A target shows only where its frame is visible (resolve checked its center, so this is never empty).
  const area = (t ? intersect(t.rect, t.frame.clip) : viewport) ?? viewport;
  // Clip coordinates are document coordinates.
  const clip = {
    x: area.x + css.pageX,
    y: area.y + css.pageY,
    width: Math.min(area.w, MAX_SCREENSHOT_SIDE),
    height: Math.min(area.h, MAX_SCREENSHOT_SIDE),
  };
  // The image comes out in device px; scaling by 1/dpr keeps image px equal to the CSS px click_point takes.
  const capture = async (scale: number): Promise<string> =>
    (
      await sendBounded<{ data: string }>(ctx, 'Page.captureScreenshot', {
        format: 'jpeg',
        quality: 70,
        clip: { ...clip, scale },
      })
    ).data;
  const dpr = await pageDevicePixelRatio(ctx).catch((): null => null);
  if (dpr !== null) return capture(1 / dpr);
  // The page did not answer (frozen, or a dialog is open): the capture still works, so read the ratio off the image.
  const raw = await capture(1);
  const width = jpegWidth(raw);
  const measured = width !== null && clip.width > 0 ? width / clip.width : 1;
  return measured > 1 ? capture(1 / measured) : raw;
}

/** The page's devicePixelRatio, asked in its top frame; rejects when the page does not answer in time. */
async function pageDevicePixelRatio(ctx: ActionContext): Promise<number> {
  const ratio = await withTimeout(
    collectFramesReport(ctx.conn, ctx.sessionId).then(({ frames }) =>
      callIn(ctx.conn, frames[0], DEVICE_PIXEL_RATIO, [])
    ),
    FRAME_TIMEOUT_MS,
    'The page'
  );
  return isNumber(ratio) && ratio > 0 ? ratio : 1;
}

/** Pixel width from a base64 JPEG's SOF header, or null when there is none. */
function jpegWidth(base64: string): number | null {
  const bytes = Buffer.from(base64, 'base64');
  for (let i = 2; i + 8 < bytes.length; ) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1];
    // SOF0-SOF15, except DHT (C4), JPG (C8) and DAC (CC), which share the range.
    if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return bytes.readUInt16BE(i + 7);
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return null;
}

/**
 * Clicks top-viewport CSS px (x, y), e.g. read off a {@link screenshot}. Vision fallback: no freshness checks.
 * Throws when the point is not finite or outside the viewport.
 */
export async function clickPoint(ctx: ActionContext, x: number, y: number): Promise<Outcome> {
  if (!isNumber(x) || !isNumber(y)) throw new Error('click_point needs finite x and y in CSS px.');
  const { cssLayoutViewport: v } = await layoutMetrics(ctx);
  if (x < 0 || y < 0 || x >= v.clientWidth || y >= v.clientHeight) {
    throw new Error(`(${x}, ${y}) is outside the ${v.clientWidth}x${v.clientHeight} viewport.`);
  }
  try {
    const asked = await pointLabels(ctx, { x, y });
    if (await confirmRisky(ctx, asked)) {
      if (signature(await pointLabels(ctx, { x, y })) !== signature(asked)) {
        throw new StepError('stale', CHANGED_WHILE_ASKING);
      }
    }
    await click(ctx, { x, y });
  } catch (error) {
    if (error instanceof StepError) return { result: error.result, reason: error.message };
    throw error;
  }
  await reportSafely(ctx, {
    op: 'click_point',
    label: `(${Math.round(x)}, ${Math.round(y)})`,
    rect: { x, y, width: 0, height: 0 },
  });
  await settle(ctx, null);
  return { result: 'done' };
}
