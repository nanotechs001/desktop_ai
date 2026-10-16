import { describe, expect, it } from 'vitest';
import type { TabOwnership } from '@/common/types/browser';
import { decideRelayCommand, type PolicyContext } from '@process/services/agentBrowser/relay/relayPolicy';

const agent = { clientId: 'c1', label: 'claude' };
const ownTab: TabOwnership = { webContentsId: 7, owner: agent, sharedWith: null, paused: false };
const userTab: TabOwnership = { webContentsId: 8, owner: 'user', sharedWith: null, paused: false };

const ctx = (over: Partial<PolicyContext>): PolicyContext => ({
  client: agent,
  method: 'Page.getFrameTree',
  params: {},
  tab: ownTab,
  ownContexts: new Set<number>(),
  ...over,
});

describe('decideRelayCommand', () => {
  it.each(['Network.getAllCookies', 'Network.getCookies', 'Storage.getCookies', 'Browser.close', 'SystemInfo.getInfo'])(
    'denies %s',
    (method) => {
      expect(decideRelayCommand(ctx({ method }))).toMatchObject({
        allow: false,
        message: expect.stringContaining('not allowed'),
      });
    }
  );

  it('denies methods outside the allowlist', () => {
    expect(decideRelayCommand(ctx({ method: 'Page.addScriptToEvaluateOnNewDocument' })).allow).toBe(false);
    expect(decideRelayCommand(ctx({ method: 'Network.enable' })).allow).toBe(false);
  });

  it('allows allowlisted methods on an own tab', () => {
    for (const method of [
      'Page.getFrameTree',
      'Page.createIsolatedWorld',
      'DOM.getBoxModel',
      'Input.dispatchMouseEvent',
    ]) {
      expect(decideRelayCommand(ctx({ method }))).toEqual({ allow: true });
    }
  });

  it('denies commands on a user tab that is not shared; allows after share(on)', () => {
    expect(decideRelayCommand(ctx({ tab: userTab }))).toMatchObject({
      allow: false,
      message: expect.stringContaining('not shared'),
    });
    expect(decideRelayCommand(ctx({ tab: { ...userTab, sharedWith: 'all' } }))).toEqual({ allow: true });
  });

  it("denies another agent's tab unless shared", () => {
    const other: TabOwnership = { ...ownTab, owner: { clientId: 'c2', label: 'codex' } };
    expect(decideRelayCommand(ctx({ tab: other })).allow).toBe(false);
    expect(decideRelayCommand(ctx({ tab: { ...other, sharedWith: 'all' } })).allow).toBe(true);
  });

  it('denies everything when the tab is gone', () => {
    expect(decideRelayCommand(ctx({ tab: null })).allow).toBe(false);
  });

  it('denies Input.* on a paused tab with "user took over"', () => {
    const paused = { ...ownTab, paused: true };
    expect(decideRelayCommand(ctx({ tab: paused, method: 'Input.insertText' }))).toMatchObject({
      allow: false,
      message: expect.stringContaining('user took over'),
    });
    // Reading the page stays allowed while paused.
    expect(decideRelayCommand(ctx({ tab: paused, method: 'Page.getFrameTree' })).allow).toBe(true);
  });

  it('denies Runtime.evaluate without an own isolated-world contextId', () => {
    const evaluate = (params: Record<string, unknown>, own: number[] = [3]) =>
      decideRelayCommand(ctx({ method: 'Runtime.evaluate', params, ownContexts: new Set(own) }));
    expect(evaluate({ expression: '1' }).allow).toBe(false);
    expect(evaluate({ expression: '1', contextId: 4 }).allow).toBe(false);
    expect(evaluate({ expression: '1', contextId: 3, uniqueContextId: 'x' }).allow).toBe(false);
    expect(evaluate({ expression: '1', contextId: 3 })).toEqual({ allow: true });
  });

  it('allows Runtime.callFunctionOn only in an own context and never by objectId', () => {
    const call = (params: Record<string, unknown>) =>
      decideRelayCommand(ctx({ method: 'Runtime.callFunctionOn', params, ownContexts: new Set([3]) }));
    expect(call({ functionDeclaration: 'f', executionContextId: 3 })).toEqual({ allow: true });
    expect(call({ functionDeclaration: 'f', executionContextId: 9 }).allow).toBe(false);
    expect(call({ functionDeclaration: 'f', objectId: 'o', executionContextId: 3 }).allow).toBe(false);
  });

  it('denies Page.navigate to non-web urls', () => {
    const nav = (url: unknown) => decideRelayCommand(ctx({ method: 'Page.navigate', params: { url } }));
    expect(nav('javascript:alert(1)').allow).toBe(false);
    expect(nav('file:///etc/passwd').allow).toBe(false);
    expect(nav(42).allow).toBe(false);
    expect(nav('https://example.com')).toEqual({ allow: true });
  });
});
