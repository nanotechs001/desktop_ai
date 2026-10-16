/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import type { AgentActionEvent } from '@/common/types/browser';

/** How long the latest agent action stays highlighted. */
export const AGENT_HIGHLIGHT_MS = 1500;

/** Height of the label chip; a box closer to the top edge than this gets its label inside instead of above. */
const LABEL_HEIGHT_PX = 20;

export type AgentOverlayProps = {
  /** The newest action for this tab; each new object restarts the highlight. */
  action: AgentActionEvent | null;
};

/**
 * Outlines the element the agent just acted on. It covers the page area below the nav bar and never takes
 * pointer input (a webview under a clickable overlay stops receiving clicks).
 * Rects are the page's CSS px from its top-left; the webview runs at zoom 1, so they map 1:1 to screen px.
 */
const AgentOverlay: React.FC<AgentOverlayProps> = ({ action }) => {
  const [visibleAction, setVisibleAction] = useState<AgentActionEvent | null>(null);

  useEffect(() => {
    setVisibleAction(action);
    if (!action) return;
    const timer = window.setTimeout(() => setVisibleAction(null), AGENT_HIGHLIGHT_MS);
    return () => window.clearTimeout(timer);
  }, [action]);

  const rect = visibleAction?.rect;
  if (!visibleAction || !rect) return null;

  return (
    <div className='absolute inset-x-0 bottom-0 top-40px z-10 overflow-hidden' style={{ pointerEvents: 'none' }}>
      <div
        data-testid='agent-highlight'
        className='absolute rd-4px border-2 border-solid border-primary bg-primary-light-1'
        style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }}
      >
        {/* The label is model-influenced text: rendered as a text node only. */}
        <span
          className='absolute start-0 max-w-240px truncate rd-4px bg-primary px-6px text-12px text-white'
          style={{ top: rect.y < LABEL_HEIGHT_PX + 4 ? rect.height : -LABEL_HEIGHT_PX - 2 }}
        >
          {visibleAction.label}
        </span>
      </div>
    </div>
  );
};

export default AgentOverlay;
