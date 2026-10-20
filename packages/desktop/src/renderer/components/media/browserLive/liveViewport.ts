/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Zoom and pan of the live picture: a CSS `translate(x, y) scale(scale)` with origin top-left on the picture's
 * wrapper. The stream itself is never resized. Points are in CSS px from the view's top-left corner.
 */
export type LiveViewport = { x: number; y: number; scale: number };
export type ViewPoint = { x: number; y: number };
type Size = { width: number; height: number };

export const MIN_ZOOM = 1;
export const MAX_ZOOM = 4;
export const UNZOOMED: LiveViewport = { x: 0, y: 0, scale: MIN_ZOOM };

const clampScale = (scale: number): number => Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, scale));

/** Keeps the zoomed picture covering the whole view, so it can't be dragged off-screen. */
export const clampViewport = ({ x, y, scale }: LiveViewport, view: Size): LiveViewport => {
  const s = clampScale(scale);
  const clampAxis = (offset: number, size: number): number => Math.min(0, Math.max(size - size * s, offset));
  return { x: clampAxis(x, view.width), y: clampAxis(y, view.height), scale: s };
};

/** Zooms `start` to `scale`, moving the picture point that was under `from` to `to` (both the same for a fixed point). */
export const zoomAround = (
  start: LiveViewport,
  scale: number,
  from: ViewPoint,
  to: ViewPoint,
  view: Size
): LiveViewport => {
  const s = clampScale(scale);
  const x = to.x - ((from.x - start.x) / start.scale) * s;
  const y = to.y - ((from.y - start.y) / start.scale) * s;
  return clampViewport({ x, y, scale: s }, view);
};

/**
 * A view point as a fraction of the frame `object-fit: contain` draws in the view, through the zoom; null in the
 * letterbox around it or before a frame. `height` is the drawn frame's on-screen height.
 */
export const pointOnFrame = (
  viewport: LiveViewport,
  view: Size,
  frame: Size,
  point: ViewPoint
): { nx: number; ny: number; height: number } | null => {
  if (!frame.width || !frame.height || !view.width || !view.height) return null;
  const fit = Math.min(view.width / frame.width, view.height / frame.height);
  const width = frame.width * fit;
  const height = frame.height * fit;
  // The unzoomed picture point under `point`.
  const px = (point.x - viewport.x) / viewport.scale;
  const py = (point.y - viewport.y) / viewport.scale;
  const nx = (px - (view.width - width) / 2) / width;
  const ny = (py - (view.height - height) / 2) / height;
  return nx < 0 || nx > 1 || ny < 0 || ny > 1 ? null : { nx, ny, height: height * viewport.scale };
};
