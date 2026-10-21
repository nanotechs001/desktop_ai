/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Pure placement math for floating agent widgets. No Electron imports, so it
 * is unit-testable with plain display fixtures. All values are DIP (Electron's
 * `screen` API already folds in display scaling).
 */

export type Rect = { x: number; y: number; width: number; height: number };

export type DisplayLike = { id: number; bounds: Rect; workArea: Rect };

export type TaskbarEdge = 'bottom' | 'top' | 'left' | 'right' | 'none';

/** The horizontal line a robot walks along: `y` is the robot's top, x spans its left edge. */
export type WalkTrack = {
  edge: TaskbarEdge;
  minX: number;
  maxX: number;
  y: number;
  workArea: Rect;
};

export type WidgetPlacement = {
  bounds: Rect;
  popupSide: 'left' | 'right';
  popupVertical: 'above' | 'below';
  /** Robot's x offset inside `bounds`. */
  botOffsetX: number;
};

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), Math.max(lo, hi));

/** Which screen edge the OS taskbar occupies, inferred from the gap between bounds and work area. */
export function getTaskbarEdge(display: DisplayLike): TaskbarEdge {
  const { bounds: b, workArea: w } = display;
  if (w.y + w.height < b.y + b.height) return 'bottom';
  if (w.y > b.y) return 'top';
  if (w.x > b.x) return 'left';
  if (w.x + w.width < b.x + b.width) return 'right';
  return 'none';
}

/**
 * The robot stands on the work area's bottom edge — which is exactly the
 * taskbar's top border when the taskbar is at the bottom. A top taskbar makes
 * the robot hang just below it; side or auto-hidden taskbars fall back to the
 * bottom of the work area so the walking path stays horizontal.
 */
export function getWalkTrack(display: DisplayLike, botSize: number): WalkTrack {
  const w = display.workArea;
  const edge = getTaskbarEdge(display);
  return {
    edge,
    minX: w.x,
    maxX: w.x + w.width - botSize,
    y: edge === 'top' ? w.y : w.y + w.height - botSize,
    workArea: w,
  };
}

export function xFromRatio(track: WalkTrack, ratio: number | undefined): number {
  const r = ratio === undefined || !Number.isFinite(ratio) ? 0.85 : clamp(ratio, 0, 1);
  return Math.round(track.minX + r * (track.maxX - track.minX));
}

export function ratioFromX(track: WalkTrack, x: number): number {
  const span = track.maxX - track.minX;
  return span > 0 ? clamp((x - track.minX) / span, 0, 1) : 0;
}

/**
 * Window bounds for a widget. Collapsed: the robot box plus `headroom` transparent px above it for hops; the
 * robot's bottom (its taskbar contact point) is at the same y either way.
 * Expanded: the popup sits above (or below, for a top taskbar) the robot and
 * extends right when it fits, otherwise left, always clamped to the work area.
 */
export function computePlacement(
  track: WalkTrack,
  botX: number,
  botSize: number,
  expanded: boolean,
  popup: { width: number; height: number },
  headroom = 0
): WidgetPlacement {
  const x = clamp(botX, track.minX, track.maxX);
  const popupVertical = track.edge === 'top' ? 'below' : 'above';
  if (!expanded) {
    return {
      bounds: { x, y: track.y - headroom, width: botSize, height: botSize + headroom },
      popupSide: 'right',
      popupVertical,
      botOffsetX: 0,
    };
  }

  const wa = track.workArea;
  const width = Math.min(Math.max(popup.width, botSize), wa.width);
  const height = Math.min(popup.height + botSize, wa.height);
  const right = wa.x + wa.width;
  const popupSide = x + width <= right ? 'right' : 'left';
  const wx = clamp(popupSide === 'right' ? x : x + botSize - width, wa.x, right - width);
  const wy = popupVertical === 'below' ? track.y : track.y + botSize - height;
  return { bounds: { x: wx, y: wy, width, height }, popupSide, popupVertical, botOffsetX: x - wx };
}

/** The band above the expanded window's panel is this fraction of the robot; the rest overlaps the panel's top. */
export const EXPANDED_BAND_RATIO = 0.75;
const EXPANDED_PANEL = { width: 960, height: 640 };
// Gap kept between the expanded window and the work area's edges (total for both sides).
const EXPANDED_MARGIN_PX = 48;
// Where the robot first stands: this far from the panel's right edge.
const EXPANDED_START_INSET_PX = 24;
// The robot walks no closer than this to the window's left and right edges.
const BAND_WALK_INSET_PX = 16;

// Room above the robot for its slime hop (the hop itself is drawn by the renderer).
export const HOP_HEADROOM_PX = 12;

/** The band holds the hop headroom plus the part of the robot above the panel. */
export const expandedBandHeight = (botSize: number): number =>
  HOP_HEADROOM_PX + Math.round(botSize * EXPANDED_BAND_RATIO);

/** The x range (robot's left edge, inside the window) the robot walks along the expanded window's top band. */
export function bandWalkRange(windowWidth: number, botSize: number): { min: number; max: number } {
  return { min: BAND_WALK_INSET_PX, max: Math.max(BAND_WALK_INSET_PX, windowWidth - botSize - BAND_WALK_INSET_PX) };
}

/** The expanded window (a top band holding the robot plus the chat panel below it), centred in the work area. */
export function expandedWindowBounds(workArea: Rect, botSize: number): Rect {
  const band = expandedBandHeight(botSize);
  const width = Math.min(EXPANDED_PANEL.width, workArea.width - EXPANDED_MARGIN_PX);
  const height = band + Math.min(EXPANDED_PANEL.height, workArea.height - EXPANDED_MARGIN_PX - band);
  return {
    x: workArea.x + Math.round((workArea.width - width) / 2),
    y: workArea.y + Math.round((workArea.height - height) / 2),
    width,
    height,
  };
}

/**
 * The robot inside the expanded window at `bounds`: `botOffsetX` is its x inside the window (null: the panel's
 * top-right), kept within the walk range.
 */
export function bandPlacement(bounds: Rect, botSize: number, botOffsetX: number | null): WidgetPlacement {
  const range = bandWalkRange(bounds.width, botSize);
  const offset = clamp(botOffsetX ?? bounds.width - botSize - EXPANDED_START_INSET_PX, range.min, range.max);
  return { bounds, popupSide: 'right', popupVertical: 'below', botOffsetX: offset };
}

// Each further expanded window on a display opens this much lower and to the right, so none hides another.
const CASCADE_STEP_PX = 28;

/** `bounds` moved `steps` cascade steps down and right, kept inside the work area. */
export function cascadeBounds(bounds: Rect, steps: number, workArea: Rect): Rect {
  const shift = steps * CASCADE_STEP_PX;
  return {
    ...bounds,
    x: clamp(bounds.x + shift, workArea.x, workArea.x + workArea.width - bounds.width),
    y: clamp(bounds.y + shift, workArea.y, workArea.y + workArea.height - bounds.height),
  };
}

/** The smallest chat panel (below the band) a resize leaves. */
export const EXPANDED_MIN_PANEL = { width: 640, height: 440 };
// The title bar under the band stays on screen, so a moved window can always be grabbed again.
const HEADER_REACH_PX = 56;
// At least this much of a moved window's width stays on screen.
const MIN_VISIBLE_WIDTH_PX = 160;

/** The expanded window at `rect`, kept where its band and title bar are in `workArea` and part of it shows sideways. */
export function keepWindowReachable(rect: Rect, workArea: Rect, band: number): Rect {
  return {
    ...rect,
    x: clamp(
      rect.x,
      workArea.x + MIN_VISIBLE_WIDTH_PX - rect.width,
      workArea.x + workArea.width - MIN_VISIBLE_WIDTH_PX
    ),
    y: clamp(rect.y, workArea.y, workArea.y + workArea.height - band - HEADER_REACH_PX),
  };
}

/** The point on the expanded window's title bar that says which display the window is on. */
export const windowHeaderPoint = (rect: Rect, band: number): { x: number; y: number } => ({
  x: Math.round(rect.x + rect.width / 2),
  y: Math.round(rect.y + band + HEADER_REACH_PX / 2),
});

/**
 * The expanded window resized from `origin` by dragging `edge` (a side or a corner) by (dx, dy): the opposite sides
 * stay, the panel keeps at least its minimum size, and the moved sides stay inside the work area.
 */
export function resizeWindow(
  origin: Rect,
  edge: 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw',
  delta: { dx: number; dy: number },
  workArea: Rect,
  band: number
): Rect {
  const minWidth = EXPANDED_MIN_PANEL.width;
  const minHeight = band + EXPANDED_MIN_PANEL.height;
  const right = origin.x + origin.width;
  const bottom = origin.y + origin.height;
  const left = edge.includes('w') ? clamp(origin.x + delta.dx, workArea.x, right - minWidth) : origin.x;
  const top = edge.includes('n') ? clamp(origin.y + delta.dy, workArea.y, bottom - minHeight) : origin.y;
  const newRight = edge.includes('e') ? clamp(right + delta.dx, left + minWidth, workArea.x + workArea.width) : right;
  const newBottom = edge.includes('s')
    ? clamp(bottom + delta.dy, top + minHeight, workArea.y + workArea.height)
    : bottom;
  return { x: left, y: top, width: newRight - left, height: newBottom - top };
}

/** Remembered expanded bounds still fit when a display's work area holds their centre and their whole size. */
export function fitsSomeWorkArea(rect: Rect, workAreas: Rect[]): boolean {
  const cx = rect.x + rect.width / 2;
  const cy = rect.y + rect.height / 2;
  return workAreas.some(
    (w) =>
      cx >= w.x &&
      cx < w.x + w.width &&
      cy >= w.y &&
      cy < w.y + w.height &&
      rect.width <= w.width &&
      rect.height <= w.height
  );
}

/**
 * Nearest x to `desired` that keeps one robot-width-plus-gap away from every
 * other robot on the same track. When the track is full, robots group
 * compactly (overlapping by half) instead of stacking exactly on top.
 */
export function resolveSlot(desired: number, others: number[], track: WalkTrack, botSize: number): number {
  const minDist = Math.round(botSize * 1.25);
  const x0 = clamp(desired, track.minX, track.maxX);
  const free = (x: number) => others.every((o) => Math.abs(o - x) >= minDist);
  if (free(x0)) return x0;

  const candidates = others
    .flatMap((o) => [o - minDist, o + minDist])
    .filter((c) => c >= track.minX && c <= track.maxX && free(c))
    .toSorted((a, b) => Math.abs(a - x0) - Math.abs(b - x0));
  if (candidates.length > 0) return candidates[0];

  // ponytail: crowded track → offset by half a robot; add an overflow drawer if dozens of agents become common.
  const compact = Math.round(botSize / 2);
  const nearest = others.reduce((best, o) => (Math.abs(o - x0) < Math.abs(best - x0) ? o : best), others[0]);
  const shifted = nearest + compact <= track.maxX ? nearest + compact : nearest - compact;
  return clamp(shifted, track.minX, track.maxX);
}

/** Where the robot stands to be right under the mouse: its centre at the cursor's x, kept on the track. */
export function followTarget(cursorX: number, track: WalkTrack, botSize: number): number {
  return clamp(Math.round(cursorX - botSize / 2), track.minX, track.maxX);
}

/**
 * The next stop of an idle stroll toward `target`: a short stretch (40–160 px, by `random`), never past the
 * target and never off the track. Many short strolls at random intervals get the robot to the mouse slowly.
 */
export function stepToward(x: number, target: number, track: WalkTrack, random: () => number = Math.random): number {
  const delta = target - x;
  const distance = Math.min(Math.abs(delta), 40 + Math.round(random() * 120));
  return clamp(x + Math.sign(delta) * distance, track.minX, track.maxX);
}

/**
 * Where a carried robot's box goes: the cursor minus the grab offset (so it never snaps its centre to the pointer),
 * kept inside the work area of the display under the cursor — never over the taskbar.
 */
export function carriedPosition(
  cursor: { x: number; y: number },
  grab: { x: number; y: number },
  workArea: Rect,
  botSize: number
): { x: number; y: number } {
  return {
    x: clamp(cursor.x - grab.x, workArea.x, workArea.x + workArea.width - botSize),
    y: clamp(cursor.y - grab.y, workArea.y, workArea.y + workArea.height - botSize),
  };
}

/**
 * The robot's top while it falls from `fromY` back onto the walk track at `toY`: accelerating like a drop and
 * reaching the track exactly at `impactMs` (in step with drop-landing's impact frame), then resting there.
 */
export function landingY(fromY: number, toY: number, elapsedMs: number, impactMs: number): number {
  if (impactMs <= 0 || elapsedMs >= impactMs) return toY;
  const t = Math.max(0, elapsedMs) / impactMs;
  return Math.round(fromY + (toY - fromY) * t * t);
}

/**
 * The rect `t` (0..1) of the way from `from` to `to` along an ease-in-out curve (cubic): a gentle start and stop, so
 * the window does not leap on its first step the way an ease-out does.
 */
export function easeInOutRect(from: Rect, to: Rect, t: number): Rect {
  const u = clamp(t, 0, 1);
  const k = u < 0.5 ? 4 * u ** 3 : 1 - (-2 * u + 2) ** 3 / 2;
  const at = (a: number, b: number) => Math.round(a + (b - a) * k);
  return {
    x: at(from.x, to.x),
    y: at(from.y, to.y),
    width: at(from.width, to.width),
    height: at(from.height, to.height),
  };
}

/** `rect` on whole pixels, the only bounds Electron windows accept. */
export const roundRect = (rect: Rect): Rect => ({
  x: Math.round(rect.x),
  y: Math.round(rect.y),
  width: Math.round(rect.width),
  height: Math.round(rect.height),
});
