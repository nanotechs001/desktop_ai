import WorkspacePanelHeader from './WorkspacePanelHeader';
import { WORKSPACE_HEADER_HEIGHT } from '@/renderer/pages/conversation/utils/layoutCalc';
import { dispatchWorkspaceToggleEvent } from '@/renderer/utils/workspace/workspaceEvents';
import { MOTION_MS, useAnimating, useSettledAfter } from '@/renderer/hooks/ui/useMotion';
import { Layout as ArcoLayout } from '@arco-design/web-react';
import classNames from 'classnames';
import React from 'react';

type MobileWorkspaceOverlayProps = {
  rightSiderCollapsed: boolean;
  setRightSiderCollapsed: (collapsed: boolean) => void;
  workspaceWidthPx: number;
  mobileWorkspaceHandleRight: number;
  siderTitle?: React.ReactNode;
  sider: React.ReactNode;
  workspacePath?: string;
  isTemporaryWorkspace?: boolean;
};

// Full-screen overlay + fixed workspace panel + floating collapse handle for mobile viewports
const MobileWorkspaceOverlay: React.FC<MobileWorkspaceOverlayProps> = ({
  rightSiderCollapsed,
  setRightSiderCollapsed,
  workspaceWidthPx,
  mobileWorkspaceHandleRight,
  siderTitle,
  sider,
  workspacePath,
  isTemporaryWorkspace,
}) => {
  // The panel slides and its backdrop and handle fade out before they go; not on the frames right after mounting.
  const settled = useSettledAfter(null);
  const closing = useAnimating(rightSiderCollapsed, MOTION_MS.base) && rightSiderCollapsed;
  return (
    <>
      {/* Backdrop */}
      {(!rightSiderCollapsed || closing) && (
        <div
          className='fixed inset-0 bg-black/30 z-90 motion-backdrop'
          style={{ opacity: rightSiderCollapsed ? 0 : 1, pointerEvents: rightSiderCollapsed ? 'none' : undefined }}
          onClick={() => setRightSiderCollapsed(true)}
          aria-hidden='true'
        />
      )}

      {/* Fixed workspace panel */}
      <div
        className={classNames('!bg-1 relative chat-layout-right-sider', settled && 'motion-sheet')}
        style={{
          position: 'fixed',
          right: 0,
          top: 0,
          height: '100vh',
          width: `${Math.round(workspaceWidthPx)}px`,
          zIndex: 100,
          transform: rightSiderCollapsed ? 'translateX(100%)' : 'translateX(0)',
          pointerEvents: rightSiderCollapsed ? 'none' : 'auto',
        }}
      >
        <WorkspacePanelHeader
          showToggle
          collapsed={rightSiderCollapsed}
          onToggle={() => dispatchWorkspaceToggleEvent()}
          togglePlacement='left'
          workspacePath={workspacePath}
          isTemporaryWorkspace={isTemporaryWorkspace}
        >
          {siderTitle}
        </WorkspacePanelHeader>
        <ArcoLayout.Content className='bg-1' style={{ height: `calc(100% - ${WORKSPACE_HEADER_HEIGHT}px)` }}>
          {sider}
        </ArcoLayout.Content>
      </div>

      {/* Floating collapse handle */}
      {(!rightSiderCollapsed || closing) && (
        <button
          type='button'
          className='fixed z-101 flex items-center justify-center transition-colors workspace-toggle-floating motion-backdrop'
          style={{
            opacity: rightSiderCollapsed ? 0 : 1,
            pointerEvents: rightSiderCollapsed ? 'none' : undefined,
            transition: 'opacity var(--motion-base) var(--motion-ease-out), background-color 150ms',
            top: '50%',
            right: `${mobileWorkspaceHandleRight}px`,
            transform: 'translateY(-50%)',
            width: '20px',
            height: '64px',
            borderTopLeftRadius: '10px',
            borderBottomLeftRadius: '10px',
            borderTopRightRadius: '0',
            borderBottomRightRadius: '0',
            borderRight: 'none',
            backgroundColor: 'var(--bg-2)',
            boxShadow: '0 8px 20px rgba(0, 0, 0, 0.12)',
          }}
          onClick={() => dispatchWorkspaceToggleEvent()}
          aria-label='Collapse workspace'
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

export default MobileWorkspaceOverlay;
