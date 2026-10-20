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
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/common', () => ({
  ipcBridge: {
    application: { reportBrowserWebContentsId: { invoke: vi.fn(() => Promise.resolve({ success: true })) } },
    agentBrowser: {
      ownershipChanged: { on: () => () => {} },
      agentAction: { on: () => () => {} },
      getOwnership: { invoke: () => Promise.resolve({ success: true, data: [] }) },
    },
    // BrowserViewer mounts DownloadsButton in the nav bar.
    browser: {
      getDownloads: { invoke: vi.fn(() => Promise.resolve({ success: true, data: [] })) },
      downloadsChanged: { on: () => () => {} },
      shortcut: { on: () => () => {} },
      closeTabRequested: { on: () => () => {} },
    },
  },
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

// Outside a PreviewProvider by default, like the real hook; the WebUI notice tests hand in a preview.
const optionalPreview = vi.hoisted(() => ({ value: null as { closePreview: () => void } | null }));
vi.mock('@/renderer/pages/conversation/Preview/context/PreviewContext', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useOptionalPreviewContext: () => optionalPreview.value,
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
    const onRenderProcessGone = vi.fn();
    const onUnresponsive = vi.fn();
    const onResponsive = vi.fn();
    const { container, unmount } = render(
      <WebviewHost
        url='https://example.com'
        onRenderProcessGone={onRenderProcessGone}
        onUnresponsive={onUnresponsive}
        onResponsive={onResponsive}
      />
    );
    const webview = getWebview(container);

    unmount();
    fire(webview, Object.assign(new Event('render-process-gone'), { details: { reason: 'crashed' } }));
    fire(webview, new Event('unresponsive'));
    fire(webview, new Event('responsive'));

    expect(onRenderProcessGone).not.toHaveBeenCalled();
    expect(onUnresponsive).not.toHaveBeenCalled();
    expect(onResponsive).not.toHaveBeenCalled();
  });
});

const NAVIGATE_MARKER = '__WEBVIEW_HOST_NAVIGATE__';
const FORGED_URL = 'file:///etc/passwd';
const consoleMessage = (message: string): Event => Object.assign(new Event('console-message'), { message });
const forgedNavigateMessage = (url: string): string =>
  `${NAVIGATE_MARKER} ${JSON.stringify({ type: NAVIGATE_MARKER, url })}`;
const webviewSrcProperty = (webview: HTMLElement): unknown => Reflect.get(webview, 'src');

describe('WebviewHost __WEBVIEW_HOST_NAVIGATE__ marker', () => {
  it('interceptNavigation=false: a page-forged navigate marker is swallowed and does not navigate', () => {
    const onUrlChange = vi.fn();
    const { container } = render(
      <WebviewHost url='https://example.com' interceptNavigation={false} onUrlChange={onUrlChange} />
    );
    const webview = getWebview(container);

    fire(webview, consoleMessage(forgedNavigateMessage(FORGED_URL)));

    expect(webviewSrcProperty(webview)).toBeUndefined();
    expect(webview.getAttribute('src')).toBe('https://example.com');
    expect(onUrlChange).not.toHaveBeenCalledWith(FORGED_URL);
  });

  it('default mode: the navigate marker posted by the interceptor still navigates the webview', () => {
    const onUrlChange = vi.fn();
    const { container } = render(<WebviewHost url='https://example.com' onUrlChange={onUrlChange} />);
    const webview = getWebview(container);

    fire(webview, consoleMessage(forgedNavigateMessage('https://example.org/next')));

    // The src attribute is what loads a <webview>.
    expect(webview.getAttribute('src')).toBe('https://example.org/next');
    expect(onUrlChange).toHaveBeenCalledWith('https://example.org/next');
  });
});

const inPageNavigation = (url: string, isMainFrame: boolean): Event =>
  Object.assign(new Event('did-navigate-in-page'), { url, isMainFrame });

describe('WebviewHost in-page navigations', () => {
  const IFRAME_URL = 'https://studio.workspace.google.com/u/0/sidepanel#state=1';

  it('ignores an iframe hash change instead of loading the iframe page into the tab', () => {
    const onUrlChange = vi.fn();
    const { container } = render(
      <WebviewHost
        url='https://drive.google.com/drive/my-drive'
        interceptNavigation={false}
        onUrlChange={onUrlChange}
      />
    );
    const webview = getWebview(container);

    fire(webview, inPageNavigation(IFRAME_URL, false));

    expect(webview.getAttribute('src')).toBe('https://drive.google.com/drive/my-drive');
    expect(onUrlChange).not.toHaveBeenCalledWith(IFRAME_URL);
  });

  it('still follows a main-frame hash change', () => {
    const onUrlChange = vi.fn();
    const { container } = render(
      <WebviewHost url='https://mail.google.com/mail/u/0/' interceptNavigation={false} onUrlChange={onUrlChange} />
    );
    const webview = getWebview(container);

    fire(webview, inPageNavigation('https://mail.google.com/mail/u/0/#inbox', true));

    expect(onUrlChange).toHaveBeenCalledWith('https://mail.google.com/mail/u/0/#inbox');
  });
});

describe('WebviewHost StarOffice zoom with interceptNavigation=false', () => {
  // isStarOfficeUrl: localhost / 127.0.0.1 on port 18791, 18888 or 19000.
  const STAROFFICE_URL = 'http://127.0.0.1:18791/';

  it('still injects the zoom script on dom-ready', () => {
    const { container } = render(<WebviewHost url={STAROFFICE_URL} interceptNavigation={false} />);

    fire(getWebview(container), new Event('dom-ready'));

    expect(injectedScripts().some((script) => script.includes('__aionuiZoomInjected'))).toBe(true);
  });

  it('still applies zoom markers posted by the injected script', () => {
    const { container, getByText } = render(
      <WebviewHost url={STAROFFICE_URL} showNavBar interceptNavigation={false} />
    );

    fire(getWebview(container), consoleMessage('__AIONUI_WEBVIEW_ZOOM__ {"deltaY":-100}'));

    expect(getByText('108%')).not.toBeNull();
  });
});

// Setting a <webview>'s src reloads the page even when it already shows that URL, so the page's own URL changes
// (SPA navigation, pushState: YouTube moving to the next playlist video) must never be written back into src.
describe('WebviewHost src follows explicit navigations only', () => {
  const navigateEvent = (type: string, url: string): Event =>
    Object.assign(new Event(type), { url, isMainFrame: true });

  it.each(['did-navigate-in-page', 'did-navigate'])('%s updates the address but leaves src alone', (type) => {
    const onUrlChange = vi.fn();
    const { container } = render(
      <WebviewHost
        url='https://www.youtube.com/watch?v=a&index=1'
        interceptNavigation={false}
        onUrlChange={onUrlChange}
      />
    );
    const webview = getWebview(container);

    fire(webview, navigateEvent(type, 'https://www.youtube.com/watch?v=b&index=2'));

    expect(webview.getAttribute('src')).toBe('https://www.youtube.com/watch?v=a&index=1');
    expect(onUrlChange).toHaveBeenLastCalledWith('https://www.youtube.com/watch?v=b&index=2');
  });

  it('a new url prop still loads it', () => {
    const { container, rerender } = render(<WebviewHost url='https://example.com/a' interceptNavigation={false} />);

    rerender(<WebviewHost url='https://example.com/b' interceptNavigation={false} />);

    expect(getWebview(container).getAttribute('src')).toBe('https://example.com/b');
  });
});

// `<webview>` exists only in Electron. The WebUI (a plain phone browser) gets a notice and a way back to the chat.
describe('WebviewHost outside Electron', () => {
  let electronApiStub: unknown;
  beforeEach(() => {
    const w = window as Window & { electronAPI?: unknown };
    electronApiStub = w.electronAPI;
    delete w.electronAPI;
  });
  afterEach(() => {
    (window as Window & { electronAPI?: unknown }).electronAPI = electronApiStub;
    optionalPreview.value = null;
  });

  it('shows the desktop-only notice instead of a webview', () => {
    const { container } = render(<WebviewHost url='https://example.com' showNavBar />);

    expect(container.querySelector('webview')).toBeNull();
    expect(screen.getByText('preview.browser.desktopOnly')).toBeInTheDocument();
  });

  it('Back to chat closes the preview', () => {
    const closePreview = vi.fn();
    optionalPreview.value = { closePreview };
    render(<WebviewHost url='https://example.com' />);

    fireEvent.click(screen.getByRole('button', { name: 'common.back' }));

    expect(closePreview).toHaveBeenCalledTimes(1);
  });

  it('has no Back to chat button outside a preview', () => {
    render(<WebviewHost url='https://example.com' />);

    expect(screen.queryByRole('button', { name: 'common.back' })).toBeNull();
  });
});

describe('WebviewHost in Electron', () => {
  it('renders the webview and no desktop-only notice', () => {
    const { container } = render(<WebviewHost url='https://example.com' />);

    expect(container.querySelector('webview')).not.toBeNull();
    expect(screen.queryByText('preview.browser.desktopOnly')).toBeNull();
  });
});
