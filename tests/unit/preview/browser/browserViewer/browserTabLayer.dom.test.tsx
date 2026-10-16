/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  closeTab: vi.fn(),
  context: { liveBrowserTabs: [] as unknown[], activeTabId: null as string | null },
  viewerProps: [] as Array<{ tabId: string; active?: boolean; onRequestClose?: (id: string) => void }>,
}));

vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => ({ ...mocks.context, closeTab: mocks.closeTab, updateTab: vi.fn() }),
}));
// A focusable stand-in for the viewer's <webview>.
vi.mock('@/renderer/pages/conversation/Preview/browser/BrowserViewer', async () => {
  const { createElement } = await import('react');
  return {
    default: (props: { tabId: string; active?: boolean; onRequestClose?: (id: string) => void }) => {
      mocks.viewerProps.push(props);
      return createElement('webview', { tabIndex: 0, 'data-testid': `webview-${props.tabId}` });
    },
  };
});
vi.mock('@/renderer/pages/conversation/Preview/browser/BrowserChrome/PermissionPrompt', () => ({
  default: () => null,
}));
vi.mock('@/renderer/pages/conversation/Preview/browser/BrowserChrome/ConfirmPrompt', () => ({ default: () => null }));

import BrowserTabLayer, { BrowserSlot } from '@/renderer/pages/conversation/Preview/browser/BrowserTabLayer';
import type { PreviewTab } from '@/renderer/pages/conversation/Preview/context/PreviewContext';

/** ResizeObservers created while a test runs, with their callbacks. */
let observers: Array<{ callback: ResizeObserverCallback; observed: Element[] }> = [];
let slotBox = { left: 0, top: 0, width: 800, height: 600 };

beforeEach(() => {
  observers = [];
  slotBox = { left: 0, top: 0, width: 800, height: 600 };
  vi.stubGlobal(
    'ResizeObserver',
    class {
      private readonly entry: { callback: ResizeObserverCallback; observed: Element[] };
      constructor(callback: ResizeObserverCallback) {
        this.entry = { callback, observed: [] };
        observers.push(this.entry);
      }
      observe(target: Element) {
        this.entry.observed.push(target);
      }
      unobserve() {}
      disconnect() {}
    }
  );
  // jsdom lays nothing out; give the panel's slot a box so the active tab can be shown.
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(
    () => ({ ...slotBox, x: slotBox.left, y: slotBox.top }) as DOMRect
  );
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.clearAllMocks();
  mocks.viewerProps.length = 0;
});

const TABS = [
  { id: 'tab-1', content: 'https://a.test' },
  { id: 'tab-2', content: 'https://b.test' },
] as PreviewTab[];

const layout = (tabs: PreviewTab[], activeTabId: string, withSlot = true) => {
  mocks.context = { liveBrowserTabs: tabs, activeTabId };
  return (
    <>
      {withSlot && <BrowserSlot />}
      <BrowserTabLayer />
    </>
  );
};

const wrapperOf = (tabId: string) => document.querySelector(`[data-testid="webview-${tabId}"]`)?.parentElement;

describe('BrowserTabLayer', () => {
  it('passes the preview context closeTab to each viewer as onRequestClose', () => {
    render(layout([TABS[0]], 'tab-1'));

    mocks.viewerProps[0].onRequestClose?.('tab-1');

    expect(mocks.closeTab).toHaveBeenCalledWith('tab-1');
  });

  it('tells only the active tab that it is active, once the panel slot is on screen', () => {
    render(layout(TABS, 'tab-2'));

    expect(mocks.viewerProps.slice(-2).map(({ tabId, active }) => [tabId, active])).toEqual([
      ['tab-1', false],
      ['tab-2', true],
    ]);
  });

  it('does no measuring work while no slot is mounted (panel closed, /settings)', () => {
    const frame = vi.spyOn(window, 'requestAnimationFrame');
    render(layout(TABS, 'tab-1', false));

    expect(frame).not.toHaveBeenCalled();
    expect(observers).toHaveLength(0);
    expect(mocks.viewerProps.every(({ active }) => !active)).toBe(true);
  });

  it('follows the slot when its ResizeObserver reports a change', () => {
    render(layout(TABS, 'tab-1'));
    const layer = wrapperOf('tab-1')?.parentElement as HTMLElement;
    expect(layer.style.width).toBe('800px');
    const slotObserver = observers.find(({ observed }) => observed.some((el) => el.hasAttribute('data-browser-slot')));

    slotBox = { left: 40, top: 30, width: 500, height: 400 };
    act(() => slotObserver?.callback([], {} as ResizeObserver));

    expect([layer.style.left, layer.style.top, layer.style.width, layer.style.height]).toEqual([
      '40px',
      '30px',
      '500px',
      '400px',
    ]);
  });

  it('sits on top while a tab is shown, and behind the app while none is (agent tabs stay hit-testable there)', () => {
    const { rerender } = render(layout(TABS, 'tab-1'));
    const layer = () => wrapperOf('tab-1')?.parentElement as HTMLElement;
    expect(layer().style.zIndex).toBe('10');

    rerender(layout(TABS, 'tab-1', false));

    expect(layer().style.zIndex).toBe('-1');
  });

  it('blurs a webview whose tab stops being shown', () => {
    const { rerender } = render(layout(TABS, 'tab-1'));
    const first = document.querySelector<HTMLElement>('[data-testid="webview-tab-1"]');
    act(() => first?.focus());
    expect(document.activeElement).toBe(first);

    rerender(layout([TABS[0], { ...TABS[1], metadata: { agentOwned: true } }], 'tab-2'));

    expect(document.activeElement).not.toBe(first);
    // An agent's tab never takes the focus.
    expect(document.activeElement?.getAttribute('data-testid')).not.toBe('webview-tab-2');
  });

  it('gives the focus to a tab a page opened, when the focus was in the browser', () => {
    const { rerender } = render(layout([TABS[0]], 'tab-1'));
    act(() => document.querySelector<HTMLElement>('[data-testid="webview-tab-1"]')?.focus());

    rerender(layout(TABS, 'tab-2'));

    expect(document.activeElement?.getAttribute('data-testid')).toBe('webview-tab-2');
  });

  it('still hands the focus over when the page lost it to the body first (inert focus fixup)', () => {
    const { rerender } = render(layout([TABS[0]], 'tab-1'));
    act(() => document.querySelector<HTMLElement>('[data-testid="webview-tab-1"]')?.focus());
    act(() => (document.activeElement as HTMLElement).blur()); // focus falls to the body, no focusin

    rerender(layout(TABS, 'tab-2'));

    expect(document.activeElement?.getAttribute('data-testid')).toBe('webview-tab-2');
  });

  it('leaves the focus alone when the user was elsewhere (e.g. typing in the chat)', () => {
    const { rerender } = render(
      <>
        <textarea data-testid='chat' />
        {layout([TABS[0]], 'tab-1')}
      </>
    );
    act(() => document.querySelector<HTMLElement>('[data-testid="chat"]')?.focus());

    rerender(
      <>
        <textarea data-testid='chat' />
        {layout(TABS, 'tab-2')}
      </>
    );

    expect(document.activeElement?.getAttribute('data-testid')).toBe('chat');
  });
});
