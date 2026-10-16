/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import type { BrowserShortcutAction } from '@/common/types/browser';
import WebviewHost from '@/renderer/components/media/WebviewHost';
import { isPlatformPrimaryModifier } from '@/renderer/utils/ui/keyboardShortcuts';
import { useOptionalPreviewContext } from '../context/PreviewContext';
import AgentBanner from './BrowserChrome/AgentBanner';
import AgentControls from './BrowserChrome/AgentControls';
import AgentOverlay from './BrowserChrome/AgentOverlay';
import CrashOverlay, { type CrashState } from './BrowserChrome/CrashOverlay';
import DownloadsButton from './BrowserChrome/DownloadsButton';
import ExtensionActions from './BrowserChrome/ExtensionActions';
import FindBar from './BrowserChrome/FindBar';
import {
  BROWSER_BLANK_URL,
  BROWSER_SESSION_PARTITION,
  browserTabLabelFromUrl,
  resolveAddressBarInput,
} from './constants';
import { useAgentBrowser } from './useAgentBrowser';

/** `getWebContentsId()` throws before dom-ready and after the page crashed; that means "not this one". */
const ownWebContentsId = (webview: Electron.WebviewTag): number | null => {
  try {
    return webview.getWebContentsId();
  } catch {
    return null;
  }
};

/** Close requests remembered while a tab does not know its webContents id yet; only a burst can come that fast. */
const MAX_EARLY_CLOSES = 20;

/** Shortcuts typed into the tab's own controls (address bar, find bar); keys the page gets are handled in main. */
const CONTROL_SHORTCUTS: Record<string, BrowserShortcutAction> = {
  r: 'reload',
  l: 'focus-address',
  t: 'new-tab',
  w: 'close-tab',
  f: 'find',
  '[': 'back',
  ']': 'forward',
};

/** The browser shortcut for a key press in the tab's controls, or null. Shift only turns R into a hard reload. */
const controlShortcut = (event: React.KeyboardEvent): BrowserShortcutAction | null => {
  if (event.altKey || !isPlatformPrimaryModifier(event)) return null;
  // Non-Latin layouts send a non-ASCII key; the physical key (KeyR, ...) still says which shortcut it is.
  const key = /^[\x20-\x7e]$/.test(event.key) ? event.key.toLowerCase() : event.code.replace(/^Key/, '').toLowerCase();
  const action = CONTROL_SHORTCUTS[key] ?? null;
  if (!event.shiftKey) return action;
  return action === 'reload' ? 'hard-reload' : null;
};

export interface BrowserViewerProps {
  /** 该 tab 当前地址 / Current address of this tab */
  url: string;
  /** 所属 preview tab 的 id / Id of the owning preview tab */
  tabId: string;
  /** 地址变化时回写 tab（用于持久化）/ Persist the new address back onto the tab */
  onUrlChange: (tabId: string, url: string) => void;
  /** 页面标题变化时回写 tab / Persist the page title back onto the tab */
  onTitleChange: (tabId: string, title: string) => void;
  /** 站点图标变化时回写 tab / Persist the site favicon back onto the tab */
  onFaviconChange: (tabId: string, favicon: string) => void;
  /** 页面内按 Cmd/Ctrl+W 时请求关闭该 tab / The page asked to close this tab (Cmd/Ctrl+W) */
  onRequestClose?: (tabId: string) => void;
  /** 是否为当前显示的浏览器 tab / Whether this is the browser tab on screen */
  active?: boolean;
  /** An agent opened this tab (or it stopped being agent-owned); lets the tab strip show an Agent badge */
  onAgentOwnedChange?: (tabId: string, agentOwned: boolean) => void;
}

/**
 * 应用内浏览器视图 / In-app browser view.
 *
 * 与 URLViewer 的区别在三点，也正是它单独存在的理由：
 * 1. 使用共享的持久化 partition，登录态跨 tab / 跨项目保留；
 * 2. 地址栏支持「输入关键词直接搜索」，不只是补 https://；
 * 3. 把地址 / 标题 / 图标回写给 tab，使会话重启后能恢复。
 *
 * Differs from URLViewer in exactly the three ways that justify a separate
 * component: a shared persistent partition (sign-in survives), keyword search in
 * the address bar, and writing address/title/favicon back onto the owning tab so
 * the browser can be restored after a restart.
 */
const BrowserViewer: React.FC<BrowserViewerProps> = ({
  url,
  tabId,
  onUrlChange,
  onTitleChange,
  onFaviconChange,
  onRequestClose,
  active = false,
  onAgentOwnedChange,
}) => {
  const preview = useOptionalPreviewContext();
  const [webview, setWebview] = useState<Electron.WebviewTag | null>(null);
  // Known from did-attach, before dom-ready: a tab must honour a close request while its page still loads.
  const [attachedWebview, setAttachedWebview] = useState<Electron.WebviewTag | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findFocusToken, setFindFocusToken] = useState(0);
  const [crashState, setCrashState] = useState<CrashState>(null);
  const [reloading, setReloading] = useState(false);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  const tabWebContentsId = useMemo(() => (webview ? ownWebContentsId(webview) : null), [webview]);
  const { ownership, actions } = useAgentBrowser(tabWebContentsId);
  const agentOwned = ownership !== null && ownership.owner !== 'user';
  const reportedAgentOwned = useRef(false);

  const handleUrlChange = useCallback((next: string) => onUrlChange(tabId, next), [tabId, onUrlChange]);

  const handleTitleChange = useCallback(
    (title: string) => {
      const trimmed = title.trim();
      if (trimmed) onTitleChange(tabId, trimmed);
    },
    [tabId, onTitleChange]
  );

  const handleFaviconChange = useCallback(
    (favicon: string) => onFaviconChange(tabId, favicon),
    [tabId, onFaviconChange]
  );

  /**
   * about:blank 不会触发 page-title-updated，所以空白页的标题在这里兜底，
   * 否则新建 tab 会一直显示上一次的标题。
   * about:blank fires no title event, so derive the label here — otherwise a
   * fresh tab would keep showing the previous page's title.
   */
  const handleDidFinishLoad = useCallback(() => {
    // A finished load, however it was started (nav bar, address bar, Reload), proves the page is back.
    setCrashState(null);
    setReloading(false);
    if (url === BROWSER_BLANK_URL) onTitleChange(tabId, browserTabLabelFromUrl(url));
  }, [url, tabId, onTitleChange]);

  // clean-exit is a normal teardown (e.g. the tab is closing), not a crash.
  const handleRenderProcessGone = useCallback((details: { reason: string }) => {
    if (details.reason === 'clean-exit') return;
    setCrashState('crashed');
    setReloading(false);
    setFindOpen(false);
  }, []);
  // A hang never downgrades a crash that is already showing.
  const handleUnresponsive = useCallback(() => setCrashState((state) => state ?? 'unresponsive'), []);
  const handleResponsive = useCallback(() => {
    setCrashState((state) => (state === 'unresponsive' ? null : state));
    setReloading(false);
  }, []);
  // A reload that ends in an error page is over too; the overlay stays until a load finishes.
  const handleDidFailLoad = useCallback(() => setReloading(false), []);
  const handleWait = useCallback(() => {
    setCrashState(null);
    setReloading(false);
  }, []);

  const handleReload = useCallback(() => {
    if (!webview) return;
    // The overlay stays until did-finish-load proves the page is back (or it crashes again).
    setReloading(true);
    try {
      webview.reload();
    } catch (error) {
      // The guest is gone, so reload() has nothing to reload; assigning src starts a fresh load.
      console.warn('[BrowserViewer] reload failed, re-assigning src:', error);
      try {
        webview.src = url || BROWSER_BLANK_URL;
      } catch (fallbackError) {
        console.error('[BrowserViewer] src re-assignment failed:', fallbackError);
        setReloading(false);
      }
    }
  }, [webview, url]);

  const closeFind = useCallback(() => {
    setFindOpen(false);
    webview?.focus();
  }, [webview]);

  /** Runs a browser shortcut on this tab, whether it came from the page (via main) or the tab's controls. */
  const runShortcut = useCallback(
    (action: BrowserShortcutAction, target: Electron.WebviewTag): void => {
      switch (action) {
        case 'find':
          setFindOpen(true);
          setFindFocusToken((token) => token + 1);
          break;
        case 'focus-address':
          addressInputRef.current?.focus();
          break;
        case 'new-tab':
          preview?.openBrowserTab();
          break;
        case 'close-tab':
          onRequestClose?.(tabId);
          break;
        case 'escape':
          if (findOpen) {
            target.stopFindInPage('clearSelection');
            closeFind();
          }
          break;
        case 'reload':
          target.reload();
          break;
        case 'hard-reload':
          target.reloadIgnoringCache();
          break;
        case 'back':
          if (target.canGoBack()) target.goBack();
          break;
        case 'forward':
          if (target.canGoForward()) target.goForward();
          break;
      }
    },
    [tabId, findOpen, preview, onRequestClose, closeFind]
  );

  // Main reports shortcuts for every browser page; only the webview whose id matches acts on them.
  useEffect(() => {
    if (!webview) return;
    return ipcBridge.browser.shortcut.on(({ webContentsId, action }) => {
      if (webContentsId === ownWebContentsId(webview)) runShortcut(action, webview);
    });
  }, [webview, runShortcut]);

  // With focus in the address bar or find bar the keys never reach the page, so main cannot see them;
  // handled here and stopped so Cmd+R reloads the page, not the AionUi window (or its app menu).
  const handleControlKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      const action = webview ? controlShortcut(event) : null;
      if (!webview || !action) return;
      event.preventDefault();
      event.stopPropagation();
      runShortcut(action, webview);
    },
    [webview, runShortcut]
  );

  // Switching to an already-loaded tab fires no dom-ready, so report the active tab here as well:
  // extensions (chrome.tabs active tab) follow the tab on screen.
  useEffect(() => {
    if (!active || !webview) return;
    const webContentsId = ownWebContentsId(webview);
    if (webContentsId === null) return;
    ipcBridge.application.reportBrowserWebContentsId.invoke({ webContentsId }).catch((error: unknown) => {
      console.warn('[BrowserViewer] could not report the active tab:', error);
    });
  }, [active, webview]);

  // An extension or an agent closed a tab (chrome.tabs.remove, Target.closeTarget); only the webview it names closes.
  // A request can arrive before this tab knows its own webContents id (main has the tab, the renderer has not
  // seen did-attach yet), so those are kept and checked once the id is known.
  const closable = webview ?? attachedWebview;
  const earlyCloseIds = useRef<number[]>([]);
  useEffect(() => {
    const own = closable ? ownWebContentsId(closable) : null;
    if (own !== null) {
      const requested = earlyCloseIds.current.includes(own);
      earlyCloseIds.current = [];
      if (requested) onRequestClose?.(tabId);
    }
    return ipcBridge.browser.closeTabRequested.on(({ webContentsId }) => {
      const current = closable ? ownWebContentsId(closable) : null;
      if (current === null) earlyCloseIds.current = [...earlyCloseIds.current, webContentsId].slice(-MAX_EARLY_CLOSES);
      else if (webContentsId === current) onRequestClose?.(tabId);
    });
  }, [closable, tabId, onRequestClose]);

  // Only a change is reported, so an ordinary user tab never writes to the tab list.
  useEffect(() => {
    if (reportedAgentOwned.current === agentOwned) return;
    reportedAgentOwned.current = agentOwned;
    onAgentOwnedChange?.(tabId, agentOwned);
  }, [agentOwned, tabId, onAgentOwnedChange]);

  return (
    <div className='relative h-full w-full' onKeyDown={handleControlKeyDown}>
      <WebviewHost
        url={url || BROWSER_BLANK_URL}
        partition={BROWSER_SESSION_PARTITION}
        showNavBar
        interceptNavigation={false}
        navBarExtra={
          <>
            {tabWebContentsId !== null && (
              <AgentControls webContentsId={tabWebContentsId} ownership={ownership} actions={actions} />
            )}
            <ExtensionActions />
            <DownloadsButton />
          </>
        }
        className='bg-bg-1'
        resolveUrlInput={resolveAddressBarInput}
        onUrlChange={handleUrlChange}
        onTitleChange={handleTitleChange}
        onFaviconChange={handleFaviconChange}
        onDidFinishLoad={handleDidFinishLoad}
        onDidFailLoad={handleDidFailLoad}
        onWebviewReady={setWebview}
        onWebviewAttached={setAttachedWebview}
        onRenderProcessGone={handleRenderProcessGone}
        onUnresponsive={handleUnresponsive}
        onResponsive={handleResponsive}
        addressInputRef={addressInputRef}
      />
      {/* Mounted only while crashed or hung: any element here covers the webview and eats mouse input.
          Starts below the 40px nav bar (h-40px in WebviewHost) so the address bar stays usable. */}
      {crashState && (
        <div className='absolute inset-x-0 bottom-0 top-40px'>
          <CrashOverlay state={crashState} reloading={reloading} onReload={handleReload} onWait={handleWait} />
        </div>
      )}
      <AgentOverlay action={actions[actions.length - 1] ?? null} />
      {tabWebContentsId !== null && ownership?.paused && (
        <div className='absolute top-48px start-1/2 z-20 -translate-x-1/2'>
          <AgentBanner webContentsId={tabWebContentsId} />
        </div>
      )}
      {findOpen && webview && (
        <div className='absolute top-48px end-16px z-20'>
          <FindBar webview={webview} onClose={closeFind} focusToken={findFocusToken} />
        </div>
      )}
    </div>
  );
};

export default BrowserViewer;
