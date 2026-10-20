/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState, type RefObject } from 'react';
import type { FrameMeta } from './frameCodec';
import { clampViewport, pointOnFrame, UNZOOMED, zoomAround, type LiveViewport, type ViewPoint } from './liveViewport';
import type { LiveClientMessage } from './useBrowserLiveStream';

const TAP_SLOP_PX = 10;
const TAP_MAX_MS = 500;
/** A second tap this soon and this close is a double-tap, so a single tap waits this long before it is sent. */
const DOUBLE_TAP_MS = 250;
const DOUBLE_TAP_SLOP_PX = 30;
const DOUBLE_TAP_ZOOM = 2;
const BUTTON_ZOOM_STEP = 1.5;
const MAX_SCROLL_DELTA_PX = 10_000;

type FramePoint = { nx: number; ny: number };

/** One finger: a tap, a scroll at 1x, or a pan while zoomed. */
type Drag = {
  kind: 'drag';
  start: ViewPoint;
  at: number;
  startView: LiveViewport;
  mode: 'undecided' | 'scroll' | 'pan';
  lastY: number;
  pendingDy: number;
  frame: number;
};
type Pinch = { kind: 'pinch'; distance: number; mid: ViewPoint; startView: LiveViewport };
/** A pinch lost a finger: the rest of this touch does nothing. */
type Spent = { kind: 'spent' };
type Gesture = Drag | Pinch | Spent;

type PendingTap = { point: ViewPoint; target: FramePoint | null; timer: ReturnType<typeof setTimeout> };

type Options = {
  surfaceRef: RefObject<HTMLElement | null>;
  imgRef: RefObject<HTMLImageElement | null>;
  metaRef: RefObject<FrameMeta | null>;
  send: (message: LiveClientMessage) => void;
  /** After a tap is sent: the page may have focused a text field. */
  onTap: () => void;
};

type PointerHandlers = {
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerMove: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerUp: (event: React.PointerEvent<HTMLElement>) => void;
  onPointerCancel: (event: React.PointerEvent<HTMLElement>) => void;
};

export type LiveGestures = {
  viewport: LiveViewport;
  handlers: PointerHandlers;
  zoomIn: () => void;
  zoomOut: () => void;
  resetZoom: () => void;
};

const distance = (a: ViewPoint, b: ViewPoint): number => Math.hypot(a.x - b.x, a.y - b.y);
const midpoint = (a: ViewPoint, b: ViewPoint): ViewPoint => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/**
 * Pointer gestures on the live picture. One finger taps (sent after the double-tap window), scrolls the page at 1x
 * and pans the picture when zoomed; two fingers pinch-zoom 1x..4x; a double-tap zooms to 2x there or back to 1x.
 */
export const useLiveGestures = ({ surfaceRef, imgRef, metaRef, send, onTap }: Options): LiveGestures => {
  const [viewport, setViewportState] = useState<LiveViewport>(UNZOOMED);
  const viewportRef = useRef<LiveViewport>(UNZOOMED);
  const pointersRef = useRef(new Map<number, ViewPoint>());
  const gestureRef = useRef<Gesture | null>(null);
  const pendingTapRef = useRef<PendingTap | null>(null);

  const setViewport = useCallback((next: LiveViewport) => {
    viewportRef.current = next;
    setViewportState(next);
  }, []);

  const viewRect = useCallback(() => {
    const rect = surfaceRef.current?.getBoundingClientRect();
    return { left: rect?.left ?? 0, top: rect?.top ?? 0, width: rect?.width ?? 0, height: rect?.height ?? 0 };
  }, [surfaceRef]);

  const toView = (event: React.PointerEvent): ViewPoint => {
    const rect = viewRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };

  const locate = useCallback(
    (point: ViewPoint) => {
      const img = imgRef.current;
      const frame = { width: img?.naturalWidth ?? 0, height: img?.naturalHeight ?? 0 };
      return pointOnFrame(viewportRef.current, viewRect(), frame, point);
    },
    [imgRef, viewRect]
  );

  const sendScroll = useCallback(
    (drag: Drag) => {
      const point = locate(drag.start);
      const meta = metaRef.current;
      if (!point || !meta || drag.pendingDy === 0) return;
      // Phone px over the drawn frame -> page CSS px (the frame spans deviceHeight / pageScaleFactor of them).
      const pageDy = (-drag.pendingDy / point.height) * (meta.deviceHeight / meta.pageScaleFactor);
      drag.pendingDy = 0;
      const dy = Math.max(-MAX_SCROLL_DELTA_PX, Math.min(MAX_SCROLL_DELTA_PX, pageDy));
      send({ type: 'scroll', nx: point.nx, ny: point.ny, dy });
    },
    [locate, metaRef, send]
  );

  const commitTap = useCallback(
    (tap: PendingTap) => {
      clearTimeout(tap.timer);
      if (pendingTapRef.current === tap) pendingTapRef.current = null;
      if (!tap.target) return;
      send({ type: 'tap', nx: tap.target.nx, ny: tap.target.ny });
      onTap();
    },
    [onTap, send]
  );

  const endDrag = useCallback(() => {
    const gesture = gestureRef.current;
    if (gesture?.kind === 'drag' && gesture.frame) cancelAnimationFrame(gesture.frame);
  }, []);

  useEffect(
    () => () => {
      endDrag();
      if (pendingTapRef.current) clearTimeout(pendingTapRef.current.timer);
    },
    [endDrag]
  );

  const handleTap = (point: ViewPoint): void => {
    const pending = pendingTapRef.current;
    if (pending && distance(pending.point, point) <= DOUBLE_TAP_SLOP_PX) {
      clearTimeout(pending.timer);
      pendingTapRef.current = null;
      const current = viewportRef.current;
      setViewport(
        current.scale > UNZOOMED.scale ? UNZOOMED : zoomAround(current, DOUBLE_TAP_ZOOM, point, point, viewRect())
      );
      return;
    }
    if (pending) commitTap(pending);
    const tap: PendingTap = { point, target: locate(point), timer: setTimeout(() => commitTap(tap), DOUBLE_TAP_MS) };
    pendingTapRef.current = tap;
  };

  const startPinch = (): void => {
    const [a, b] = [...pointersRef.current.values()];
    gestureRef.current = {
      kind: 'pinch',
      distance: distance(a, b),
      mid: midpoint(a, b),
      startView: viewportRef.current,
    };
  };

  const onPointerDown = (event: React.PointerEvent<HTMLElement>): void => {
    // Keeps pointerup coming here when a mouse drag is released outside the view.
    try {
      event.currentTarget.setPointerCapture(event.pointerId);
    } catch (error) {
      console.warn('[BrowserLiveView] could not capture the pointer:', error);
    }
    const point = toView(event);
    pointersRef.current.set(event.pointerId, point);
    endDrag();
    if (pointersRef.current.size === 2) return startPinch();
    if (pointersRef.current.size > 2) return;
    gestureRef.current = {
      kind: 'drag',
      start: point,
      at: event.timeStamp,
      startView: viewportRef.current,
      mode: 'undecided',
      lastY: point.y,
      pendingDy: 0,
      frame: 0,
    };
  };

  const moveDrag = (drag: Drag, point: ViewPoint): void => {
    const dx = point.x - drag.start.x;
    const dy = point.y - drag.start.y;
    if (drag.mode === 'undecided') {
      if (drag.startView.scale > UNZOOMED.scale && Math.hypot(dx, dy) > TAP_SLOP_PX) drag.mode = 'pan';
      else if (drag.startView.scale === UNZOOMED.scale && Math.abs(dy) > TAP_SLOP_PX) drag.mode = 'scroll';
    }
    if (drag.mode === 'pan') {
      setViewport(clampViewport({ ...drag.startView, x: drag.startView.x + dx, y: drag.startView.y + dy }, viewRect()));
    } else if (drag.mode === 'scroll') {
      drag.pendingDy += point.y - drag.lastY;
      drag.lastY = point.y;
      if (!drag.frame)
        drag.frame = requestAnimationFrame(() => {
          drag.frame = 0;
          sendScroll(drag);
        });
    }
  };

  const onPointerMove = (event: React.PointerEvent<HTMLElement>): void => {
    const gesture = gestureRef.current;
    if (!gesture || !pointersRef.current.has(event.pointerId)) return;
    const point = toView(event);
    pointersRef.current.set(event.pointerId, point);
    if (gesture.kind === 'drag') return moveDrag(gesture, point);
    if (gesture.kind !== 'pinch' || pointersRef.current.size < 2) return;
    const [a, b] = [...pointersRef.current.values()];
    const scale = (gesture.startView.scale * distance(a, b)) / Math.max(1, gesture.distance);
    setViewport(zoomAround(gesture.startView, scale, gesture.mid, midpoint(a, b), viewRect()));
  };

  /** A finger left: a pinch is over for this touch; a drag ends as a tap, a last scroll, or a pan. */
  const release = (event: React.PointerEvent<HTMLElement>, cancelled: boolean): void => {
    pointersRef.current.delete(event.pointerId);
    const gesture = gestureRef.current;
    endDrag();
    gestureRef.current = pointersRef.current.size > 0 ? { kind: 'spent' } : null;
    if (cancelled || gesture?.kind !== 'drag') return;
    if (gesture.mode === 'scroll') return sendScroll(gesture);
    if (gesture.mode === 'pan') return;
    const moved = distance(toView(event), gesture.start);
    if (moved <= TAP_SLOP_PX && event.timeStamp - gesture.at <= TAP_MAX_MS) handleTap(gesture.start);
  };

  const zoomBy = (factor: number): void => {
    const view = viewRect();
    const centre = { x: view.width / 2, y: view.height / 2 };
    const current = viewportRef.current;
    setViewport(zoomAround(current, current.scale * factor, centre, centre, view));
  };
  const resetZoom = useCallback(() => setViewport(UNZOOMED), [setViewport]);

  return {
    viewport,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp: (event) => release(event, false),
      onPointerCancel: (event) => release(event, true),
    },
    zoomIn: () => zoomBy(BUTTON_ZOOM_STEP),
    zoomOut: () => zoomBy(1 / BUTTON_ZOOM_STEP),
    resetZoom,
  };
};
