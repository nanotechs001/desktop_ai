/**
 * @license
 * Copyright 2025 AionUi (aionui.com)
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * WebviewHost native-navigation mode (`interceptNavigation={false}`), nav-bar slot and
 * crash/unresponsive callbacks.
 *
 * `<webview>` is an Electron-only tag: under jsdom it mounts as an HTMLUnknownElement, so
 * the Electron methods WebviewHost calls are stubbed on that prototype and the webview's
 * events are driven with plain `dispatchEvent`.
 */

import React from 'react';
import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => ({
  ipcBridge: {
    application: { reportBrowserWebContentsId: { invoke: vi.fn(() => Promise.resolve({ success: true })) } },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import WebviewHost from '@/renderer/components/media/WebviewHost';
import BrowserViewer from '@/renderer/pages/conversation/Preview/browser/BrowserViewer';

const executeJavaScript = vi.fn((_script: string) => Promise.resolve());
const WEBVIEW_STUBS = {
  executeJavaScript,
  getWebContentsId: () => 7,
  canGoBack: () => false,
  canGoForward: () => false,
  reload: () => {},
  setZoomFactor: () => {},
};

beforeEach(() => {
  executeJavaScript.mockClear();
  Object.assign(HTMLUnknownElement.prototype, WEBVIEW_STUBS);
});

afterEach(() => {
  cleanup();
  for (const name of Object.keys(WEBVIEW_STUBS)) {
    delete (HTMLUnknownElement.prototype as unknown as Record<string, unknown>)[name];
  }
});

const getWebview = (container: HTMLElement): HTMLElement => {
  const webview = container.querySelector('webview');
  if (!webview) throw new Error('webview was not rendered');
  return webview as HTMLElement;
};

/** Dispatches a webview event inside act(), since handlers such as dom-ready set React state. */
const fire = (webview: HTMLElement, event: Event): void => {
  act(() => {
    webview.dispatchEvent(event);
  });
};

const injectedScripts = (): string[] => executeJavaScript.mock.calls.map(([script]) => script);

describe('WebviewHost interceptNavigation', () => {
  it('interceptNavigation=false: dom-ready does not inject the click/window.open/submit interceptor', () => {
    const { container } = render(<WebviewHost url='https://example.com' interceptNavigation={false} />);

    fire(getWebview(container), new Event('dom-ready'));

    const scripts = injectedScripts();
    // The viewport script still runs, so dom-ready was handled and the absence below is meaningful.
    expect(scripts.some((script) => script.includes('viewport'))).toBe(true);
    expect(scripts.some((script) => script.includes('__webviewHostInjected'))).toBe(false);
    expect(scripts.some((script) => script.includes('__WEBVIEW_HOST_NAVIGATE__'))).toBe(false);
  });

  it('interceptNavigation=false renders the webview with allowpopups="true"', () => {
    const { container } = render(<WebviewHost url='https://example.com' interceptNavigation={false} />);

    expect(getWebview(container).getAttribute('allowpopups')).toBe('true');
  });

  it('default (interceptNavigation omitted) still injects the interceptor and keeps allowpopups="false"', () => {
    const { container } = render(<WebviewHost url='https://example.com' />);

    fire(getWebview(container), new Event('dom-ready'));

    const scripts = injectedScripts();
    expect(scripts.some((script) => script.includes('__webviewHostInjected'))).toBe(true);
    expect(scripts.some((script) => script.includes("window.addEventListener('message'"))).toBe(true);
    expect(getWebview(container).getAttribute('allowpopups')).toBe('false');
  });

  it('BrowserViewer passes interceptNavigation={false}', () => {
    const { container } = render(
      <BrowserViewer
        url='https://example.com'
        tabId='tab-1'
        onUrlChange={vi.fn()}
        onTitleChange={vi.fn()}
        onFaviconChange={vi.fn()}
      />
    );

    fire(getWebview(container), new Event('dom-ready'));

    expect(getWebview(container).getAttribute('allowpopups')).toBe('true');
    expect(injectedScripts().some((script) => script.includes('__webviewHostInjected'))).toBe(false);
  });
});

describe('WebviewHost navBarExtra', () => {
  it('renders navBarExtra inside the nav bar when showNavBar is true', () => {
    const { container } = render(
      <WebviewHost url='https://example.com' showNavBar navBarExtra={<span data-testid='extra'>extra</span>} />
    );

    const toolbar = container.querySelector('.aion-url-viewer-toolbar');
    expect(toolbar).not.toBeNull();
    expect(toolbar?.querySelector('[data-testid="extra"]')).not.toBeNull();
  });
});

describe('WebviewHost process health callbacks', () => {
  it('calls onRenderProcessGone with the event details when the webview fires render-process-gone', () => {
    const onRenderProcessGone = vi.fn();
    const { container } = render(<WebviewHost url='https://example.com' onRenderProcessGone={onRenderProcessGone} />);

    const details = { reason: 'crashed', exitCode: 139 };
    fire(getWebview(container), Object.assign(new Event('render-process-gone'), { details }));

    expect(onRenderProcessGone).toHaveBeenCalledTimes(1);
    expect(onRenderProcessGone).toHaveBeenCalledWith(details);
  });

  it('calls onUnresponsive / onResponsive on the matching webview events', () => {
    const onUnresponsive = vi.fn();
    const onResponsive = vi.fn();
    const { container } = render(
      <WebviewHost url='https://example.com' onUnresponsive={onUnresponsive} onResponsive={onResponsive} />
    );
    const webview = getWebview(container);

    fire(webview, new Event('unresponsive'));
    expect(onUnresponsive).toHaveBeenCalledTimes(1);
    expect(onResponsive).not.toHaveBeenCalled();

    fire(webview, new Event('responsive'));
    expect(onResponsive).toHaveBeenCalledTimes(1);
    expect(onUnresponsive).toHaveBeenCalledTimes(1);
  });

  it('stops forwarding webview events once unmounted', () => {
    const onUnresponsive = vi.fn();
    const { container, unmount } = render(<WebviewHost url='https://example.com' onUnresponsive={onUnresponsive} />);
    const webview = getWebview(container);

    unmount();
    fire(webview, new Event('unresponsive'));

    expect(onUnresponsive).not.toHaveBeenCalled();
  });
});
