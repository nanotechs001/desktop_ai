import React, { Suspense, useCallback, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { DocDetail } from '@icon-park/react';
import { HistoryPanelBody } from '@renderer/components/layout/Titlebar/HistoryPanel';
import { useRegularChatsOnly } from '@renderer/hooks/assistant/useRegularChatsOnly';
import { usePreviewContext } from '@renderer/pages/conversation/Preview/context/PreviewContext';
import { cleanupSiderTooltips, getSiderTooltipProps } from '@renderer/utils/ui/siderTooltip';
import { useAuth } from '@renderer/hooks/context/AuthContext';
import { useLayoutContext } from '@renderer/hooks/context/LayoutContext';
import { blurActiveElement } from '@renderer/utils/ui/focus';
import { useThemeContext } from '@renderer/hooks/context/ThemeContext';
import { SiderToolbar, SiderSearchEntry, SiderScheduledEntry, SiderAssistantEntry, SiderNavEntry } from './SiderNav';
import SiderFooter from './SiderFooter';

const SettingsSider = React.lazy(() => import('@renderer/pages/settings/components/SettingsSider'));

interface SiderProps {
  onSessionClick?: () => void;
  collapsed?: boolean;
}

const ignoreClose = () => {};

const Sider: React.FC<SiderProps> = ({ onSessionClick, collapsed = false }) => {
  const { t } = useTranslation();
  const regularChatsOnly = useRegularChatsOnly();
  const layout = useLayoutContext();
  const isMobile = layout?.isMobile ?? false;
  const location = useLocation();
  const { pathname, search, hash } = location;

  const navigate = useNavigate();
  const { closePreview, clearPreviewForScope } = usePreviewContext();
  const { logout, status } = useAuth();
  const { theme, setTheme } = useThemeContext();
  const isSettings = pathname.startsWith('/settings');
  const lastNonSettingsPathRef = useRef('/guid');
  const showLogout =
    typeof window !== 'undefined' && !(window as { electronAPI?: unknown }).electronAPI && status === 'authenticated';

  useEffect(() => {
    if (!pathname.startsWith('/settings')) {
      lastNonSettingsPathRef.current = `${pathname}${search}${hash}`;
    }
  }, [pathname, search, hash]);

  const handleNewChat = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    closePreview();
    Promise.resolve(navigate('/guid', { state: { resetAssistant: true } })).catch((error) => {
      console.error('Navigation failed:', error);
    });
    if (onSessionClick) {
      onSessionClick();
    }
  };

  const handleSettingsClick = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    if (isSettings) {
      const target = lastNonSettingsPathRef.current || '/guid';
      Promise.resolve(navigate(target)).catch((error) => {
        console.error('Navigation failed:', error);
      });
    } else {
      Promise.resolve(navigate('/settings/agent')).catch((error) => {
        console.error('Navigation failed:', error);
      });
    }
    if (onSessionClick) {
      onSessionClick();
    }
  };

  const handleMessageSearchSelect = () => {
    cleanupSiderTooltips();
    blurActiveElement();
  };

  const handleScheduledClick = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    closePreview();
    Promise.resolve(navigate('/scheduled')).catch((error) => {
      console.error('Navigation failed:', error);
    });
    if (onSessionClick) {
      onSessionClick();
    }
  };

  const handleArtifactsClick = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    closePreview();
    Promise.resolve(navigate('/artifacts')).catch((error) => {
      console.error('Navigation failed:', error);
    });
    if (onSessionClick) {
      onSessionClick();
    }
  };

  const handleAssistantClick = () => {
    cleanupSiderTooltips();
    blurActiveElement();
    closePreview();
    Promise.resolve(navigate('/assistants')).catch((error) => {
      console.error('Navigation failed:', error);
    });
    if (onSessionClick) {
      onSessionClick();
    }
  };

  const handleQuickThemeToggle = () => {
    void setTheme(theme === 'dark' ? 'light' : 'dark');
  };

  const handleLogout = useCallback(async () => {
    cleanupSiderTooltips();
    blurActiveElement();
    // Hide the panel now so the UI responds immediately; the tabs themselves are
    // discarded after logout resolves, below.
    closePreview();
    try {
      await logout();
    } catch (error) {
      console.error('Logout failed:', error);
      return; // logout 失败时不执行后续操作
    }
    // Discard this account's tabs from memory.
    //
    // `clearAuthCache` (inside logout) already deletes the stored `preview-ui:`
    // keys, but PreviewProvider is mounted at the app root and does not unmount on
    // logout, so its state survives. The persist effect depends on [tabs,
    // activeTabId, isOpen] and is still live — so the next change of any of those
    // would write this account's tabs straight back to disk, undoing the very
    // cleanup that ran moments earlier and showing them to whoever logs in next.
    //
    // Done after `await logout()` rather than before: discarding first would throw
    // the tabs away even on a path that left the user signed in. `logout()` handles
    // its own request failure and clears auth in a `finally`, so reaching this line
    // means the account really is signed out.
    clearPreviewForScope();
    if (onSessionClick) {
      onSessionClick();
    }
  }, [closePreview, clearPreviewForScope, logout, onSessionClick]);

  useEffect(() => {
    if (!showLogout) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === 'l') {
        event.preventDefault();
        handleLogout();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
    };
  }, [handleLogout, showLogout]);

  const tooltipEnabled = collapsed && !isMobile;
  const siderTooltipProps = getSiderTooltipProps(tooltipEnabled);

  return (
    <div className='size-full flex flex-col'>
      {/* Main content area */}
      <div className='flex-1 min-h-0 overflow-hidden'>
        {isSettings ? (
          <Suspense fallback={<div className='size-full' />}>
            <SettingsSider collapsed={collapsed} tooltipEnabled={tooltipEnabled} />
          </Suspense>
        ) : (
          <div className='size-full flex flex-col gap-2px'>
            <SiderToolbar
              isMobile={isMobile}
              collapsed={collapsed}
              siderTooltipProps={siderTooltipProps}
              onNewChat={handleNewChat}
            />
            {/* Message search: mobile keeps it here (desktop has the titlebar panel). */}
            {isMobile && (
              <SiderSearchEntry
                isMobile={isMobile}
                collapsed={collapsed}
                siderTooltipProps={siderTooltipProps}
                onConversationSelect={handleMessageSearchSelect}
                onSessionClick={onSessionClick}
              />
            )}
            {/* Assistant nav entry - fixed above Scheduled */}
            <SiderAssistantEntry
              isMobile={isMobile}
              isActive={pathname.startsWith('/assistants')}
              collapsed={collapsed}
              siderTooltipProps={siderTooltipProps}
              onClick={handleAssistantClick}
            />
            {/* Scheduled tasks nav entry - fixed above scroll */}
            <SiderScheduledEntry
              isMobile={isMobile}
              isActive={pathname === '/scheduled'}
              collapsed={collapsed}
              siderTooltipProps={siderTooltipProps}
              onClick={handleScheduledClick}
            />
            <SiderNavEntry
              label={t('conversation.artifacts.title')}
              icon={DocDetail}
              isMobile={isMobile}
              isActive={pathname === '/artifacts'}
              collapsed={collapsed}
              siderTooltipProps={siderTooltipProps}
              onClick={handleArtifactsClick}
            />
            {/* The main agent's chats; the rail has no room for them (the titlebar history covers it). */}
            {!collapsed && (
              <div className='flex-1 min-h-0 mt-4px -mx-8px'>
                <HistoryPanelBody
                  embedded
                  autoFocus={false}
                  filter={regularChatsOnly}
                  onClose={onSessionClick ?? ignoreClose}
                />
              </div>
            )}
          </div>
        )}
      </div>
      {/* Footer */}
      <SiderFooter
        isMobile={isMobile}
        isSettings={isSettings}
        collapsed={collapsed}
        theme={theme}
        siderTooltipProps={siderTooltipProps}
        onSettingsClick={handleSettingsClick}
        onThemeToggle={handleQuickThemeToggle}
        showLogout={showLogout}
        onLogoutClick={handleLogout}
      />
    </div>
  );
};

export default Sider;
