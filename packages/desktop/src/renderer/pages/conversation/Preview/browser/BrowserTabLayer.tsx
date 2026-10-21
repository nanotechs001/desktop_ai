/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { BrowserTabProfile } from '@/common/types/browser';
import { profileKeyOf } from './BrowserProfiles/useBrowserProfiles';
import { useOptionalPreviewContext } from '../context/PreviewContext';
import ConfirmPrompt from './BrowserChrome/ConfirmPrompt';
import PermissionPrompt from './BrowserChrome/PermissionPrompt';
import BrowserViewer from './BrowserViewer';
import { useFollowAgentTab } from './useFollowAgentTab';

type Box = { left: number; top: number; width: number; height: number };

/** Hidden tabs keep the last slot's size; before any slot they get a common window size, never zero. */
const DEFAULT_BOX: Box = { left: 0, top: 0, width: 1024, height: 768 };

/** How long to keep measuring each frame after a layout event: covers the longest pane motion token (320 ms) and more. */
const SETTLE_MS = 400;

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

/** The box moved and shrunk to fit in the window, so agent input aimed at a hidden tab stays inside it. */
const clampToWindow = (box: Box, viewport: { width: number; height: number }): Box => {
  const width = Math.min(box.width, viewport.width);
  const height = Math.min(box.height, viewport.height);
  return {
    left: Math.min(Math.max(box.left, 0), viewport.width - width),
    top: Math.min(Math.max(box.top, 0), viewport.height - height),
    width,
    height,
  };
};

const windowSize = () => ({ width: window.innerWidth, height: window.innerHeight });

/** How far the slot sticks out of its clipping ancestor, as a `clip-path` (a pane mid reveal), or `none`. */
const clipOf = (rect: DOMRect, clip: Element | null): string => {
  if (!clip) return 'none';
  const area = clip.getBoundingClientRect();
  const top = Math.max(0, area.top - rect.top);
  const right = Math.max(0, rect.right - area.right);
  const bottom = Math.max(0, rect.bottom - area.bottom);
  const left = Math.max(0, area.left - rect.left);
  return top || right || bottom || left ? `inset(${top}px ${right}px ${bottom}px ${left}px)` : 'none';
};

/** The opacity of the fading ancestor (a pane fading in), so the webview fades with it instead of popping. */
const opacityOf = (fade: Element | null): string => (fade ? getComputedStyle(fade).opacity || '1' : '1');

/**
 * The slot's box, measured only while a slot is mounted: once, then on its (and the app shell's)
 * ResizeObserver, window resize and CSS transitions/animations, each followed by a short burst of
 * per-frame measuring, since a panel can move without resizing (sider collapse, maximize). With no slot,
 * the last box is kept, clamped to the window as it resizes.
 *
 * During a burst each frame writes the box straight onto the layer (`layer`), with the slot's clip
 * (`[data-browser-clip]`) and fade (`[data-browser-fade]`) as `--browser-clip` / `--browser-opacity`, and
 * React state is committed once the burst settles, so an animating pane does not re-render every viewer
 * each frame.
 */
const useSlotBox = (
  slot: HTMLElement | null,
  layer: React.RefObject<HTMLDivElement | null>
): { box: Box; visible: boolean } => {
  const [state, setState] = useState<{ box: Box; visible: boolean }>({ box: DEFAULT_BOX, visible: false });
  const [viewport, setViewport] = useState(windowSize);
  useEffect(() => {
    if (!slot) {
      setState((prev) => (prev.visible ? { box: prev.box, visible: false } : prev));
      const follow = () =>
        setViewport((prev) => {
          const next = windowSize();
          return prev.width === next.width && prev.height === next.height ? prev : next;
        });
      follow();
      window.addEventListener('resize', follow);
      return () => window.removeEventListener('resize', follow);
    }
    const clipArea = slot.closest('[data-browser-clip]');
    const fade = slot.closest('[data-browser-fade]');
    let latest: { box: Box; visible: boolean } | null = null;
    const commit = (next: { box: Box; visible: boolean }) =>
      setState((prev) => {
        const same =
          prev.visible === next.visible &&
          prev.box.left === next.box.left &&
          prev.box.top === next.box.top &&
          prev.box.width === next.box.width &&
          prev.box.height === next.box.height;
        return same ? prev : next;
      });
    /** Measures the slot; the layer follows at once, React state only when `settle` (or visibility changed). */
    const measure = (settle: boolean) => {
      const rect = slot.getBoundingClientRect();
      const visible = rect.width > 0 && rect.height > 0;
      const box = visible ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : null;
      const element = layer.current;
      if (element && box) {
        element.style.left = `${box.left}px`;
        element.style.top = `${box.top}px`;
        element.style.width = `${box.width}px`;
        element.style.height = `${box.height}px`;
        element.style.setProperty('--browser-clip', clipOf(rect, clipArea));
        element.style.setProperty('--browser-opacity', opacityOf(fade));
      }
      const visibilityChanged = latest !== null && latest.visible !== visible;
      latest = { box: box ?? latest?.box ?? DEFAULT_BOX, visible };
      if (settle || visibilityChanged || !element) commit(latest);
    };
    let frame = 0;
    let settleUntil = 0;
    const tick = () => {
      const settled = performance.now() >= settleUntil;
      measure(settled);
      frame = settled ? 0 : requestAnimationFrame(tick);
    };
    const burst = () => {
      measure(false);
      settleUntil = performance.now() + SETTLE_MS;
      if (!frame) frame = requestAnimationFrame(tick);
    };
    measure(true);
    const observer = new ResizeObserver(burst);
    observer.observe(slot);
    observer.observe(slot.closest('.app-shell') ?? document.body);
    const layoutEvents = [
      'transitionrun',
      'transitionstart',
      'transitionend',
      'transitioncancel',
      'animationstart',
      'animationend',
      'animationcancel',
    ] as const;
    window.addEventListener('resize', burst);
    layoutEvents.forEach((type) => document.addEventListener(type, burst, true));
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      window.removeEventListener('resize', burst);
      layoutEvents.forEach((type) => document.removeEventListener(type, burst, true));
      // The last measured box, so a re-measure (or no slot) starts from where the layer really is.
      if (latest) commit(latest);
    };
  }, [slot, layer]);
  return slot ? state : { box: clampToWindow(state.box, viewport), visible: state.visible };
};

const noop = (): void => undefined;

/** A stable key per browser profile. */
const profileKey = (profile: BrowserTabProfile | undefined): string => profileKeyOf(profile);

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
  const layerRef = useRef<HTMLDivElement>(null);
  const { box, visible } = useSlotBox(tabs.length > 0 ? slot : null, layerRef);
  const shownTab = visible ? tabs.find((tab) => tab.id === preview?.activeTabId) : undefined;
  const shownId = shownTab?.id ?? null;
  const shownByAgent = Boolean(shownTab?.metadata?.agentOwned);
  const updateTab = preview?.updateTab;
  const closeTab = preview?.closeTab;
  // The pane on screen follows the agent to the tab it works in (only this chat's tabs, never while the user is busy).
  const followAgent = useFollowAgentTab({
    tabs: preview?.tabs ?? [],
    activeTabId: preview?.activeTabId ?? null,
    switchTab: preview?.switchTab ?? noop,
  });

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
    (tabId: string, agentOwned: boolean, agentConversationId?: string) =>
      updateTab?.(tabId, { metadata: { agentOwned, agentConversationId } }),
    [updateTab]
  );

  // Whether the user's last focus was in the page on screen (not the chat, not the app's controls). Kept from
  // focusin, because when a hidden page becomes inert Chromium moves the focus to the body before any effect runs.
  const focusWasInBrowser = useRef(false);
  // The element outside hidden tabs that last lost the focus. Electron moves the focus into a webview with no
  // relatedTarget (the chat blurs, the window blurs, the webview gets a focus event but no focusin), and so does
  // Chromium when the window comes back. shortcut: also kept after the user clicks a blank area, so a hidden page
  // stealing the focus later puts it back there instead of on the body; harmless, no typing is lost.
  const lastFocus = useRef<HTMLElement | null>(null);
  // A hidden tab never keeps the focus: an agent's click, or its page calling focus(), lands there while the
  // user types elsewhere. It goes back where it came from (or stays on the body).
  useEffect(() => {
    /** `node` itself when it is in a tab that is not on screen, else null. */
    const inHiddenTab = (node: EventTarget | null): HTMLElement | null => {
      if (!(node instanceof HTMLElement)) return null;
      const tab = node.closest('[data-browser-tab]');
      // Read from the DOM, not render state: child effects (a crash overlay, the find bar) focus before ours run.
      return tab && layerRef.current?.contains(tab) && !tab.hasAttribute('data-shown') ? node : null;
    };
    const giveBack = (target: HTMLElement, previous: EventTarget | null) => {
      target.blur();
      const back = previous instanceof HTMLElement ? previous : lastFocus.current;
      if (back?.isConnected && !inHiddenTab(back)) back.focus();
    };
    const remember = (node: EventTarget | null) => {
      if (node instanceof HTMLElement && node !== document.body && !inHiddenTab(node)) lastFocus.current = node;
    };
    const onFocus = (event: FocusEvent) => {
      const hidden = inHiddenTab(event.target);
      if (hidden) {
        giveBack(hidden, event.relatedTarget);
        return;
      }
      const target = event.target;
      lastFocus.current = null;
      focusWasInBrowser.current =
        target instanceof HTMLElement && target.tagName === 'WEBVIEW' && Boolean(layerRef.current?.contains(target));
    };
    const onFocusOut = (event: FocusEvent) => remember(event.target);
    const onWindowBlur = () => remember(document.activeElement);
    const onWindowFocus = () => {
      const hidden = inHiddenTab(document.activeElement);
      if (hidden) giveBack(hidden, null);
    };
    document.addEventListener('focusin', onFocus);
    document.addEventListener('focus', onFocus, true);
    document.addEventListener('focusout', onFocusOut);
    window.addEventListener('blur', onWindowBlur);
    window.addEventListener('focus', onWindowFocus);
    return () => {
      document.removeEventListener('focusin', onFocus);
      document.removeEventListener('focus', onFocus, true);
      document.removeEventListener('focusout', onFocusOut);
      window.removeEventListener('blur', onWindowBlur);
      window.removeEventListener('focus', onWindowFocus);
    };
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
            data-shown={shown || undefined}
            className='absolute inset-0 flex flex-col'
            style={{
              // Hidden tabs are hidden by the viewer itself: user tabs invisible, agent tabs transparent.
              visibility: shown ? 'visible' : undefined,
              pointerEvents: shown ? 'auto' : 'none',
              zIndex: shown ? 1 : 0,
              // Only the shown tab follows a pane's reveal and fade: hidden agent tabs keep their whole box.
              clipPath: shown ? 'var(--browser-clip, none)' : undefined,
              opacity: shown ? 'var(--browser-opacity, 1)' : undefined,
            }}
          >
            {/* Keyed by profile: a webview cannot change partition, so another profile is a fresh viewer. */}
            <BrowserViewer
              key={profileKey(tab.metadata?.profile)}
              profile={tab.metadata?.profile}
              url={tab.content}
              tabId={tab.id}
              onUrlChange={handleUrlChange}
              onTitleChange={handleTitleChange}
              onFaviconChange={handleFaviconChange}
              onRequestClose={closeTab}
              onAgentOwnedChange={handleAgentOwnedChange}
              agentOwnedHint={Boolean(tab.metadata?.agentOwned)}
              onAgentAction={followAgent.onAgentAction}
              onUserInput={followAgent.onUserInput}
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
