/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Mobile form of the Project Panel host (stage3 FULL / P3–P4). On mobile the host
 * cannot occupy a fixed column, so it renders as a right-side overlay: backdrop +
 * fixed panel + floating collapse handle — mirroring the legacy
 * `MobileWorkspaceOverlay`, hoisted to the Layout level and mounting the
 * self-contained hosted component ({@link ExplorerContainer}).
 *
 * The panel stays mounted and slides off-screen (`translateX(100%)`) when
 * collapsed, so the tree + WS state survive open/close within a mobile session
 * (same no-remount principle as the desktop host column).
 */

import classNames from 'classnames';
import React, { useRef } from 'react';

import { ExplorerContainer } from '@/renderer/pages/conversation/explorer/ExplorerContainer';
import { MOTION_MS, useAnimating, useSettledAfter } from '@/renderer/hooks/ui/useMotion';

export type ProjectPanelMobileOverlayProps = {
  projectId: string;
  collapsed: boolean;
  /** Collapse (close) the overlay — backdrop tap / floating handle. */
  onCollapse: () => void;
  widthPx: number;
};

export const ProjectPanelMobileOverlay: React.FC<ProjectPanelMobileOverlayProps> = ({
  projectId,
  collapsed,
  onCollapse,
  widthPx,
}) => {
  const mountIdRef = useRef<string>('');
  if (mountIdRef.current === '') mountIdRef.current = `pem-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  // The panel slides and its backdrop and handle fade out before they go; not on the frames right after mounting.
  const settled = useSettledAfter(projectId);
  const closing = useAnimating(collapsed, MOTION_MS.base) && collapsed;

  return (
    <>
      {/* Backdrop */}
      {(!collapsed || closing) && (
        <div
          className='fixed inset-0 bg-black/30 z-90 motion-backdrop'
          style={{ opacity: collapsed ? 0 : 1, pointerEvents: collapsed ? 'none' : undefined }}
          onClick={onCollapse}
          aria-hidden='true'
        />
      )}

      {/* Fixed panel (kept mounted; slides off-screen when collapsed) */}
      <div
        data-explorer-mobile-overlay
        data-mount-id={mountIdRef.current}
        data-collapsed={collapsed ? 'true' : 'false'}
        className={classNames('!bg-1 relative', settled && 'motion-sheet')}
        style={{
          position: 'fixed',
          right: 0,
          top: 0,
          height: '100vh',
          width: `${Math.round(widthPx)}px`,
          zIndex: 100,
          transform: collapsed ? 'translateX(100%)' : 'translateX(0)',
          pointerEvents: collapsed ? 'none' : 'auto',
          borderLeft: '1px solid var(--bg-3)',
        }}
      >
        <ExplorerContainer projectId={projectId} />
      </div>

      {/* Floating collapse handle */}
      {(!collapsed || closing) && (
        <button
          type='button'
          className='fixed z-101 flex items-center justify-center transition-colors workspace-toggle-floating motion-backdrop'
          style={{
            opacity: collapsed ? 0 : 1,
            pointerEvents: collapsed ? 'none' : undefined,
            transition: 'opacity var(--motion-base) var(--motion-ease-out), background-color 150ms',
            top: '50%',
            right: `${Math.round(widthPx)}px`,
            transform: 'translateY(-50%)',
            width: '20px',
            height: '64px',
            borderTopLeftRadius: '10px',
            borderBottomLeftRadius: '10px',
            backgroundColor: 'var(--bg-2)',
            boxShadow: '0 8px 20px rgba(0, 0, 0, 0.12)',
          }}
          onClick={onCollapse}
          aria-label='Collapse explorer'
        >
          <span className='flex flex-col items-center justify-center gap-5px text-t-secondary'>
            <span className='block w-8px h-2px rd-999px bg-current opacity-85'></span>
            <span className='block w-8px h-2px rd-999px bg-current opacity-65'></span>
            <span className='block w-8px h-2px rd-999px bg-current opacity-45'></span>
          </span>
        </button>
      )}
    </>
  );
};
