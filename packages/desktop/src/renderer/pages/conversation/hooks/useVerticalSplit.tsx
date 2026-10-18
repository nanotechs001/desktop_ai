/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Top/bottom split: browser/preview on top, chat on the bottom. The bottom
 * pane's height is kept in px and clamped only by the container — each pane
 * keeps a small sliver so neither can vanish, but there is no other maximum.
 *
 * While dragging, a full-window overlay owns the pointer: the preview hosts a
 * `<webview>` (its own process) that would otherwise swallow mouse events the
 * moment the cursor crosses into it, freezing the divider mid-drag.
 */

export const MIN_SPLIT_PANE_PX = 80;
const KEYBOARD_STEP_PX = 24;

/** Bottom-pane height clamped so both panes keep at least MIN_SPLIT_PANE_PX. */
export const clampBottomPaneHeight = (height: number, containerHeight: number): number => {
  if (containerHeight <= 2 * MIN_SPLIT_PANE_PX) return Math.max(0, Math.round(containerHeight / 2));
  return Math.round(Math.min(Math.max(height, MIN_SPLIT_PANE_PX), containerHeight - MIN_SPLIT_PANE_PX));
};

const readStored = (key: string, fallback: number): number => {
  try {
    const value = parseFloat(localStorage.getItem(key) ?? '');
    return Number.isFinite(value) && value > 0 ? value : fallback;
  } catch {
    return fallback;
  }
};

export function useVerticalSplit({
  storageKey,
  defaultHeight,
  onCollapse,
}: {
  storageKey: string;
  defaultHeight: number;
  /** Dragging the divider below half the minimum height fully hides the bottom pane. */
  onCollapse?: () => void;
}) {
  const [container, setContainer] = useState<HTMLElement | null>(null);
  const [containerHeight, setContainerHeight] = useState(0);
  const [requested, setRequested] = useState(() => readStored(storageKey, defaultHeight));
  const [dragging, setDragging] = useState(false);
  const containerHeightRef = useRef(0);
  containerHeightRef.current = containerHeight;

  useEffect(() => {
    if (!container) return;
    const observer = new ResizeObserver(([entry]) => setContainerHeight(entry.contentRect.height));
    observer.observe(container);
    return () => observer.disconnect();
  }, [container]);

  // Persist once the drag settles, not on every pointer move.
  useEffect(() => {
    if (dragging) return;
    try {
      localStorage.setItem(storageKey, String(Math.round(requested)));
    } catch {
      // Storage unavailable: the height still applies for this session.
    }
  }, [dragging, requested, storageKey]);

  const height = containerHeight > 0 ? clampBottomPaneHeight(requested, containerHeight) : requested;

  const startDrag = useCallback(
    (event: React.PointerEvent) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const startY = event.clientY;
      const startHeight = height;
      let collapse = false;
      setDragging(true);
      const onMove = (e: PointerEvent) => {
        const raw = startHeight + (startY - e.clientY);
        collapse = Boolean(onCollapse) && raw < MIN_SPLIT_PANE_PX / 2;
        setRequested(clampBottomPaneHeight(raw, containerHeightRef.current));
      };
      const onUp = () => {
        // Collapsing keeps the last real height, so reopening restores it.
        if (collapse) {
          setRequested(startHeight);
          onCollapse?.();
        }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        window.removeEventListener('blur', onUp);
        setDragging(false);
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
      window.addEventListener('blur', onUp);
    },
    [height, onCollapse]
  );

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const delta = event.key === 'ArrowUp' ? KEYBOARD_STEP_PX : event.key === 'ArrowDown' ? -KEYBOARD_STEP_PX : 0;
      if (!delta) return;
      event.preventDefault();
      setRequested(clampBottomPaneHeight(height + delta, containerHeightRef.current));
    },
    [height]
  );

  /**
   * In-flow divider strip placed between the two panes. It is not overlaid on the
   * top pane on purpose: the browser's webview layer is painted over the preview
   * area and would cover (and steal clicks from) anything positioned inside it.
   */
  const renderHandle = () => (
    <>
      <div
        role='separator'
        aria-orientation='horizontal'
        aria-valuenow={Math.round(height)}
        tabIndex={0}
        className='group relative shrink-0 h-6px cursor-row-resize flex items-center outline-none bg-1'
        onPointerDown={startDrag}
        onKeyDown={onKeyDown}
      >
        <div className='w-full h-1px bg-[var(--bg-3)] group-hover:h-2px group-hover:bg-[var(--primary)] group-focus-visible:h-2px group-focus-visible:bg-[var(--primary)]' />
      </div>
      {dragging && <div className='fixed inset-0 z-[9999] cursor-row-resize' />}
    </>
  );

  return { height, containerRef: setContainer, dragging, renderHandle };
}
