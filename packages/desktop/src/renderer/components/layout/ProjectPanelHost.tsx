/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Layout-level Project Panel host (stage3 FULL / P1–P4). This is the project's
 * right-side panel host: it owns the column's width, border and lifecycle, and
 * mounts a self-contained project component inside. The titlebar owns the desktop
 * collapse control. For this round
 * the hosted component is the Explorer ({@link ExplorerContainer}); the host is
 * named generically (not `ProjectExplorerColumn`) so future project-scoped
 * components (source-control, kanban, …) can mount through the same seam without
 * re-architecting the host — no plugin framework is introduced this round.
 *
 * Seam: the host passes only `projectId` down; the component self-manages its
 * content (data, tree, actions). Host chrome (the drag handle) is the host's
 * concern, never the component's.
 *
 * Rendered as a sibling of the route `<Outlet>`, above the per-conversation
 * subtree, so switching conversations within the same project does NOT remount it
 * — WS subscriptions, tree and preview stay live (no teardown, no flicker).
 * Collapsing shrinks the column to width 0 (kept mounted) rather than
 * unmounting, so collapse/expand also preserves state. `data-mount-id` (once per
 * mount) is the live-test proof it is not remounted across switches or collapse.
 */

import React, { useRef } from 'react';

import { ExplorerContainer } from '@/renderer/pages/conversation/explorer/ExplorerContainer';
import { useCurrentProject } from '@/renderer/pages/conversation/explorer/currentProjectStore';
import { MOTION_MS, useAnimating } from '@/renderer/hooks/ui/useMotion';

export type ProjectPanelHostProps = {
  /** Rendered width in px (clamped by Layout against the chat+preview reserve). */
  widthPx: number;
  /** Collapsed → width 0, component kept mounted (no remount). */
  collapsed: boolean;
  /** Left-edge resize handle from Layout's `useResizableSplit`. */
  dragHandle?: React.ReactNode;
  /** Takes its row's whole width (the VA Bot bottom row while the chat is collapsed): no fixed width, border or handle. */
  fill?: boolean;
};

export const ProjectPanelHost: React.FC<ProjectPanelHostProps> = ({ widthPx, collapsed, dragHandle, fill = false }) => {
  const projectId = useCurrentProject();
  const mountIdRef = useRef<string>('');
  // The column eases open and shut only while the toggle runs, so dragging its edge stays immediate.
  const toggling = useAnimating(collapsed, MOTION_MS.base);
  if (mountIdRef.current === '') mountIdRef.current = `pec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // No active project (no-project conversation / non-chat route) → no host.
  if (!projectId) return null;

  return (
    <div
      data-project-panel-host
      data-explorer-column
      data-mount-id={mountIdRef.current}
      data-collapsed={collapsed ? 'true' : 'false'}
      className='!bg-1 h-full flex-shrink-0 overflow-hidden relative'
      style={{
        width: collapsed ? '0px' : fill ? undefined : `${widthPx}px`,
        flexGrow: fill && !collapsed ? 1 : undefined,
        // An inset line, not a border: it shrinks away with the column instead of popping.
        boxShadow: collapsed || fill ? undefined : 'inset 1px 0 0 var(--bg-3)',
        transition: toggling ? 'width var(--motion-base) var(--motion-ease-out)' : undefined,
      }}
    >
      {!collapsed && !fill && dragHandle}
      {/* Keeps its width while the column eases, so the tree does not reflow every frame. */}
      <div className='h-full' style={{ width: fill ? '100%' : `${widthPx}px` }}>
        {/* Hosted project component (this round: Explorer). Seam = projectId only. */}
        <ExplorerContainer projectId={projectId} />
      </div>
    </div>
  );
};
