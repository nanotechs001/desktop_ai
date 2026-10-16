/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ipcBridge } from '@/common';
import WebviewHost from '@/renderer/components/media/WebviewHost';
import { useOptionalPreviewContext } from '../context/PreviewContext';
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

/** `getWebContentsId()` throws before dom-ready and after the page crashed; that means "not this one". */
const ownWebContentsId = (webview: Electron.WebviewTag): number | null => {
  try {
    return webview.getWebContentsId();
  } catch {
    return null;
  }
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
}) => {
  const preview = useOptionalPreviewContext();
  const [webview, setWebview] = useState<Electron.WebviewTag | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findFocusToken, setFindFocusToken] = useState(0);
  const [crashState, setCrashState] = useState<CrashState>(null);
  const [reloading, setReloading] = useState(false);
  const addressInputRef = useRef<HTMLInputElement | null>(null);

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
  const handleResponsive = useCallback(() => setCrashState((state) => (state === 'unresponsive' ? null : state)), []);
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

  // Main reports shortcuts for every browser page; only the webview whose id matches acts on them.
  useEffect(() => {
    if (!webview) return;
    return ipcBridge.browser.shortcut.on(({ webContentsId, action }) => {
      if (webContentsId !== ownWebContentsId(webview)) return;
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
            webview.stopFindInPage('clearSelection');
            closeFind();
          }
          break;
      }
    });
  }, [webview, tabId, findOpen, preview, onRequestClose, closeFind]);

  // An extension closed a tab (chrome.tabs.remove); only the webview it names closes.
  useEffect(() => {
    if (!webview) return;
    return ipcBridge.browser.closeTabRequested.on(({ webContentsId }) => {
      if (webContentsId === ownWebContentsId(webview)) onRequestClose?.(tabId);
    });
  }, [webview, tabId, onRequestClose]);

  return (
    <div className='relative h-full w-full'>
      <WebviewHost
        url={url || BROWSER_BLANK_URL}
        partition={BROWSER_SESSION_PARTITION}
        showNavBar
        interceptNavigation={false}
        navBarExtra={
          <>
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
        onWebviewReady={setWebview}
        onRenderProcessGone={handleRenderProcessGone}
        onUnresponsive={handleUnresponsive}
        onResponsive={handleResponsive}
        addressInputRef={addressInputRef}
      />
      {/* Starts below the 40px nav bar (h-40px in WebviewHost) so the address bar stays usable. */}
      <div className='absolute inset-x-0 bottom-0 top-40px'>
        <CrashOverlay state={crashState} reloading={reloading} onReload={handleReload} onWait={handleWait} />
      </div>
      {findOpen && webview && (
        <div className='absolute top-48px end-16px z-20'>
          <FindBar webview={webview} onClose={closeFind} focusToken={findFocusToken} />
        </div>
      )}
    </div>
  );
};

export default BrowserViewer;
