/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useOptionalPreviewContext } from '../context/PreviewContext';
import ConfirmPrompt from './BrowserChrome/ConfirmPrompt';
import PermissionPrompt from './BrowserChrome/PermissionPrompt';
import BrowserViewer from './BrowserViewer';

type Box = { left: number; top: number; width: number; height: number };

/** Hidden tabs keep the last slot's size; before any slot they get a common window size, never zero. */
const DEFAULT_BOX: Box = { left: 0, top: 0, width: 1024, height: 768 };

/** How long to keep measuring each frame after a layout event: covers the panel and sider transitions. */
const SETTLE_MS = 300;

/** The mounted {@link BrowserSlot}, if any; at most one preview panel is on screen. */
let slotElement: HTMLElement | null = null;
const slotListeners = new Set<() => void>();
const setSlot = (element: HTMLElement | null): void => {
  slotElement = element;
  slotListeners.forEach((listener) => listener());
};
const subscribeSlot = (listener: () => void): (() => void) => {
  slotListeners.add(listener);
  return () => slotListeners.delete(listener);
};
const registerSlot = (element: HTMLDivElement | null) => {
  if (!element) return;
  setSlot(element);
  return () => {
    if (slotElement === element) setSlot(null);
  };
};

/**
 * Where the browser tab on screen goes: the preview panel renders this while its active tab is a
 * browser tab. The webview itself lives in {@link BrowserTabLayer} and is laid over this box.
 */
export const BrowserSlot: React.FC = () => (
  <div ref={registerSlot} data-browser-slot='' className='relative flex-1 overflow-hidden' />
);

/**
 * The slot's box, measured only while a slot is mounted: once, then on its (and the app shell's)
 * ResizeObserver, window resize and CSS transitions/animations, each followed by a short burst of
 * per-frame measuring, since a panel can move without resizing (sider collapse, maximize).
 */
const useSlotBox = (slot: HTMLElement | null): { box: Box; visible: boolean } => {
  const [state, setState] = useState<{ box: Box; visible: boolean }>({ box: DEFAULT_BOX, visible: false });
  useEffect(() => {
    if (!slot) {
      setState((prev) => (prev.visible ? { box: prev.box, visible: false } : prev));
      return;
    }
    const measure = () => {
      const rect = slot.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      setState((prev) => {
        const box = visible ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : prev.box;
        const same =
          prev.visible === visible &&
          prev.box.left === box.left &&
          prev.box.top === box.top &&
          prev.box.width === box.width &&
          prev.box.height === box.height;
        return same ? prev : { box, visible };
      });
    };
    let frame = 0;
    let settleUntil = 0;
    const tick = () => {
      measure();
      frame = performance.now() < settleUntil ? requestAnimationFrame(tick) : 0;
    };
    const burst = () => {
      measure();
      settleUntil = performance.now() + SETTLE_MS;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    measure();
    const observer = new ResizeObserver(burst);
    observer.observe(slot);
    observer.observe(slot.closest('.app-shell') ?? document.body);
    const layoutEvents = ['transitionrun', 'transitionend', 'animationend'] as const;
    window.addEventListener('resize', burst);
    layoutEvents.forEach((type) => document.addEventListener(type, burst, true));
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', burst);
      layoutEvents.forEach((type) => document.removeEventListener(type, burst, true));
    };
  }, [slot]);
  return state;
};

/** The `<webview>` of a tab in the layer, if mounted. */
const webviewOf = (layer: HTMLElement, tabId: string): HTMLElement | null =>
  layer.querySelector<HTMLElement>(`[data-browser-tab="${tabId}"] webview`);

/**
 * 常驻挂载的浏览器层 / Always-mounted browser layer.
 *
 * Every live browser tab, of every chat, is mounted here once, at the app layout, and only its
 * visibility changes: a webview that leaves the DOM (or moves in it) reloads, losing scroll position,
 * form input and any in-flight agent operation. So closing the panel, leaving for /settings or another
 * project's chat only hides a tab; the tab on screen is laid over the panel's {@link BrowserSlot}.
 * Hidden tabs are never `display:none`, so they keep real dimensions (agents read and screenshot them);
 * see BrowserViewer for how user and agent tabs are hidden.
 */
const BrowserTabLayer: React.FC = () => {
  const preview = useOptionalPreviewContext();
  const tabs = preview?.liveBrowserTabs ?? [];
  const slot = useSyncExternalStore(subscribeSlot, () => slotElement);
  const { box, visible } = useSlotBox(tabs.length > 0 ? slot : null);
  const layerRef = useRef<HTMLDivElement>(null);
  const shownTab = visible ? tabs.find((tab) => tab.id === preview?.activeTabId) : undefined;
  const shownId = shownTab?.id ?? null;
  const shownByAgent = Boolean(shownTab?.metadata?.agentOwned);
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

  // Whether the user's last focus was in a page of this layer (not the chat, not the app's controls). Kept from
  // focusin, because when a hidden page becomes inert Chromium moves the focus to the body before any effect runs.
  const focusWasInBrowser = useRef(false);
  useEffect(() => {
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target;
      focusWasInBrowser.current =
        target instanceof HTMLElement && target.tagName === 'WEBVIEW' && Boolean(layerRef.current?.contains(target));
    };
    document.addEventListener('focusin', onFocusIn);
    return () => document.removeEventListener('focusin', onFocusIn);
  }, []);

  // Keyboard focus never stays in a hidden page. When the user was in the browser and the tab on screen changes
  // (a page opened one with target=_blank, or switching tabs), the shown page takes the focus, as in a browser;
  // an agent's tab never does.
  useEffect(() => {
    const layer = layerRef.current;
    if (!layer) return;
    const shownWebview = shownId ? webviewOf(layer, shownId) : null;
    const focused = document.activeElement;
    if (
      focused instanceof HTMLElement &&
      focused.tagName === 'WEBVIEW' &&
      layer.contains(focused) &&
      focused !== shownWebview
    ) {
      focused.blur();
    }
    if (focusWasInBrowser.current && !shownByAgent && shownWebview && document.activeElement !== shownWebview) {
      shownWebview.focus();
    }
  }, [shownId, shownByAgent]);

  if (!preview || tabs.length === 0) return null;

  return (
    // On top while a tab is shown (laid over the slot, hidden tabs under it); behind the app's opaque layout
    // otherwise, where hidden agent tabs stay hit-testable for agent input but out of the user's sight and reach.
    <div
      ref={layerRef}
      className='fixed overflow-hidden pointer-events-none'
      style={{ ...box, zIndex: shownId ? 10 : -1 }}
    >
      {tabs.map((tab) => {
        const shown = tab.id === shownId;
        return (
          <div
            key={tab.id}
            data-browser-tab={tab.id}
            className='absolute inset-0 flex flex-col'
            style={{
              // Hidden tabs are hidden by the viewer itself: user tabs invisible, agent tabs transparent.
              visibility: shown ? 'visible' : undefined,
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
