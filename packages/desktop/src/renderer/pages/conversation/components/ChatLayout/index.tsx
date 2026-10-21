import { AgentLogoIcon } from '@/renderer/components/agent/AgentLogoIcon';
import { VaBotColorDot } from '@/renderer/components/agent/BotColorDot';
import type { PresetAssistantInfo } from '@/renderer/hooks/agent/usePresetAssistantInfo';
import FlexFullContainer from '@/renderer/components/layout/FlexFullContainer';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { useResizableSplit } from '@/renderer/hooks/ui/useResizableSplit';
import { MOTION_MS, useAnimating } from '@/renderer/hooks/ui/useMotion';
import { useVerticalSplit } from '@/renderer/pages/conversation/hooks/useVerticalSplit';
import ChatTitleEditor from '@/renderer/pages/conversation/components/ChatTitleEditor';
import MobileWorkspaceOverlay from './MobileWorkspaceOverlay';
import WorkspacePanelHeader from './WorkspacePanelHeader';
import { useContainerWidth } from '@/renderer/pages/conversation/hooks/useContainerWidth';
import { useLayoutConstraints } from '@/renderer/pages/conversation/hooks/useLayoutConstraints';
import { useTitleRename } from '@/renderer/pages/conversation/hooks/useTitleRename';
import { useWorkspaceCollapse } from '@/renderer/pages/conversation/hooks/useWorkspaceCollapse';
import { PreviewPanel, usePreviewContext } from '@/renderer/pages/conversation/Preview';
import { agentFromPresetInfo } from '@/renderer/utils/ui/agentPresentation';
import { dispatchWorkspaceToggleEvent } from '@/renderer/utils/workspace/workspaceEvents';
import classNames from 'classnames';
import {
  DEFAULT_WORKSPACE_PANEL_PX,
  MAX_WORKSPACE_PANEL_PX,
  MIN_WORKSPACE_PANEL_PX,
  WORKSPACE_HEADER_HEIGHT,
  calcLayoutMetrics,
} from '@/renderer/pages/conversation/utils/layoutCalc';
import { Layout as ArcoLayout } from '@arco-design/web-react';
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import './chat-layout.css';

// headerExtra allows injecting custom actions (e.g., model picker) into the header's right area
const ChatLayout: React.FC<{
  children: React.ReactNode;
  title?: React.ReactNode;
  sider: React.ReactNode;
  siderTitle?: React.ReactNode;
  /** Internal engine id; only marks that the chat has an Agent, never rendered. */
  backend?: string;
  /** Preset assistant info — the header shows this Agent's avatar, or the robot icon when it has none */
  presetAssistant?: PresetAssistantInfo & { id?: string };
  headerExtra?: React.ReactNode;
  workspaceEnabled?: boolean;
  /**
   * When true (project conversations), the preview panel is hoisted to the
   * Layout-level project host and this ChatLayout renders chat only — the preview
   * region + its resize live at the Layout level, structurally persistent across
   * same-project conversation switches (no remount).
   */
  previewHosted?: boolean;
  /** Conversation ID for mode switching */
  conversation_id?: string;
  /** Custom tabs slot; when provided, replaces the default ConversationTabs */
  tabsSlot?: React.ReactNode;
  /** Workspace path for opening in external tools */
  workspacePath?: string;
  /** Authoritative temp-workspace flag from `conversation.extra.is_temporary_workspace`. */
  isTemporaryWorkspace?: boolean;
  /**
   * Stable key for persisting the workspace collapse preference. Defaults to
   * `conversation_id`.
   */
  workspacePreferenceKey?: string;
  /** Custom rename handler; when provided, replaces the default conversation.update rename flow */
  onRenameTitle?: (new_name: string) => Promise<boolean>;
  /** Optional override for the leading icon shown before the title */
  headerLeading?: React.ReactNode;
}> = (props) => {
  const { conversation_id, workspacePath, isTemporaryWorkspace } = props;
  const { backend, presetAssistant, workspaceEnabled = true, workspacePreferenceKey } = props;
  const layout = useLayoutContext();
  const isDesktop = !layout?.isMobile;
  const isMobile = Boolean(layout?.isMobile);

  // Preview panel state
  const { isOpen: isPreviewOpenRaw, isMaximized, isVaBotMode, isVaChatCollapsed, toggleVaChat } = usePreviewContext();
  // Only hoist to the Layout host on desktop. On mobile (narrow width < 768) the
  // host is not rendered (`previewRegionActive` in Layout.tsx is gated on
  // `!isMobile`), so hoisting there would leave the preview with no renderer at
  // all. Forcing `previewHosted` to false on mobile makes every conversation —
  // including project conversations — fall back to ChatLayout's own mobile
  // overlay path, exactly how non-project conversations still render today.
  const previewHosted = Boolean(props.previewHosted) && !isMobile;
  // For project conversations the preview lives at the Layout host, so this
  // ChatLayout must behave as if there is no preview: chat fills, no split, no
  // preview panel. Everywhere below uses `isPreviewOpen` for that local decision.
  const isPreviewOpen = isPreviewOpenRaw && !previewHosted;
  // 最大化（仅桌面）：隐藏聊天区、让内联预览铺满；工作区右栏保持不变。
  // 项目会话的预览被提升到 Layout host（previewHosted），其最大化在 Layout 处理，
  // 这里的 isPreviewOpen 已排除该情况。
  // Maximized (desktop only): hide the chat area so the inline preview fills it;
  // the right workspace sider stays unchanged. Project conversations hoist the
  // preview to the Layout host (previewHosted) and handle maximizing there —
  // isPreviewOpen already excludes that case here.
  // VA Bot conversations: browser on top, [chat | files] underneath. Regular chats keep
  // the side-by-side [chat | preview] split with the files sider on the right.
  const vaLayout = isDesktop && isPreviewOpen && isVaBotMode;

  // --- Hook A: workspace collapse ---
  const { rightSiderCollapsed, setRightSiderCollapsed } = useWorkspaceCollapse({
    workspaceEnabled,
    isMobile,
    conversation_id,
    preferenceKey: workspacePreferenceKey ?? conversation_id,
  });
  // VA Bot: the files pane shares the chat's bottom row. With the chat collapsed, an open files pane keeps that row up
  // and fills it; only with both closed does the browser take the whole height.
  const vaChatHidden = vaLayout && isVaChatCollapsed;
  const vaFilesOpen = workspaceEnabled && !rightSiderCollapsed;
  const previewMaximized =
    isDesktop && isPreviewOpen && (isVaBotMode ? isVaChatCollapsed && !vaFilesOpen : isMaximized);

  // --- Hook B: container width ---
  const { containerRef, containerWidth } = useContainerWidth();

  // --- Hook C: title rename ---
  const { editingTitle, setEditingTitle, titleDraft, setTitleDraft, renameLoading, canRenameTitle, submitTitleRename } =
    useTitleRename({
      title: props.title,
      conversation_id,
      onRename: props.onRenameTitle,
    });

  // The chat's Agent; the engine behind it (backend, agent_name) is never shown.
  const agent = agentFromPresetInfo(presetAssistant);

  const {
    splitRatio: workspaceWidthPxPref,
    setSplitRatio: setWorkspaceWidthPxPref,
    createDragHandle: createWorkspaceDragHandle,
  } = useResizableSplit({
    unit: 'px',
    defaultWidth: DEFAULT_WORKSPACE_PANEL_PX,
    minWidth: MIN_WORKSPACE_PANEL_PX,
    maxWidth: MAX_WORKSPACE_PANEL_PX,
    storageKey: 'chat-workspace-width-px',
  });

  // Pre-hook metrics: compute dynamic min/max for the chat-preview split hook
  const { dynamicChatMinRatio, dynamicChatMaxRatio } = calcLayoutMetrics({
    containerWidth,
    workspaceWidthPx: workspaceWidthPxPref,
    chatSplitRatio: 60, // placeholder; only dynamicChatMinRatio/dynamicChatMaxRatio are used here
    workspaceEnabled,
    isDesktop,
    isPreviewOpen,
    rightSiderCollapsed,
    isMobile,
  });

  const {
    splitRatio: chatSplitRatio,
    setSplitRatio: setChatSplitRatio,
    createDragHandle: createPreviewDragHandle,
  } = useResizableSplit({
    defaultWidth: 60,
    minWidth: dynamicChatMinRatio,
    maxWidth: dynamicChatMaxRatio,
    storageKey: 'chat-preview-split-ratio',
  });
  // VA Bot: preview on top, chat underneath; shares its height with the project layout.
  const verticalSplit = useVerticalSplit({
    storageKey: 'chat-pane-height-px',
    defaultHeight: 360,
    // Dragging the divider to the bottom hides the chat (same as the chat button).
    onCollapse: () => {
      if (!isVaChatCollapsed) toggleVaChat();
    },
  });

  // Full metrics with real chatSplitRatio
  const { chatFlex, workspaceWidthPx, titleAreaMaxWidth, mobileWorkspaceHandleRight } = calcLayoutMetrics({
    containerWidth,
    workspaceWidthPx: workspaceWidthPxPref,
    chatSplitRatio,
    workspaceEnabled,
    isDesktop,
    isPreviewOpen,
    rightSiderCollapsed,
    isMobile,
  });

  // --- Motion (preview.css): the side-by-side panel slides in and out and maximizing eases, while the VA Bot chat
  // row folds away under the browser. Each runs only while its change does, so dragging a divider stays immediate. ---
  const sideBySide = isDesktop && !isVaBotMode;
  const openChanging = useAnimating(isPreviewOpen, MOTION_MS.base);
  const previewClosing = sideBySide && !isPreviewOpen && openChanging;
  const previewMounted = isPreviewOpen || previewClosing;
  const maximizeChanging = useAnimating(previewMaximized, MOTION_MS.slow) && !verticalSplit.dragging;
  // Folded away once the maximize has run. The VA Bot row stays laid out at height 0 (hidden, inert) so it can
  // ease open again: a display:none node has no start value to transition from.
  const chatFolded = previewMaximized && !maximizeChanging;
  const chatHidden = (isPreviewOpen && isMobile) || (chatFolded && !vaLayout);
  const workspaceToggling = useAnimating(rightSiderCollapsed, MOTION_MS.base);
  const previewSharePct = `${100 - chatSplitRatio}%`;
  // The chat's width beside the preview, held while maximizing so its messages do not reflow every frame.
  const chatWidthPx =
    ((containerWidth - (workspaceEnabled && !rightSiderCollapsed ? workspaceWidthPx : 0)) * chatFlex) / 100;

  // --- Hook E: layout constraints ---
  useLayoutConstraints({
    containerWidth,
    workspaceEnabled,
    isDesktop,
    // VA Bot stacks the browser above [chat | files]; the side-by-side three-panel limits would collapse the files pane.
    isPreviewOpen: isPreviewOpen && !vaLayout,
    rightSiderCollapsed,
    setRightSiderCollapsed,
    workspaceWidthPx: workspaceWidthPxPref,
    setWorkspaceWidthPx: setWorkspaceWidthPxPref,
    chatSplitRatio,
    setChatSplitRatio,
    dynamicChatMinRatio,
    dynamicChatMaxRatio,
  });

  const [mobileActionsSlot, setMobileActionsSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!layout?.isMobile) {
      setMobileActionsSlot(null);
      return;
    }
    const findSlot = () => document.getElementById('app-titlebar-actions-slot');
    setMobileActionsSlot(findSlot());
    const observer = new MutationObserver(() => {
      const next = findSlot();
      setMobileActionsSlot((prev) => (prev === next ? prev : next));
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, [layout?.isMobile]);

  const desktopHeader = (
    <ArcoLayout.Header
      className={classNames(
        'min-h-44px flex items-center justify-between px-16px pt-8px pb-10px gap-16px !bg-1 chat-layout-header chat-layout-header--glass overflow-hidden'
      )}
    >
      <FlexFullContainer className='h-full min-w-0' containerClassName='flex items-center'>
        <ChatTitleEditor
          editingTitle={editingTitle}
          titleDraft={titleDraft}
          setTitleDraft={setTitleDraft}
          setEditingTitle={setEditingTitle}
          renameLoading={renameLoading}
          canRenameTitle={canRenameTitle}
          submitTitleRename={submitTitleRename}
          titleAreaMaxWidth={titleAreaMaxWidth}
          title={props.title}
          conversation_id={conversation_id}
          leading={
            props.headerLeading ??
            ((backend || presetAssistant) && (
              <span className='inline-flex items-center gap-6px'>
                <AgentLogoIcon agent_name={agent?.name} agentLogo={agent?.avatar} />
                <VaBotColorDot assistant={{ id: presetAssistant?.assistantId, source: presetAssistant?.source }} />
              </span>
            ))
          }
        />
      </FlexFullContainer>
      <div className='flex items-center gap-12px shrink-0'>{props.headerExtra}</div>
    </ArcoLayout.Header>
  );

  const headerBlock = (
    <>
      {layout?.isMobile
        ? mobileActionsSlot && props.headerExtra && createPortal(props.headerExtra, mobileActionsSlot)
        : desktopHeader}
      {props.tabsSlot}
    </>
  );

  const siderWidth = rightSiderCollapsed ? '0px' : `${Math.round(workspaceWidthPx)}px`;
  // The files pane eases open and shut only while the toggle runs, so dragging its edge stays immediate.
  const siderToggling = workspaceToggling && !vaChatHidden;
  const workspaceSider =
    workspaceEnabled && !layout?.isMobile ? (
      <div
        className={classNames('!bg-1 relative chat-layout-right-sider layout-sider')}
        style={{
          // Alone in the VA Bot bottom row (chat collapsed), the files pane takes the row's whole width.
          flexGrow: vaChatHidden ? 1 : 0,
          flexShrink: 0,
          flexBasis: vaChatHidden ? 0 : siderWidth,
          width: vaChatHidden ? undefined : siderWidth,
          minWidth: rightSiderCollapsed || siderToggling ? '0px' : `${MIN_WORKSPACE_PANEL_PX}px`,
          overflow: 'hidden',
          // An inset line, not a border: it shrinks away with the pane instead of popping.
          boxShadow: rightSiderCollapsed || vaChatHidden ? undefined : 'inset 1px 0 0 var(--bg-3)',
          transition: siderToggling
            ? 'width var(--motion-base) var(--motion-ease-out), flex-basis var(--motion-base) var(--motion-ease-out)'
            : undefined,
        }}
      >
        {isDesktop &&
          !rightSiderCollapsed &&
          !vaChatHidden &&
          createWorkspaceDragHandle({
            className: 'absolute start-0 top-0 bottom-0',
            style: {},
            reverse: true,
          })}
        {/* Keeps its width while the pane eases, so the tree does not reflow every frame. */}
        <div
          className='h-full'
          style={{
            // Collapsed, the metrics width is 0: hold the pane's own width while it eases shut.
            width: vaChatHidden
              ? '100%'
              : `${Math.round(rightSiderCollapsed ? workspaceWidthPxPref : workspaceWidthPx)}px`,
          }}
        >
          <WorkspacePanelHeader
            collapsed={rightSiderCollapsed}
            onToggle={() => dispatchWorkspaceToggleEvent()}
            togglePlacement={layout?.isMobile ? 'left' : 'right'}
            workspacePath={workspacePath}
            isTemporaryWorkspace={isTemporaryWorkspace}
          >
            {props.siderTitle}
          </WorkspacePanelHeader>
          <ArcoLayout.Content style={{ height: `calc(100% - ${WORKSPACE_HEADER_HEIGHT}px)` }}>
            {props.sider}
          </ArcoLayout.Content>
        </div>
      </div>
    ) : null;

  return (
    <ArcoLayout
      className='size-full color-black '
      style={{
        // fontFamily: `cursive,"anthropicSans","anthropicSans Fallback",system-ui,Segoe UI,Roboto,Helvetica,Arial,sans-serif`,
      }}
    >
      <div ref={containerRef} className='flex flex-1 relative w-full overflow-hidden'>
        {/* Unified layout: single DOM structure prevents children unmount/remount on preview toggle */}
        <div
          className='flex flex-col min-w-0'
          style={{
            flexGrow: 1,
            flexShrink: 1,
            flexBasis: 0,
          }}
        >
          <div className='shrink-0 !bg-1'>{headerBlock}</div>
          {/* Desktop with preview open: column-reverse puts the preview on top and the
              chat (first in the DOM, so it never remounts) underneath. */}
          {/* Clips the preview while it slides in or out; the webview layer clips to it too (data-browser-clip). */}
          <div
            ref={verticalSplit.containerRef}
            data-browser-clip=''
            className={classNames('flex flex-1 min-h-0 relative overflow-hidden', vaLayout && 'flex-col-reverse')}
          >
            {/* Chat area - always mounted, never unmounted on preview toggle */}
            <div
              className='flex flex-row relative'
              style={{
                // VA Bot: the chat row keeps its height under the browser (0 while folded away). Otherwise the chat
                // takes what the preview's share leaves.
                flexGrow: vaLayout ? 0 : 1,
                flexShrink: vaLayout ? 0 : 1,
                flexBasis: vaLayout ? (previewMaximized ? '0px' : `${verticalSplit.height}px`) : 0,
                minHeight: 0,
                // 最大化时（桌面）隐藏聊天区，预览铺满；移动端预览打开即覆盖聊天区。
                // Hidden when maximized (desktop) so the preview fills, once the change has run; on mobile an
                // open preview already covers the chat.
                display: chatHidden ? 'none' : 'flex',
                visibility: chatFolded && vaLayout ? 'hidden' : undefined,
                minWidth: maximizeChanging || previewMaximized ? 0 : '240px',
                ...(maximizeChanging || chatFolded
                  ? {
                      overflow: 'hidden',
                      transition: vaLayout ? 'flex-basis var(--motion-slow) var(--motion-ease-in-out)' : undefined,
                    }
                  : {}),
              }}
              inert={(chatFolded && vaLayout) || undefined}
              onClick={() => {
                if (window.innerWidth < 768 && !rightSiderCollapsed) setRightSiderCollapsed(true);
              }}
            >
              <ArcoLayout.Content
                className='flex flex-col flex-1 min-w-0 bg-1 overflow-hidden'
                style={
                  vaChatHidden
                    ? { display: 'none' }
                    : maximizeChanging
                      ? // Keeps its size while its row folds or opens, so the messages do not reflow every frame.
                        vaLayout
                        ? { flex: 'none', height: `${verticalSplit.height}px` }
                        : { flex: 'none', width: `${Math.round(chatWidthPx)}px` }
                      : undefined
                }
                data-chat-pane
              >
                {props.children}
              </ArcoLayout.Content>
              {/* VA Bot: the files/workspace pane sits beside the chat in the bottom row. */}
              {vaLayout && workspaceSider}
            </div>
            {vaLayout && (!previewMaximized || maximizeChanging) && verticalSplit.renderHandle()}
            {/* Preview panel - conditionally rendered (kept for its slide out on desktop) */}
            {previewMounted && (
              <div
                data-browser-fade=''
                data-closing={previewClosing || undefined}
                data-resizing={(sideBySide && maximizeChanging) || undefined}
                className={classNames(
                  'preview-panel flex flex-col relative overflow-visible',
                  sideBySide && 'preview-reveal',
                  // 移动端预览是覆盖层，保留内缩和圆角；桌面端不留边距，
                  // 否则窗口底色会从缝隙透出（深色模式下尤其突兀）。
                  // On mobile the preview is an overlay, so it keeps its inset and
                  // rounding. On desktop no margin: a gap would expose the window's
                  // own background, which is jarring in dark mode.
                  isDesktop ? '' : 'm-[8px] rounded-[15px]'
                )}
                style={{
                  // Side by side: the preview's own share (all of it maximized); it never resizes while sliding.
                  ...(sideBySide
                    ? {
                        flexGrow: 0,
                        flexShrink: 0,
                        flexBasis: previewMaximized ? '100%' : previewSharePct,
                        ['--preview-reveal-size' as string]: previewMaximized ? '100%' : previewSharePct,
                      }
                    : { flexGrow: 1, flexShrink: 1, flexBasis: 0 }),
                  // VA Bot: bottom divider above the chat. Regular desktop: left divider beside
                  // the chat. Mobile overlay keeps a full border.
                  ...(vaLayout
                    ? { borderBottom: '1px solid var(--bg-3)' }
                    : isDesktop
                      ? { borderLeft: '1px solid var(--bg-3)' }
                      : { border: '1px solid var(--bg-3)' }),
                  minHeight: 0,
                  minWidth: isDesktop && !vaLayout ? '260px' : 0,
                  maxWidth: isMobile ? 'calc(100% - 16px)' : undefined,
                  width: isMobile ? 'calc(100% - 16px)' : undefined,
                  boxSizing: 'border-box',
                }}
              >
                {/* 最大化时聊天区隐藏，拖拽把手无处可拖，隐藏之。
                    While maximized the chat is hidden, so the resize handle has
                    nothing to drag against — hide it. */}
                {isDesktop &&
                  !vaLayout &&
                  !previewMaximized &&
                  !previewClosing &&
                  createPreviewDragHandle({
                    className: 'absolute top-0 bottom-0 z-30',
                    style: { width: '20px', left: '-20px' },
                    linePlacement: 'end',
                    lineClassName: 'opacity-30 group-hover:opacity-100 group-active:opacity-100',
                    lineStyle: { width: '2px' },
                  })}
                <div className={classNames('h-full w-full overflow-hidden', isDesktop ? '' : 'rounded-[15px]')}>
                  <PreviewPanel closing={previewClosing} />
                </div>
              </div>
            )}
          </div>
        </div>
        {/* Regular chats: files/workspace sider on the right. */}
        {!vaLayout && workspaceSider}
        {/* Mobile workspace overlay: backdrop + fixed panel + floating collapse handle */}
        {workspaceEnabled && layout?.isMobile && (
          <MobileWorkspaceOverlay
            rightSiderCollapsed={rightSiderCollapsed}
            setRightSiderCollapsed={setRightSiderCollapsed}
            workspaceWidthPx={workspaceWidthPx}
            mobileWorkspaceHandleRight={mobileWorkspaceHandleRight}
            siderTitle={props.siderTitle}
            sider={props.sider}
            workspacePath={workspacePath}
            isTemporaryWorkspace={isTemporaryWorkspace}
          />
        )}
      </div>
    </ArcoLayout>
  );
};

export default ChatLayout;
