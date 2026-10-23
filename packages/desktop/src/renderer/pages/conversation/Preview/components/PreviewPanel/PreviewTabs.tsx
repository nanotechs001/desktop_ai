/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import { iconColors } from '@/renderer/styles/colors';
import { Close, Comments, Plus } from '@icon-park/react';
import { Button } from '@arco-design/web-react';
import { IconFullscreen, IconFullscreenExit, IconShrink } from '@arco-design/web-react/icon';
import React, { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { BrowserTabProfile } from '@/common/types/browser';
import type { TabFadeState } from '../../hooks/useTabOverflow';

/**
 * 单个 tab 的最大宽度。
 *
 * 网页标题可以任意长（"某某官网 - 首页 - 欢迎光临……"），不设上限时一个 tab 就能
 * 撑满整条 tab 栏，用户完全看不出还有别的 tab。180px 够放下十几个中文字或一个可
 * 辨识的域名，同时保证预览框在最小宽度（260px）下仍能露出第二个 tab 的边缘，给出
 * "还有更多"的视觉线索。
 *
 * Maximum width of a single tab. Page titles can be arbitrarily long, and without a
 * cap one tab fills the whole strip so the user cannot tell other tabs exist. 180px
 * fits a recognizable domain or a dozen CJK characters while still leaving the edge
 * of a second tab visible at the panel's 260px minimum width — the visual cue that
 * more tabs are there.
 */
const MAX_TAB_WIDTH_PX = 180;
/** Unpinned tabs shrink together down to this width (icon, a few letters, close) before the strip scrolls, like Chrome. */
const MIN_TAB_WIDTH_PX = 56;
/** A pinned tab is icon-only, like Chrome's. */
const PINNED_TAB_WIDTH_PX = 36;
/** Drag data type for a tab being reordered, so drops of links or files onto the strip are not taken for one. */
const TAB_DRAG_TYPE = 'application/x-preview-tab';

/** What a pinned tile shows without a site icon: the page's first letter. */
const monogramOf = (tab: PreviewTab): string => (tab.title.trim().charAt(0) || '•').toUpperCase();

/**
 * Tab 信息
 * Tab information
 */
export interface PreviewTab {
  /**
   * Tab ID
   */
  id: string;

  /**
   * Tab 标题
   * Tab title
   */
  title: string;

  /**
   * 是否有未保存的修改
   * Whether there are unsaved changes
   */
  isDirty?: boolean;

  /**
   * 站点图标 URL，仅浏览器 tab 有
   * Site icon URL, browser tabs only
   */
  favicon?: string;

  /**
   * Agent 正在操作该浏览器 tab
   * Agent is currently driving this browser tab
   */
  agentActive?: boolean;

  /**
   * The browser profile of a browser tab (Personal or an Agent's), shown as its avatar; absent for other tabs
   */
  profile?: BrowserTabProfile;

  /**
   * 这个 tab 的绝对路径（浏览器 tab 为其 URL）是否可复制。刻意只给布尔值：
   * 项目文件的绝对路径由后端解析并直接写剪贴板，渲染进程拿不到那个字符串，
   * 菜单也就不该假装自己持有它。
   *
   * Whether this tab's absolute path (the URL, for browser tabs) can be copied.
   * Deliberately a boolean: a project file's absolute path is resolved and written
   * to the clipboard by the backend, so the renderer never holds the string and the
   * menu must not pretend otherwise.
   */
  canCopyPath?: boolean;

  /**
   * 是否有可复制的 workspace 相对路径。文件不在 workspace 内时没有。
   * Whether a workspace-relative path is available; absent for files outside it.
   */
  canCopyRelativePath?: boolean;

  /**
   * 能否在系统文件管理器中定位该文件。浏览器 tab（URL 没有所在目录）和远程
   * WebUI（文件管理器会开在后端主机上）下不可用。
   *
   * Whether the file can be located in the OS file manager. Unavailable for
   * browser tabs (a URL has no containing folder) and on a remote WebUI (the file
   * manager would open on the backend host).
   */
  canRevealInFolder?: boolean;

  /** Whether the tab can be pinned (browser tabs only) */
  canPin?: boolean;

  /** The user pinned this tab: it is never closed or unloaded unasked, and shows a pin icon */
  pinned?: boolean;
}

/**
 * PreviewTabs 组件属性
 * PreviewTabs component props
 */
interface PreviewTabsProps {
  /**
   * Tabs 列表
   * Tabs list
   */
  tabs: PreviewTab[];

  /**
   * 当前活动的 Tab ID
   * Current active tab ID
   */
  activeTabId: string | null;

  /**
   * Tab 渐变状态（左右溢出指示器）
   * Tab fade state (left/right overflow indicators)
   */
  tabFadeState: TabFadeState;

  /**
   * Tabs 容器引用
   * Tabs container ref
   */
  tabsContainerRef: React.RefObject<HTMLDivElement>;

  /**
   * 切换 Tab 回调
   * Switch tab callback
   */
  onSwitchTab: (tabId: string) => void;

  /**
   * 关闭 Tab 回调
   * Close tab callback
   */
  onCloseTab: (tabId: string) => void;

  /**
   * Tab 右键菜单回调
   * Tab context menu callback
   */
  onContextMenu: (e: React.MouseEvent, tabId: string) => void;

  /**
   * 关闭预览面板回调
   * Close preview panel callback
   */
  onClosePanel?: () => void;

  /**
   * 面板是否已最大化（聊天区隐藏、预览铺满）。决定最大化按钮显示的图标与提示。
   * Whether the panel is maximized (chat hidden, preview filling the area).
   * Drives the maximize button's icon and tooltip.
   */
  isMaximized?: boolean;
  /**
   * VA Bot layout: the button toggles the chat under the browser instead of maximizing.
   * `isMaximized` then means "chat collapsed".
   */
  chatToggle?: boolean;

  /**
   * 切换最大化回调；仅桌面端提供（移动端预览本就覆盖全屏，最大化无意义）。
   * 未提供时不渲染最大化按钮。
   * Toggle-maximize callback, supplied on desktop only (on mobile the preview is
   * already a full overlay, so maximizing is meaningless). The maximize button is
   * not rendered when this is absent.
   */
  onToggleMaximize?: () => void;

  /**
   * On a phone the open preview covers the chat, so the close control becomes a labeled "Chat" button.
   */
  isMobile?: boolean;

  /**
   * 新建浏览器 tab 回调；仅在已有浏览器 tab 时提供，避免在纯文档场景出现无意义的加号
   * New browser tab callback. Only supplied when a browser tab already exists, so
   * the plus button never appears in a document-only panel.
   */
  onNewBrowserTab?: () => void;

  /** Drag-to-reorder: the dragged tab takes the dropped-on tab's place. Tabs are not draggable without it. */
  onMoveTab?: (tabId: string, targetId: string) => void;
}

/**
 * 预览面板 Tabs 栏组件
 * Preview panel tabs bar component
 *
 * 显示多个 Tab，支持切换、关闭和右键菜单
 * Displays multiple tabs, supports switching, closing, and context menu
 *
 * 包含左右渐变指示器，提示用户可以滚动查看更多 Tab
 * Includes left/right gradient indicators to prompt users that more tabs can be scrolled
 */
const PreviewTabs: React.FC<PreviewTabsProps> = ({
  tabs,
  activeTabId,
  tabFadeState,
  tabsContainerRef,
  onSwitchTab,
  onCloseTab,
  onContextMenu,
  onClosePanel,
  onNewBrowserTab,
  isMaximized,
  chatToggle,
  isMobile,
  onToggleMaximize,
  onMoveTab,
}) => {
  const { t } = useTranslation();
  const { left: showLeftFade, right: showRightFade } = tabFadeState;
  // dragover cannot read drag data, so the dragged tab is remembered here.
  const draggedIdRef = useRef<string | null>(null);
  const [draggedId, setDraggedId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  // Site icons that failed to load: hidden, and a pinned tab shows its pin instead of going blank.
  const [brokenFavicons, setBrokenFavicons] = useState<ReadonlySet<string>>(() => new Set());
  const faviconOf = (tab: PreviewTab) => (tab.favicon && !brokenFavicons.has(tab.favicon) ? tab.favicon : undefined);
  // 站点图标（浏览器 tab）/ Site icon (browser tabs)
  const renderFavicon = (tab: PreviewTab, sizeClass: string) => (
    <img
      src={faviconOf(tab)}
      alt=''
      className={`${sizeClass} flex-shrink-0 rd-2px`}
      // 图标加载失败时不再显示，避免出现破图占位 / Dropped on load failure, never a broken image
      onError={() => {
        const failed = tab.favicon;
        if (failed) setBrokenFavicons((previous) => new Set(previous).add(failed));
      }}
    />
  );

  const endDrag = () => {
    draggedIdRef.current = null;
    setDraggedId(null);
    setDropTargetId(null);
  };
  // A tab only moves within its group: pinned tabs stay at the start.
  const canDropOn = (target: PreviewTab) => {
    const dragged = tabs.find((tab) => tab.id === draggedIdRef.current);
    return !!dragged && dragged.id !== target.id && !!dragged.pinned === !!target.pinned;
  };
  const indexOf = (tabId: string | null) => tabs.findIndex((tab) => tab.id === tabId);

  return (
    <div
      className='relative flex-shrink-0 bg-2'
      style={{ minHeight: '36px', borderBottom: '1px solid var(--border-base)' }}
    >
      <div className='flex items-center h-36px w-full'>
        {/* Tabs 滚动区域 / Tabs scroll area */}
        <div ref={tabsContainerRef} className='flex items-center h-full flex-1 overflow-x-auto'>
          {tabs.length > 0 ? (
            tabs.map((tab) => (
              <div
                key={tab.id}
                data-testid={`preview-tab-${tab.id}`}
                title={tab.pinned ? tab.title : undefined}
                draggable={!!onMoveTab}
                className={`flex items-center gap-6px h-full cursor-pointer transition-colors ${tab.pinned ? 'justify-center flex-shrink-0' : `px-10px ${tab.id === activeTabId ? 'bg-1 text-t-primary' : 'text-t-secondary hover:bg-3'}`} ${tab.id === draggedId ? 'opacity-50' : ''}`}
                style={{
                  ...(tab.pinned
                    ? { width: `${PINNED_TAB_WIDTH_PX}px` }
                    : {
                        flexGrow: 1,
                        flexShrink: 1,
                        flexBasis: 0,
                        minWidth: `${MIN_TAB_WIDTH_PX}px`,
                        maxWidth: `${MAX_TAB_WIDTH_PX}px`,
                      }),
                  // Insertion marker on the side the dragged tab will land (logical, so RTL flips it).
                  ...(tab.id === dropTargetId && {
                    [indexOf(draggedId) < indexOf(tab.id) ? 'borderInlineEnd' : 'borderInlineStart']:
                      '2px solid rgb(var(--primary-6))',
                  }),
                }}
                onDragStart={(e) => {
                  if (!onMoveTab) return;
                  draggedIdRef.current = tab.id;
                  setDraggedId(tab.id);
                  e.dataTransfer.effectAllowed = 'move';
                  e.dataTransfer.setData(TAB_DRAG_TYPE, tab.id);
                }}
                onDragOver={(e) => {
                  if (!canDropOn(tab)) return;
                  e.preventDefault();
                  e.dataTransfer.dropEffect = 'move';
                  setDropTargetId(tab.id);
                }}
                onDrop={(e) => {
                  const draggedTabId = draggedIdRef.current;
                  if (draggedTabId && canDropOn(tab)) {
                    e.preventDefault();
                    onMoveTab?.(draggedTabId, tab.id);
                  }
                  endDrag();
                }}
                onDragEnd={endDrag}
                onClick={() => onSwitchTab(tab.id)}
                onContextMenu={(e) => onContextMenu(e, tab.id)}
                // 中键关闭 / Middle-click to close.
                //
                // 走 onCloseTab 而不是直接关，所以未保存的 tab 仍会先弹确认——中键
                // 不能成为绕过该确认的第二条路。
                //
                // Routed through onCloseTab rather than closing directly, so a tab with
                // unsaved edits still asks first: middle-click must not become a second
                // path around that confirmation.
                //
                // preventDefault 只在这个 tab 上：中键在浏览器里默认触发自动滚动，
                // 而全局拦截会连带破坏页面其它地方的正常中键行为。
                //
                // preventDefault is scoped to this tab: middle-click otherwise starts
                // autoscroll, and intercepting it globally would break legitimate
                // middle-click behaviour elsewhere on the page.
                onAuxClick={(e) => {
                  if (e.button !== 1) return;
                  e.preventDefault();
                  e.stopPropagation();
                  onCloseTab(tab.id);
                }}
              >
                {/* min-w-0 是省略号生效的前提：flex 子项默认按内容撑开，不允许收缩
                    min-w-0 is what makes truncation possible: a flex child defaults
                    to its content width and refuses to shrink below it. */}
                {/* flex-1 pushes the close button to the tab's end, so equal-width tabs also look equal. */}
                <span className={`text-12px flex items-center gap-4px min-w-0 ${tab.pinned ? '' : 'flex-1'}`}>
                  {/* A pinned tab is a tile, like Chrome's and Arc's: the site icon, else the page's first letter. */}
                  {tab.pinned ? (
                    <span
                      data-testid='pinned-tile'
                      className={`flex items-center justify-center size-26px rd-6px text-12px font-semibold transition-colors ${tab.id === activeTabId ? 'bg-1 text-t-primary border border-solid border-b-base' : 'bg-fill-3 text-t-secondary hover:bg-fill-4'}`}
                    >
                      {faviconOf(tab) ? renderFavicon(tab, 'w-16px h-16px') : monogramOf(tab)}
                    </span>
                  ) : (
                    faviconOf(tab) && renderFavicon(tab, 'w-12px h-12px')
                  )}
                  {/* 只让标题文字收缩并省略；图标与指示器保持完整可见。
                      title 属性提供完整标题，避免截断后信息丢失。
                      Only the title text shrinks and ellipsizes; icons and indicators
                      stay fully visible. The title attribute exposes the full text so
                      truncation never hides information. */}
                  {!tab.pinned && (
                    <span className='truncate' title={tab.title}>
                      {tab.title}
                    </span>
                  )}
                  {/* Agent 操作中指示器 / Agent activity indicator */}
                  {tab.agentActive && (
                    <span
                      className='w-6px h-6px rd-full bg-success animate-pulse flex-shrink-0'
                      title={t('preview.browser.agentActiveTooltip')}
                    />
                  )}
                  {/* 未保存指示器 / Unsaved indicator */}
                  {tab.isDirty && (
                    <span
                      className='w-6px h-6px rd-full bg-primary flex-shrink-0'
                      title={t('preview.unsavedChangesTitle')}
                    />
                  )}
                </span>
                {/* 叉叉比加号「显得」大，是因为加号有 24px 的悬停底框衬托，而叉叉是
                    一个裸露的图标。所以这里给叉叉同样的方框（16px，比加号的 24px 小
                    一档，因为它在 tab 内部），并把图标本身收到 12px，视觉重量就和加号
                    一致了。
                    The close glyph looked bigger than the plus because the plus sits in a
                    24px hover box while the close icon was bare. Giving it the same kind
                    of box (16px — one step down from the plus's 24px since it lives inside
                    a tab) and trimming the glyph to 12px evens out their visual weight. */}
                {/* Like Chrome, a pinned tab has no close button (middle-click or the menu still close it). */}
                {!tab.pinned && (
                  <span
                    data-testid='preview-tab-close'
                    className='flex items-center justify-center w-16px h-16px rd-4px flex-shrink-0 hover:bg-3 transition-colors'
                    onClick={(e) => {
                      e.stopPropagation();
                      onCloseTab(tab.id);
                    }}
                  >
                    <Close theme='outline' size='12' fill={iconColors.secondary} className='hover:fill-primary' />
                  </span>
                )}
              </div>
            ))
          ) : (
            <div className='text-12px text-t-tertiary px-10px'>{t('preview.noTabs')}</div>
          )}

          {/* 新建浏览器 tab / New browser tab */}
          {onNewBrowserTab && (
            <div
              className='flex items-center justify-center w-24px h-24px ms-4px rd-4px cursor-pointer flex-shrink-0 hover:bg-3 transition-colors'
              onClick={onNewBrowserTab}
              title={t('preview.browser.newTab')}
            >
              <Plus theme='outline' size='14' fill={iconColors.secondary} />
            </div>
          )}
        </div>

        {/* 面板操作按钮：最大化 / 收起 / Panel actions: maximize / collapse */}
        {(onToggleMaximize || onClosePanel) && (
          <div className='flex items-center gap-4px h-full px-10px flex-shrink-0 rounded-se-[16px]'>
            {/* 最大化 / 还原：隐藏聊天区让预览铺满，两侧面板保持不变
                Maximize / restore: hide the chat area so the preview fills it; side panels stay unchanged */}
            {onToggleMaximize && (
              <div
                className='flex items-center justify-center w-20px h-20px rd-4px cursor-pointer hover:bg-3 transition-colors'
                onClick={onToggleMaximize}
                title={
                  chatToggle
                    ? isMaximized
                      ? t('preview.showChat')
                      : t('preview.hideChat')
                    : isMaximized
                      ? t('preview.restorePanel')
                      : t('preview.maximizePanel')
                }
                role='button'
                aria-pressed={chatToggle ? !isMaximized : isMaximized}
              >
                {chatToggle ? (
                  <Comments
                    theme={isMaximized ? 'outline' : 'filled'}
                    size='14'
                    fill={isMaximized ? iconColors.secondary : iconColors.primary}
                  />
                ) : isMaximized ? (
                  <IconFullscreenExit style={{ fontSize: 14, color: iconColors.secondary }} />
                ) : (
                  <IconFullscreen style={{ fontSize: 14, color: iconColors.secondary }} />
                )}
              </div>
            )}
            {onClosePanel && isMobile && (
              <Button
                size='mini'
                type='secondary'
                icon={<Comments theme='outline' size='12' fill={iconColors.secondary} />}
                onClick={onClosePanel}
              >
                {t('preview.chat')}
              </Button>
            )}
            {onClosePanel && !isMobile && (
              <div
                className='flex items-center justify-center w-20px h-20px rd-4px cursor-pointer hover:bg-3 transition-colors'
                onClick={onClosePanel}
                title={t('preview.collapsePanel')}
              >
                <IconShrink style={{ fontSize: 14, color: iconColors.secondary }} />
              </div>
            )}
          </div>
        )}
      </div>

      {/* 左侧渐变指示器 / Left gradient indicator */}
      {showLeftFade && (
        <div
          className='pointer-events-none absolute start-0 top-0 bottom-0 w-32px rounded-ss-[16px]'
          style={{
            background: 'linear-gradient(90deg, var(--bg-2) 0%, transparent 100%)',
          }}
        />
      )}

      {/* 右侧渐变指示器 / Right gradient indicator */}
      {showRightFade && (
        <div
          className='pointer-events-none absolute end-0 top-0 bottom-0 w-32px rounded-se-[16px]'
          style={{
            background: 'linear-gradient(270deg, var(--bg-2) 0%, transparent 100%)',
          }}
        />
      )}
    </div>
  );
};

export default PreviewTabs;
