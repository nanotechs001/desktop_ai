/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useState } from 'react';
import { useOptionalPreviewContext } from '../context/PreviewContext';
import ConfirmPrompt from './BrowserChrome/ConfirmPrompt';
import PermissionPrompt from './BrowserChrome/PermissionPrompt';
import BrowserViewer from './BrowserViewer';

const SLOT_ATTRIBUTE = 'data-browser-slot';

type Box = { left: number; top: number; width: number; height: number };

/** Hidden tabs keep the last slot's size; before any slot they get a common window size, never zero. */
const DEFAULT_BOX: Box = { left: 0, top: 0, width: 1024, height: 768 };

/**
 * Where the browser tab on screen goes: the preview panel renders this while its active tab is a
 * browser tab. The webview itself lives in {@link BrowserTabLayer} and is laid over this box.
 */
export const BrowserSlot: React.FC = () => <div data-browser-slot='' className='relative flex-1 overflow-hidden' />;

/** The slot's box while it is on screen (polled each frame: the panel moves and resizes without telling). */
const useSlotBox = (active: boolean): { box: Box; visible: boolean } => {
  const [state, setState] = useState<{ box: Box; visible: boolean }>({ box: DEFAULT_BOX, visible: false });
  useEffect(() => {
    if (!active) return;
    let frame = 0;
    const measure = () => {
      const rect = document.querySelector(`[${SLOT_ATTRIBUTE}]`)?.getBoundingClientRect();
      const visible = Boolean(rect && rect.width > 0 && rect.height > 0);
      setState((prev) => {
        const box =
          visible && rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : prev.box;
        const same =
          prev.visible === visible &&
          prev.box.left === box.left &&
          prev.box.top === box.top &&
          prev.box.width === box.width &&
          prev.box.height === box.height;
        return same ? prev : { box, visible };
      });
      frame = requestAnimationFrame(measure);
    };
    measure();
    return () => cancelAnimationFrame(frame);
  }, [active]);
  return state;
};

/**
 * 常驻挂载的浏览器层 / Always-mounted browser layer.
 *
 * Every live browser tab, of every chat, is mounted here once, at the app layout, and only its
 * visibility changes: a webview that leaves the DOM (or moves in it) reloads, losing scroll position,
 * form input and any in-flight agent operation. So closing the panel, leaving for /settings or another
 * project's chat only hides a tab; the tab on screen is laid over the panel's {@link BrowserSlot}.
 * Hidden tabs use `visibility` rather than `display:none` so they keep real dimensions (agents read
 * and screenshot them), and take no pointer input.
 */
const BrowserTabLayer: React.FC = () => {
  const preview = useOptionalPreviewContext();
  const tabs = preview?.liveBrowserTabs ?? [];
  const { box, visible } = useSlotBox(tabs.length > 0);
  const updateTab = preview?.updateTab;
  const closeTab = preview?.closeTab;

  const handleUrlChange = useCallback(
    // 地址存在 content 里，与其他 tab 类型保持一致 / Address lives in content, like other tab types
    (tabId: string, url: string) => updateTab?.(tabId, { content: url }),
    [updateTab]
  );
  const handleTitleChange = useCallback((tabId: string, title: string) => updateTab?.(tabId, { title }), [updateTab]);
  const handleFaviconChange = useCallback(
    (tabId: string, favicon: string) => updateTab?.(tabId, { metadata: { favicon } }),
    [updateTab]
  );
  const handleAgentOwnedChange = useCallback(
    (tabId: string, agentOwned: boolean) => updateTab?.(tabId, { metadata: { agentOwned } }),
    [updateTab]
  );

  if (!preview || tabs.length === 0) return null;

  return (
    <div className='fixed overflow-hidden z-10 pointer-events-none' style={box}>
      {tabs.map((tab) => {
        const shown = visible && tab.id === preview.activeTabId;
        return (
          <div
            key={tab.id}
            className='absolute inset-0 flex flex-col'
            style={{
              visibility: shown ? 'visible' : 'hidden',
              pointerEvents: shown ? 'auto' : 'none',
              zIndex: shown ? 1 : 0,
            }}
          >
            <BrowserViewer
              url={tab.content}
              tabId={tab.id}
              onUrlChange={handleUrlChange}
              onTitleChange={handleTitleChange}
              onFaviconChange={handleFaviconChange}
              onRequestClose={closeTab}
              onAgentOwnedChange={handleAgentOwnedChange}
              active={shown}
            />
          </div>
        );
      })}
      <PermissionPrompt />
      <ConfirmPrompt />
    </div>
  );
};

export default BrowserTabLayer;
