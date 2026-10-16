import { describe, expect, it } from 'vitest';
import type { TabOwnership } from '@/common/types/browser';
import { isAgentNavigableUrl } from '@process/services/agentBrowser/relay/agentUrl';
import { decideRelayCommand, type PolicyContext } from '@process/services/agentBrowser/relay/relayPolicy';

const agent = { clientId: 'c1', label: 'claude' };
const ownTab: TabOwnership = { webContentsId: 7, owner: agent, sharedWith: null, paused: false };
const userTab: TabOwnership = { webContentsId: 8, owner: 'user', sharedWith: null, paused: false };
const RELAY_PORT = 4100;
const BACKEND_PORT = 4200;

const ctx = (over: Partial<PolicyContext>): PolicyContext => ({
  client: agent,
  method: 'Page.getFrameTree',
  params: {},
  tab: ownTab,
  ownContexts: new Set<number>([3]),
  blockedPorts: new Set([RELAY_PORT, BACKEND_PORT]),
  ...over,
});
const decide = (method: string, params: Record<string, unknown> = {}, over: Partial<PolicyContext> = {}) =>
  decideRelayCommand(ctx({ method, params, ...over }));

describe('decideRelayCommand: methods', () => {
  it.each([
    'Network.getAllCookies',
    'Network.getCookies',
    'Storage.getCookies',
    'Browser.close',
    'SystemInfo.getInfo',
    'Page.addScriptToEvaluateOnNewDocument',
    'Runtime.addBinding',
    'Fetch.enable',
    'Fetch.continueRequest',
    'Network.setRequestInterception',
    'Target.exposeDevToolsProtocol',
    'DOM.setFileInputFiles', // ruling P2-G
    'Page.setInterceptFileChooserDialog', // ruling P2-G
    'Input.setIgnoreInputEvents',
    'Input.synthesizeScrollGesture',
    'Network.enable',
    'toString',
  ])('denies %s', (method) => {
    expect(decide(method)).toMatchObject({ allow: false, message: expect.stringContaining('not allowed') });
  });

  it.each([
    ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 2, button: 'left', clickCount: 1 }],
    ['Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', text: 'a' }],
    ['Input.insertText', { text: 'hi' }],
    ['Input.imeSetComposition', { text: 'k', selectionStart: 0, selectionEnd: 1 }],
    ['Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: 1, y: 1 }] }],
    ['Input.setInterceptDrags', { enabled: true }],
    ['Input.dispatchDragEvent', { type: 'drop', x: 1, y: 1, data: { items: [], dragOperationsMask: 1 } }],
    ['Page.getFrameTree', {}],
    ['Page.createIsolatedWorld', { frameId: 'F', worldName: 'aion' }],
    ['Page.reload', { ignoreCache: true }],
    ['DOM.getBoxModel', { backendNodeId: 4 }],
  ])('allows %s on an own tab', (method, params) => {
    expect(decide(method, params)).toEqual({ allow: true });
  });

  it('denies a dragged file', () => {
    const data = { items: [], files: ['/etc/passwd'], dragOperationsMask: 1 };
    expect(decide('Input.dispatchDragEvent', { type: 'drop', x: 1, y: 1, data }).allow).toBe(false);
  });
});

describe('decideRelayCommand: params', () => {
  it('denies unknown params', () => {
    expect(decide('Page.reload', { scriptToEvaluateOnLoad: 'steal()' })).toMatchObject({
      allow: false,
      message: expect.stringContaining('scriptToEvaluateOnLoad'),
    });
    expect(decide('Page.createIsolatedWorld', { frameId: 'F', worldName: 'w', grantUniveralAccess: true }).allow).toBe(
      false
    );
    expect(decide('Page.getFrameTree', { anything: 1 }).allow).toBe(false);
  });

  it('denies Runtime.evaluate without an own isolated-world contextId', () => {
    expect(decide('Runtime.evaluate', { expression: '1' }).allow).toBe(false);
    expect(decide('Runtime.evaluate', { expression: '1', contextId: 4 }).allow).toBe(false);
    expect(decide('Runtime.evaluate', { expression: '1', contextId: 3, uniqueContextId: 'x' }).allow).toBe(false);
    expect(decide('Runtime.evaluate', { expression: '1', contextId: 3 })).toEqual({ allow: true });
  });

  it('denies Runtime.evaluate with includeCommandLineAPI or allowUnsafeEvalBlockedByCSP', () => {
    expect(decide('Runtime.evaluate', { expression: '1', contextId: 3, includeCommandLineAPI: true }).allow).toBe(
      false
    );
    expect(decide('Runtime.evaluate', { expression: '1', contextId: 3, allowUnsafeEvalBlockedByCSP: true }).allow).toBe(
      false
    );
    expect(decide('Runtime.evaluate', { expression: '1', contextId: 3, includeCommandLineAPI: false }).allow).toBe(
      true
    );
  });

  it('allows Runtime.callFunctionOn only in an own context and never by objectId', () => {
    expect(decide('Runtime.callFunctionOn', { functionDeclaration: 'f', executionContextId: 3 })).toEqual({
      allow: true,
    });
    expect(decide('Runtime.callFunctionOn', { functionDeclaration: 'f', executionContextId: 9 }).allow).toBe(false);
    expect(
      decide('Runtime.callFunctionOn', { functionDeclaration: 'f', objectId: 'o', executionContextId: 3 }).allow
    ).toBe(false);
  });

  it('denies Page.navigate to non-web, link-local, metadata and app-internal addresses', () => {
    const nav = (url: unknown) => decide('Page.navigate', { url }).allow;
    expect(nav('javascript:alert(1)')).toBe(false);
    expect(nav('file:///etc/passwd')).toBe(false);
    expect(nav(42)).toBe(false);
    expect(nav('http://169.254.169.254/latest/meta-data/')).toBe(false);
    expect(nav(`http://127.0.0.1:${BACKEND_PORT}/api`)).toBe(false);
    expect(nav('https://example.com')).toBe(true);
  });
});

describe('isAgentNavigableUrl', () => {
  const blocked = new Set([RELAY_PORT, BACKEND_PORT]);
  it.each([
    'http://169.254.169.254/',
    'http://2852039166/', // 169.254.169.254 as a number
    'http://[fd00:ec2::254]/',
    'http://[fe80::1]/',
    'http://[::ffff:169.254.169.254]/',
    `http://127.0.0.1:${RELAY_PORT}/`,
    `http://localhost:${BACKEND_PORT}/`,
    `http://[::1]:${BACKEND_PORT}/`,
    `http://0.0.0.0:${BACKEND_PORT}/`,
    `http://app.localhost:${RELAY_PORT}/`,
    'chrome://settings',
    'data:text/html,hi',
    // A trailing dot names the same host.
    `http://localhost.:${BACKEND_PORT}/`,
    `http://x.localhost.:${RELAY_PORT}/`,
    `http://127.0.0.1.:${BACKEND_PORT}/`,
    'http://169.254.169.254./',
  ])('denies %s', (url) => {
    expect(isAgentNavigableUrl(url, blocked)).toBe(false);
  });

  it.each([
    'https://example.com/',
    'about:blank',
    'http://localhost:3000/', // the user's local dev site
    'http://127.0.0.1:5173/',
    'http://192.168.1.20:8080/', // LAN
    `http://example.com:${BACKEND_PORT}/`, // the port only matters on loopback
  ])('allows %s', (url) => {
    expect(isAgentNavigableUrl(url, blocked)).toBe(true);
  });
});

describe('decideRelayCommand: ownership and pause', () => {
  it('denies commands on a user tab that is not shared; allows after share(on)', () => {
    expect(decide('Page.getFrameTree', {}, { tab: userTab })).toMatchObject({
      allow: false,
      message: expect.stringContaining('not shared'),
    });
    expect(decide('Page.getFrameTree', {}, { tab: { ...userTab, sharedWith: 'all' } })).toEqual({ allow: true });
  });

  it("denies another agent's tab unless shared", () => {
    const other: TabOwnership = { ...ownTab, owner: { clientId: 'c2', label: 'codex' } };
    expect(decide('Page.getFrameTree', {}, { tab: other }).allow).toBe(false);
    expect(decide('Page.getFrameTree', {}, { tab: { ...other, sharedWith: 'all' } }).allow).toBe(true);
  });

  it('denies everything when the tab is gone', () => {
    expect(decide('Page.getFrameTree', {}, { tab: null }).allow).toBe(false);
  });

  it('denies input, script, navigation and dialog answers on a paused tab with "user took over"', () => {
    const tab = { ...ownTab, paused: true };
    for (const [method, params] of [
      ['Input.insertText', { text: 'x' }],
      ['Input.dispatchMouseEvent', { type: 'mousePressed', x: 1, y: 1 }],
      ['Runtime.evaluate', { expression: '1', contextId: 3 }],
      ['Page.navigate', { url: 'https://example.com' }],
      ['Page.reload', {}],
      ['Page.navigateToHistoryEntry', { entryId: 1 }],
      ['Page.stopLoading', {}],
      ['Page.handleJavaScriptDialog', { accept: true }],
    ] as const) {
      expect(decide(method, params, { tab })).toMatchObject({
        allow: false,
        message: expect.stringContaining('user took over'),
      });
    }
    // Reading the page stays allowed while paused.
    expect(decide('Page.getFrameTree', {}, { tab }).allow).toBe(true);
    expect(decide('Page.captureScreenshot', { format: 'png' }, { tab }).allow).toBe(true);
  });
});
