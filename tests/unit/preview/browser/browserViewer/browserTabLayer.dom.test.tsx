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
  takeAgentTab: vi.fn(),
  context: { liveBrowserTabs: [] as unknown[], activeTabId: null as string | null },
  viewerProps: [] as Array<{
    tabId: string;
    active?: boolean;
    agentOwnedHint?: boolean;
    onRequestClose?: (id: string) => void;
    onAgentAction?: (id: string) => void;
  }>,
}));

vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', () => ({
  useOptionalPreviewContext: () => ({
    ...mocks.context,
    closeTab: mocks.closeTab,
    takeAgentTab: mocks.takeAgentTab,
    updateTab: vi.fn(),
  }),
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

/** Stops an event before any listener of the layer sees it. */
const swallow = (event: Event) => event.stopImmediatePropagation();

const wrapperOf = (tabId: string) => document.querySelector(`[data-testid="webview-${tabId}"]`)?.parentElement;

describe('BrowserTabLayer', () => {
  it('passes the preview context closeTab to each viewer as onRequestClose', () => {
    render(layout([TABS[0]], 'tab-1'));

    mocks.viewerProps[0].onRequestClose?.('tab-1');

    expect(mocks.closeTab).toHaveBeenCalledWith('tab-1');
  });

  it("hands an agent action on any live tab to the context, so a parked tab of the chat's agent comes on screen", () => {
    render(layout(TABS, 'tab-1'));

    act(() => mocks.viewerProps.at(-1)?.onAgentAction?.('tab-2'));

    expect(mocks.takeAgentTab).toHaveBeenCalledWith('tab-2');
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

  it('tells each viewer whether the context already knows its tab as an agent tab', () => {
    render(layout([TABS[0], { ...TABS[1], metadata: { agentOwned: true } }], 'tab-1'));

    expect(mocks.viewerProps.slice(-2).map(({ tabId, agentOwnedHint }) => [tabId, agentOwnedHint])).toEqual([
      ['tab-1', false],
      ['tab-2', true],
    ]);
  });

  it('gives the focus back when a hidden tab takes it (an agent click, a page calling focus())', () => {
    render(
      <>
        <textarea data-testid='chat' />
        {layout(TABS, 'tab-1')}
      </>
    );
    const chat = document.querySelector<HTMLElement>('[data-testid="chat"]');
    act(() => chat?.focus());

    act(() => document.querySelector<HTMLElement>('[data-testid="webview-tab-2"]')?.focus());

    expect(document.activeElement).toBe(chat);
  });

  it('gives the focus back when an agent click focuses a hidden webview the way Electron does', () => {
    render(
      <>
        <textarea data-testid='chat' />
        {layout(TABS, 'tab-1')}
      </>
    );
    const chat = document.querySelector<HTMLElement>('[data-testid="chat"]');
    act(() => chat?.focus());

    // Seen in the e2e: the chat blurs to the body, the window blurs, then the webview gets a focus event
    // with no relatedTarget and no focusin.
    act(() => {
      window.addEventListener('focusin', swallow, true);
      chat?.blur();
      window.dispatchEvent(new FocusEvent('blur'));
      document.querySelector<HTMLElement>('[data-testid="webview-tab-2"]')?.focus();
      window.removeEventListener('focusin', swallow, true);
    });

    expect(document.activeElement).toBe(chat);
  });

  it('leaves the focus on the body when a hidden tab takes it and nothing had it before', () => {
    render(layout(TABS, 'tab-1'));

    act(() => document.querySelector<HTMLElement>('[data-testid="webview-tab-2"]')?.focus());

    expect(document.activeElement).toBe(document.body);
  });

  it('gives the focus back after a window blur/focus round trip ends in a hidden tab', () => {
    render(
      <>
        <textarea data-testid='chat' />
        {layout(TABS, 'tab-1', false)}
      </>
    );
    const chat = document.querySelector<HTMLElement>('[data-testid="chat"]');
    act(() => chat?.focus());
    // While the window has no OS focus Chromium fires no focus events, so the hidden tab takes it silently.
    act(() => {
      window.dispatchEvent(new FocusEvent('blur'));
      window.addEventListener('focusin', swallow, true);
      document.querySelector<HTMLElement>('[data-testid="webview-tab-1"]')?.focus();
      window.removeEventListener('focusin', swallow, true);
    });

    act(() => window.dispatchEvent(new FocusEvent('focus')));

    expect(document.activeElement).toBe(chat);
  });

  it('does not count focus in a hidden tab as the user being in the browser', () => {
    const { rerender } = render(layout(TABS, 'tab-1', false));
    act(() => document.querySelector<HTMLElement>('[data-testid="webview-tab-2"]')?.focus());

    rerender(layout(TABS, 'tab-2'));

    expect(document.activeElement?.getAttribute('data-testid')).not.toBe('webview-tab-2');
  });

  it('keeps the remembered box inside the window while no slot is mounted, following window resizes', () => {
    slotBox = { left: 300, top: 200, width: 900, height: 700 };
    const { rerender } = render(layout(TABS, 'tab-1'));
    const layer = () => wrapperOf('tab-1')?.parentElement as HTMLElement;
    const add = vi.spyOn(window, 'addEventListener');
    vi.stubGlobal('innerWidth', 1000);
    vi.stubGlobal('innerHeight', 800);

    rerender(layout(TABS, 'tab-1', false));
    expect([layer().style.left, layer().style.top, layer().style.width, layer().style.height]).toEqual([
      '100px',
      '100px',
      '900px',
      '700px',
    ]);
    expect(add.mock.calls.filter(([type]) => type === 'resize')).toHaveLength(1);

    vi.stubGlobal('innerWidth', 600);
    vi.stubGlobal('innerHeight', 500);
    act(() => window.dispatchEvent(new Event('resize')));
    expect([layer().style.left, layer().style.top, layer().style.width, layer().style.height]).toEqual([
      '0px',
      '0px',
      '600px',
      '500px',
    ]);

    const remove = vi.spyOn(window, 'removeEventListener');
    rerender(layout(TABS, 'tab-1'));
    expect(remove.mock.calls.filter(([type]) => type === 'resize').length).toBeGreaterThanOrEqual(1);
  });

  // A pane sliding in sits partly outside the row that clips it: the shown page is cut to the row, and fades with a
  // fading pane, so it never shows over the chat or pops in at full opacity.
  it('clips the shown tab to the clipping row and fades it with a fading pane, but never a hidden tab', () => {
    slotBox = { left: 600, top: 0, width: 400, height: 600 };
    const clipBox = { left: 0, top: 0, width: 800, height: 600 };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const box = this.hasAttribute('data-browser-clip') ? clipBox : slotBox;
      return {
        ...box,
        x: box.left,
        y: box.top,
        right: box.left + box.width,
        bottom: box.top + box.height,
      } as DOMRect;
    });
    mocks.context = { liveBrowserTabs: TABS, activeTabId: 'tab-1' };
    render(
      <>
        <div data-browser-clip=''>
          <div data-browser-fade='' style={{ opacity: 0.4 }}>
            <BrowserSlot />
          </div>
        </div>
        <BrowserTabLayer />
      </>
    );
    const layer = wrapperOf('tab-1')?.parentElement as HTMLElement;

    expect(layer.style.getPropertyValue('--browser-clip')).toBe('inset(0px 200px 0px 0px)');
    expect(layer.style.getPropertyValue('--browser-opacity')).toBe('0.4');
    expect(wrapperOf('tab-1')?.style.clipPath).toBe('var(--browser-clip, none)');
    expect(wrapperOf('tab-1')?.style.opacity).toBe('var(--browser-opacity, 1)');
    expect(wrapperOf('tab-2')?.style.clipPath).toBe('');
    expect(wrapperOf('tab-2')?.style.opacity).toBe('');
  });

  it('moves the layer with the slot on every frame of a transition without re-rendering the viewers', () => {
    const { container } = render(layout(TABS, 'tab-1'));
    const layer = wrapperOf('tab-1')?.parentElement as HTMLElement;
    const renders = mocks.viewerProps.length;

    slotBox = { left: 120, top: 0, width: 800, height: 600 };
    act(() => container.dispatchEvent(new Event('transitionstart', { bubbles: true })));

    expect(layer.style.left).toBe('120px');
    expect(mocks.viewerProps.length).toBe(renders);
  });
});
