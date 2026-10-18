import React, { useEffect, useMemo, useRef, useState } from 'react';
import classNames from 'classnames';
import { Button } from '@arco-design/web-react';
import { ArrowCircleLeft, ArrowLeft, ArrowRight, ExpandLeft, ExpandRight, Peoples, Search } from '@icon-park/react';
import { useTranslation } from 'react-i18next';
import { useLocation, useNavigate } from 'react-router-dom';

import { ipcBridge } from '@/common';
import { TEAM_MODE_ENABLED } from '@/common/config/constants';
import ConversationSearchPopover from '@renderer/pages/conversation/GroupedHistory/ConversationSearchPopover';
import HistoryPanel from './HistoryPanel';
import TitlebarNav from './TitlebarNav';
import MobileConversationBrand from './MobileConversationBrand';
import WindowControls from '../WindowControls';
import { WORKSPACE_STATE_EVENT, dispatchWorkspaceToggleEvent } from '@renderer/utils/workspace/workspaceEvents';
import type { WorkspaceStateDetail } from '@renderer/utils/workspace/workspaceEvents';
import { useLayoutContext } from '@/renderer/hooks/context/LayoutContext';
import { isElectronDesktop, isMacOS } from '@/renderer/utils/platform';
import { IS_DISCONTINUED_BUILD } from '@/renderer/utils/discontinuedBuild';
import MigrationInviteCapsule from './MigrationInviteCapsule';
import { useChatNavHistory } from './useChatNavHistory';
import './titlebar.css';

interface TitlebarProps {
  workspaceAvailable: boolean;
}

// Claude-desktop-style sidebar toggle icon: a rounded rectangle with a vertical divider
// near the left edge, indicating a collapsible side panel. Rendered as inline SVG since
// @icon-park doesn't ship this exact shape.
//
// Uses a 48-unit viewBox to match @icon-park's stroke scale, so passing the same
// `strokeWidth` value here and to @icon-park icons produces visually identical lines.
//
// The rect spans y=10..38 (height 28), slightly taller than @icon-park's
// ArrowLeft/ArrowRight (which span y=12..36) so the sidebar icon reads a
// touch larger. The rect remains centered at y=24, matching the arrows'
// centerline so all three icons stay on the same visual baseline.
const SidebarIcon: React.FC<{ size?: number; strokeWidth?: number }> = ({ size = 18, strokeWidth = 4 }) => (
  <svg
    width={size}
    height={size}
    viewBox='0 0 48 48'
    fill='none'
    stroke='currentColor'
    strokeWidth={strokeWidth}
    strokeLinecap='round'
    strokeLinejoin='round'
    aria-hidden='true'
    focusable='false'
  >
    <rect x='6' y='10' width='36' height='28' rx='5' />
    <line x1='18' y1='10' x2='18' y2='38' />
  </svg>
);

const Titlebar: React.FC<TitlebarProps> = ({ workspaceAvailable }) => {
  const { t } = useTranslation();
  const appTitle = useMemo(() => 'Pixebot Browser', []);
  const [workspaceCollapsed, setWorkspaceCollapsed] = useState(true);
  const [mobileCenterTitle, setMobileCenterTitle] = useState(appTitle);
  const [mobileCenterOffset, setMobileCenterOffset] = useState(0);
  const layout = useLayoutContext();
  const chatNav = useChatNavHistory();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [messageSearchOpen, setMessageSearchOpen] = useState(false);
  const location = useLocation();
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  const lastNonSettingsPathRef = useRef('/guid');

  // 监听工作空间折叠状态，保持按钮图标一致 / Sync workspace collapsed state for toggle button
  useEffect(() => {
    if (typeof window === 'undefined') {
      return undefined;
    }
    const handler = (event: Event) => {
      const customEvent = event as CustomEvent<WorkspaceStateDetail>;
      if (typeof customEvent.detail?.collapsed === 'boolean') {
        setWorkspaceCollapsed(customEvent.detail.collapsed);
      }
    };
    window.addEventListener(WORKSPACE_STATE_EVENT, handler as EventListener);
    return () => {
      window.removeEventListener(WORKSPACE_STATE_EVENT, handler as EventListener);
    };
  }, []);

  const isDesktopRuntime = isElectronDesktop();
  const isMacRuntime = isDesktopRuntime && isMacOS();
  // Windows/Linux 显示自定义窗口按钮；macOS 在标题栏给工作区一个切换入口
  const showWindowControls = isDesktopRuntime && !isMacRuntime;
  // Keep the workspace entry in the titlebar on every platform.
  const showWorkspaceButton = workspaceAvailable;

  const workspaceTooltip = workspaceCollapsed
    ? t('common.expandMore', { defaultValue: 'Expand workspace' })
    : t('common.collapse', { defaultValue: 'Collapse workspace' });
  const backToChatTooltip = t('common.back', { defaultValue: 'Back to Chat' });
  const isSettingsRoute = location.pathname.startsWith('/settings');
  const iconSize = 18;
  // Desktop uses slimmer strokes to match macOS-native chrome aesthetics;
  // mobile keeps the default weight so icons stay legible at larger sizes.
  const desktopIconStroke = layout?.isMobile ? undefined : 2.5;
  // 统一在标题栏左侧展示主侧栏开关 / Always expose sidebar toggle on titlebar left side
  // Desktop has no left icon bar outside Settings (navigation lives top right), so the toggle shows there only.
  const showSiderToggle = Boolean(layout?.setSiderCollapsed) && (layout?.isMobile ? !isSettingsRoute : isSettingsRoute);
  const showBackToChatButton = Boolean(layout?.isMobile && isSettingsRoute);
  const siderTooltip = layout?.siderCollapsed
    ? t('common.expandMore', { defaultValue: 'Expand sidebar' })
    : t('common.collapse', { defaultValue: 'Collapse sidebar' });
  // Show back/forward on desktop only; mobile keeps the existing back-to-chat button.
  const showHistoryNav = !layout?.isMobile;
  const historyBackTooltip = t('common.historyBack', { defaultValue: 'Back' });
  const historyForwardTooltip = t('common.forward', { defaultValue: 'Forward' });
  // The chat list lives in the history panel opened from here, on every platform.
  const searchTooltip = t('conversation.history.searchChats');

  const titlebarButtonClass = classNames('app-titlebar__button', layout?.isMobile && 'app-titlebar__button--mobile');

  // Message search opens over the chat, so the history drawer closes first (from its entry or Cmd/Ctrl+Shift+F).
  const handleMessageSearchOpenChange = (open: boolean) => {
    if (open) setHistoryOpen(false);
    setMessageSearchOpen(open);
  };
  const handleSearchMessages = () => handleMessageSearchOpenChange(true);

  const handleSiderToggle = () => {
    if (!showSiderToggle || !layout?.setSiderCollapsed) return;
    layout.setSiderCollapsed(!layout.siderCollapsed);
  };

  const handleWorkspaceToggle = () => {
    if (!workspaceAvailable) {
      return;
    }
    dispatchWorkspaceToggleEvent();
  };

  const handleBackToChat = () => {
    const target = lastNonSettingsPathRef.current;
    if (target && !target.startsWith('/settings')) {
      void navigate(target);
      return;
    }
    void navigate(-1);
  };

  useEffect(() => {
    if (!isSettingsRoute) {
      const path = `${location.pathname}${location.search}${location.hash}`;
      lastNonSettingsPathRef.current = path;
      try {
        sessionStorage.setItem('aion:last-non-settings-path', path);
      } catch {
        // ignore
      }
      return;
    }
    try {
      const stored = sessionStorage.getItem('aion:last-non-settings-path');
      if (stored) {
        lastNonSettingsPathRef.current = stored;
      }
    } catch {
      // ignore
    }
  }, [isSettingsRoute, location.pathname, location.search, location.hash]);

  useEffect(() => {
    if (!layout?.isMobile) {
      setMobileCenterTitle(appTitle);
      return;
    }

    // Team mode: show team name
    if (TEAM_MODE_ENABLED) {
      const teamMatch = location.pathname.match(/^\/team\/([^/]+)/);
      const team_id = teamMatch?.[1];
      if (team_id) {
        let cancelled = false;
        void ipcBridge.team.get
          .invoke({ id: team_id })
          .then((team) => {
            if (cancelled) return;
            setMobileCenterTitle(team?.name || appTitle);
          })
          .catch(() => {
            if (cancelled) return;
            setMobileCenterTitle(appTitle);
          });
        return () => {
          cancelled = true;
        };
      }
    }

    // Single agent mode: show conversation name
    const match = location.pathname.match(/^\/conversation\/([^/]+)/);
    const conversation_id = match?.[1];
    if (!conversation_id) {
      setMobileCenterTitle(appTitle);
      return;
    }

    let cancelled = false;
    void ipcBridge.conversation.get
      .invoke({ id: conversation_id })
      .then((conversation) => {
        if (cancelled) return;
        setMobileCenterTitle(conversation?.name || appTitle);
      })
      .catch(() => {
        if (cancelled) return;
        setMobileCenterTitle(appTitle);
      });

    return () => {
      cancelled = true;
    };
  }, [appTitle, layout?.isMobile, location.pathname]);

  useEffect(() => {
    if (!layout?.isMobile) {
      setMobileCenterOffset(0);
      return;
    }

    const updateOffset = () => {
      const leftWidth = menuRef.current?.offsetWidth || 0;
      const rightWidth = toolbarRef.current?.offsetWidth || 0;
      setMobileCenterOffset((leftWidth - rightWidth) / 2);
    };

    updateOffset();

    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', updateOffset);
      return () => window.removeEventListener('resize', updateOffset);
    }

    const observer = new ResizeObserver(() => updateOffset());
    if (containerRef.current) observer.observe(containerRef.current);
    if (menuRef.current) observer.observe(menuRef.current);
    if (toolbarRef.current) observer.observe(toolbarRef.current);

    return () => observer.disconnect();
  }, [layout?.isMobile, showBackToChatButton, showWorkspaceButton, mobileCenterTitle]);

  const mobileCenterStyle = layout?.isMobile
    ? ({
        '--app-titlebar-mobile-center-offset': `${workspaceAvailable ? mobileCenterOffset : 0}px`,
      } as React.CSSProperties)
    : undefined;

  // Back to chat, sidebar toggle, search and history arrows. Phones keep them on the left; on desktop they sit in the
  // right-hand toolbar with the rest of the navigation, leaving the top-left corner free (macOS traffic lights).
  const menuButtons = (
    <>
      {showBackToChatButton && (
        <button
          type='button'
          className={classNames('app-titlebar__button', layout?.isMobile && 'app-titlebar__button--mobile')}
          onClick={handleBackToChat}
          aria-label={backToChatTooltip}
        >
          <ArrowCircleLeft theme='outline' size={iconSize} fill='currentColor' />
        </button>
      )}
      {showSiderToggle && (
        <Button
          type='text'
          size='mini'
          className={titlebarButtonClass}
          icon={<SidebarIcon size={iconSize} strokeWidth={desktopIconStroke} />}
          onClick={handleSiderToggle}
          aria-label={siderTooltip}
        />
      )}
      <Button
        type='text'
        size='mini'
        className={titlebarButtonClass}
        icon={
          <Search
            theme='outline'
            size={iconSize}
            fill='currentColor'
            strokeWidth={desktopIconStroke}
            className='block leading-none'
            style={{ lineHeight: 0 }}
          />
        }
        onClick={() => setHistoryOpen(true)}
        aria-label={searchTooltip}
        title={searchTooltip}
      />
      {showHistoryNav && (
        <>
          <Button
            type='text'
            size='mini'
            className={classNames(titlebarButtonClass, 'app-titlebar__button--nav')}
            icon={<ArrowLeft theme='outline' size={iconSize} fill='currentColor' strokeWidth={desktopIconStroke} />}
            onClick={() => chatNav.back()}
            disabled={!chatNav.canBack}
            aria-label={historyBackTooltip}
            title={historyBackTooltip}
          />
          <Button
            type='text'
            size='mini'
            className={classNames(titlebarButtonClass, 'app-titlebar__button--nav')}
            icon={<ArrowRight theme='outline' size={iconSize} fill='currentColor' strokeWidth={desktopIconStroke} />}
            onClick={() => chatNav.forward()}
            disabled={!chatNav.canForward}
            aria-label={historyForwardTooltip}
            title={historyForwardTooltip}
          />
        </>
      )}
    </>
  );

  return (
    <div
      ref={containerRef}
      style={mobileCenterStyle}
      className={classNames('flex items-center gap-8px app-titlebar bg-2 border-b border-[var(--border-base)]', {
        'app-titlebar--mobile': layout?.isMobile,
        'app-titlebar--mobile-conversation': layout?.isMobile && workspaceAvailable,
        'app-titlebar--desktop': isDesktopRuntime,
        'app-titlebar--mac': isMacRuntime,
      })}
    >
      <div ref={menuRef} className='app-titlebar__menu'>
        {layout?.isMobile && menuButtons}
      </div>
      <div
        className={classNames('app-titlebar__brand', {
          'app-titlebar__brand--centered': layout?.isMobile || !location.pathname.match(/^\/(conversation|team)\//),
        })}
        aria-label={layout?.isMobile ? mobileCenterTitle : appTitle}
        title={layout?.isMobile ? mobileCenterTitle : appTitle}
      >
        {layout?.isMobile &&
          (() => {
            const conversationMatch = location.pathname.match(/^\/conversation\/([^/]+)/);
            const conversation_id = conversationMatch?.[1];
            if (conversation_id) {
              return <MobileConversationBrand conversation_id={conversation_id} fallbackTitle={mobileCenterTitle} />;
            }
            const isTeamRoute = TEAM_MODE_ENABLED && /^\/team\/[^/]+/.test(location.pathname);
            return (
              <span className='app-titlebar__brand-mobile'>
                {isTeamRoute && (
                  <span className='app-titlebar__brand-icon' aria-hidden='true'>
                    <Peoples theme='outline' size='16' fill='currentColor' />
                  </span>
                )}
                <span className='app-titlebar__brand-text'>{mobileCenterTitle}</span>
              </span>
            );
          })()}
      </div>
      <div ref={toolbarRef} className='app-titlebar__toolbar'>
        {layout?.isMobile && <div id='app-titlebar-actions-slot' className='app-titlebar__actions-slot' />}
        {IS_DISCONTINUED_BUILD && <MigrationInviteCapsule />}
        {!layout?.isMobile && (
          <>
            {menuButtons}
            <TitlebarNav buttonClassName={titlebarButtonClass} iconSize={iconSize} strokeWidth={desktopIconStroke} />
          </>
        )}
        {showWorkspaceButton && (
          <button
            type='button'
            className={classNames('app-titlebar__button', layout?.isMobile && 'app-titlebar__button--mobile')}
            onClick={handleWorkspaceToggle}
            aria-label={workspaceTooltip}
          >
            {workspaceCollapsed ? (
              <ExpandRight theme='outline' size={iconSize} fill='currentColor' />
            ) : (
              <ExpandLeft theme='outline' size={iconSize} fill='currentColor' />
            )}
          </button>
        )}
        {showWindowControls && <WindowControls />}
      </div>
      <HistoryPanel
        open={historyOpen}
        onClose={() => setHistoryOpen(false)}
        onSearchMessages={layout?.isMobile ? undefined : handleSearchMessages}
      />
      {/* Always mounted on desktop (outside the drawer) so Cmd/Ctrl+Shift+F opens message search anywhere. */}
      {!layout?.isMobile && (
        <ConversationSearchPopover
          open={messageSearchOpen}
          onOpenChange={handleMessageSearchOpenChange}
          renderTrigger={() => null}
        />
      )}
    </div>
  );
};

export default Titlebar;
